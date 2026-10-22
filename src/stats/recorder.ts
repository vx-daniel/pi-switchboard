/**
 * The stats recorder (#216): turns the route totals' events and each finished request into
 * per-minute rows, and writes them to the stats store every few seconds.
 *
 * @remarks
 * Events are added up in memory, keyed by minute and route, so a busy minute is one row per route,
 * not one per request; a flush writes them in one transaction and starts over. A write that fails
 * (the disk full, the file locked past the store's busy timeout) is logged and its rows dropped:
 * the stats must never hold up or fail a request, and a backlog that cannot be written would only
 * grow. Rows older than the retention are pruned on start and about every hour.
 *
 * @packageDocumentation
 */

import { join } from 'node:path'

import { piAgentDir } from '@proxy/config/agent-dir'
import { proxyLogger } from '@proxy/logging'
import { type FinishedRequest, onActiveRequestsChange } from '@proxy/server/active-requests'
import { onRouteTotalsChange, type RouteEvent } from '@proxy/server/route-totals'
import { openStatsStore } from '@proxy/stats/store'
import type {
  AttemptMinute,
  FailureMinute,
  RequestMinute,
  StatsBatch,
  StatsStore
} from '@proxy/stats/store'

/** Logger for the stats. */
const statsLogger = proxyLogger('stats')

/** Milliseconds in a minute: rows are kept per minute. */
const MS_PER_MINUTE = 60_000
/** The stats file's name, in pi's agent dir. */
const STATS_FILE = 'pi-switchboard-stats.sqlite'
/** Minutes in a day, for the retention. */
const MINUTES_PER_DAY = 1440
/** How often the counts are written. */
const DEFAULT_FLUSH_MS = 5000
/** How many days of rows are kept. */
const DEFAULT_RETENTION_DAYS = 30
/** How many flushes between prunes: about an hour at the default flush interval. */
const FLUSHES_PER_PRUNE = 720
/** The longest rejected model name kept; a canonical `provider/model-id` is far shorter. */
const MAX_REJECTED_MODEL_LENGTH = 128
/** Distinct rejected model names kept per minute, before the rest are {@link OTHER_REJECTED_MODEL}. */
const MAX_REJECTED_MODELS_PER_MINUTE = 20
/** What rejected requests past {@link MAX_REJECTED_MODELS_PER_MINUTE} names are filed under. */
const OTHER_REJECTED_MODEL = '(other)'

/** How the recorder runs; the defaults are the production ones. */
export interface RecorderOptions {
  /** How often to write, in milliseconds. */
  readonly flushMs?: number
  /** How many days of rows to keep. */
  readonly retentionDays?: number
  /** The clock, for the minute an event falls in. */
  readonly now?: () => number
}

/** A recorder's mutable counts, keyed by minute and route as JSON. */
interface Pending {
  readonly requests: Map<string, { -readonly [Field in keyof RequestMinute]: RequestMinute[Field] }>
  readonly attempts: Map<string, { -readonly [Field in keyof AttemptMinute]: AttemptMinute[Field] }>
  readonly failures: Map<string, { -readonly [Field in keyof FailureMinute]: FailureMinute[Field] }>
}

/**
 * Starts nothing yet: empty counts.
 *
 * @returns the counts
 */
function emptyPending(): Pending {
  return { requests: new Map(), attempts: new Map(), failures: new Map() }
}

/**
 * Adds a finished request to its minute's row.
 *
 * @param pending - the counts
 * @param request - the request
 * @param model - the model to file it under: the served one, or for a rejected request the name it
 *   gave, as {@link rejectedModelNames} bounds it
 */
function addFinished(pending: Pending, request: FinishedRequest, model: string): void {
  const minute = Math.floor(request.endedAt / MS_PER_MINUTE)
  const alias = request.alias ?? ''
  const status = request.status ?? 0
  const id = JSON.stringify([minute, alias, model, request.outcome, status])
  const row = pending.requests.get(id) ?? {
    minute,
    alias,
    model,
    outcome: request.outcome,
    status,
    requests: 0,
    durationMsTotal: 0,
    durationMsMax: 0,
    firstEventMsTotal: 0,
    firstEventCount: 0
  }
  const duration = Math.max(0, request.endedAt - request.startedAt)
  row.requests += 1
  row.durationMsTotal += duration
  row.durationMsMax = Math.max(row.durationMsMax, duration)
  if (request.firstEventAt !== undefined) {
    row.firstEventMsTotal += Math.max(0, request.firstEventAt - request.startedAt)
    row.firstEventCount += 1
  }
  pending.requests.set(id, row)
}

/**
 * Bounds what a rejected request's model name puts on disk: the name comes from the client, which
 * can send any string of any length. A name is cut to {@link MAX_REJECTED_MODEL_LENGTH}, and past
 * {@link MAX_REJECTED_MODELS_PER_MINUTE} distinct names in a minute the rest are filed as
 * {@link OTHER_REJECTED_MODEL}, so a client can't add rows without limit.
 *
 * @returns a function from a rejected request's minute and model name to the name to store
 */
function rejectedModelNames(): (minute: number, model: string) => string {
  let current = { minute: Number.NaN, names: new Set<string>() }
  return (minute, model) => {
    if (minute !== current.minute) current = { minute, names: new Set() }
    const name = model.slice(0, MAX_REJECTED_MODEL_LENGTH)
    if (current.names.has(name)) return name
    if (current.names.size >= MAX_REJECTED_MODELS_PER_MINUTE) return OTHER_REJECTED_MODEL
    current.names.add(name)
    return name
  }
}

/**
 * Adds a route event to its minute's rows.
 *
 * @param pending - the counts
 * @param event - the event
 * @param now - when it happened
 */
function addRouteEvent(pending: Pending, event: RouteEvent, now: number): void {
  if (event.kind === 'cleared') return
  const minute = Math.floor(now / MS_PER_MINUTE)
  const alias = event.key.alias ?? ''
  const id = JSON.stringify([minute, alias, event.key.model])
  const row = pending.attempts.get(id) ?? {
    minute,
    alias,
    provider: event.key.provider,
    model: event.key.model,
    attempts: 0,
    failures: 0,
    fallbacks: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0
  }
  pending.attempts.set(id, row)
  if (event.kind === 'attempt') row.attempts += 1
  else if (event.kind === 'fallback') row.fallbacks += 1
  else if (event.kind === 'usage') {
    row.inputTokens += event.usage.inputTokens
    row.outputTokens += event.usage.outputTokens
    row.cacheReadTokens += event.usage.cacheReadTokens
    row.cacheWriteTokens += event.usage.cacheWriteTokens
    row.costUsd += event.usage.costUsd
  } else {
    row.failures += 1
    // A failure with no class (a 400) is counted on the route but has no class row.
    if (event.failure !== undefined) addFailure(pending, minute, event.key.model, event.failure)
  }
}

/**
 * Adds a failed attempt to its minute's class row.
 *
 * @param pending - the counts
 * @param minute - the minute
 * @param model - the served model
 * @param failureClass - the failure's class
 */
function addFailure(pending: Pending, minute: number, model: string, failureClass: string): void {
  const id = JSON.stringify([minute, model, failureClass])
  const row = pending.failures.get(id) ?? { minute, model, failureClass, failures: 0 }
  row.failures += 1
  pending.failures.set(id, row)
}

/**
 * Turns the counts into a batch for the store.
 *
 * @param pending - the counts
 * @returns the batch, or `undefined` when there is nothing to write
 */
function toBatch(pending: Pending): StatsBatch | undefined {
  if (pending.requests.size + pending.attempts.size + pending.failures.size === 0) return undefined
  return {
    requests: [...pending.requests.values()],
    attempts: [...pending.attempts.values()],
    failures: [...pending.failures.values()]
  }
}

/**
 * Starts recording: subscribes to the route totals and the finished requests, writes every
 * `flushMs`, and prunes old rows now and about every hour.
 *
 * @param store - where to write
 * @param options - the flush interval, retention and clock
 * @returns a function that stops recording, writes what is left, and closes the store; a second
 *   call does nothing. It writes synchronously, so it can run in a process `exit` handler
 */
export function startStatsRecorder(store: StatsStore, options: RecorderOptions = {}): () => void {
  const now = options.now ?? Date.now
  const retentionMinutes = (options.retentionDays ?? DEFAULT_RETENTION_DAYS) * MINUTES_PER_DAY
  let pending = emptyPending()
  let flushes = 0
  /** Deletes the rows past the retention, logging a failure instead of throwing. */
  const prune = (): void => {
    try {
      store.prune(Math.floor(now() / MS_PER_MINUTE) - retentionMinutes)
    } catch (error) {
      statsLogger.warn('Could not prune old stats: {reason}', { reason: errorText(error) })
    }
  }
  /** Writes the counts and starts over, logging a failure and dropping the rows. */
  const flush = (): void => {
    const batch = toBatch(pending)
    pending = emptyPending()
    flushes += 1
    if (flushes % FLUSHES_PER_PRUNE === 0) prune()
    if (batch === undefined) return
    try {
      store.add(batch)
    } catch (error) {
      statsLogger.warn('Could not write stats, dropped a batch: {reason}', {
        reason: errorText(error)
      })
    }
  }
  prune()
  const stopTotals = onRouteTotalsChange((event) => {
    addRouteEvent(pending, event, now())
  })
  const nameRejected = rejectedModelNames()
  const stopRequests = onActiveRequestsChange((finishedRequest) => {
    if (finishedRequest === undefined) return
    const model =
      finishedRequest.outcome === 'rejected'
        ? nameRejected(Math.floor(finishedRequest.endedAt / MS_PER_MINUTE), finishedRequest.model)
        : finishedRequest.model
    addFinished(pending, finishedRequest, model)
  })
  const timer = setInterval(flush, options.flushMs ?? DEFAULT_FLUSH_MS)
  // The timer alone must not keep a process alive that is otherwise done.
  timer.unref()
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    stopTotals()
    stopRequests()
    flush()
    store.close()
  }
}

/**
 * Names what went wrong, by message only: a SQLite error carries no request data.
 *
 * @param error - what was thrown
 * @returns its message
 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Starts recording to the stats file in pi's agent dir, for a server that has started listening.
 *
 * @remarks
 * A file that can't be opened (a read-only directory, a file from a newer proxy) is a warning and
 * no stats, never a failed start. What is left is written when the returned function runs, or
 * when the process exits: the store writes synchronously, so an `exit` handler can.
 *
 * @returns a function that stops recording and writes what is left, or `undefined` when the file
 *   could not be opened
 */
export function recordStatsToFile(): (() => void) | undefined {
  const path = join(piAgentDir(), STATS_FILE)
  let store: StatsStore
  try {
    store = openStatsStore(path)
  } catch (error) {
    statsLogger.warn('Stats are off: could not open {path}: {reason}', {
      path,
      reason: errorText(error)
    })
    return undefined
  }
  const stopRecorder = startStatsRecorder(store)
  const stop = (): void => {
    process.off('exit', stop)
    stopRecorder()
  }
  process.once('exit', stop)
  statsLogger.info('Recording stats to {path}', { path })
  return stop
}
