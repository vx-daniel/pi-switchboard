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
import { MAX_PROJECT_LENGTH } from '@proxy/config/projects'
import { proxyLogger } from '@proxy/logging'
import { type FinishedRequest, onActiveRequestsChange } from '@proxy/server/active-requests'
import { recordConsoleEvent } from '@proxy/server/console-events'
import { onRouteTotalsChange, type RouteEvent, type RouteUsage } from '@proxy/server/route-totals'
import { OTHER_PROJECT, type ProjectMinute } from '@proxy/stats/project-store'
import { openStatsStore } from '@proxy/stats/store'
import type {
  AttemptMinute,
  FailureMinute,
  RequestMinute,
  StatsBatch,
  StatsStore
} from '@proxy/stats/store'
import { STATS_KEPT_DAYS } from '@proxy/stats/windows'
import { errorMessage } from '@proxy/utils/guards'
import { MS_PER_MINUTE } from '@proxy/utils/time'

/** Logger for the stats. */
const statsLogger = proxyLogger('stats')

/** The stats file's name, in pi's agent dir. */
const STATS_FILE = 'pi-switchboard-stats.sqlite'
/** Minutes in a day, for the retention. */
const MINUTES_PER_DAY = 1440
/** How often the counts are written. */
const DEFAULT_FLUSH_MS = 5000
/** How many days of rows are kept: the windows' `all` covers the same days. */
const DEFAULT_RETENTION_DAYS = STATS_KEPT_DAYS
/** How many flushes between prunes: about an hour at the default flush interval. */
const FLUSHES_PER_PRUNE = 720
/** The longest rejected model name kept; a canonical `provider/model-id` is far shorter. */
const MAX_REJECTED_MODEL_LENGTH = 128
/** Distinct rejected model names kept per minute, before the rest are {@link OTHER_REJECTED_MODEL}. */
const MAX_REJECTED_MODELS_PER_MINUTE = 20
/** What rejected requests past {@link MAX_REJECTED_MODELS_PER_MINUTE} names are filed under. */
const OTHER_REJECTED_MODEL = '(other)'
/**
 * Distinct projects kept per minute, before the rest are {@link OTHER_PROJECT}: a project is the
 * client's label (#366), so it is bounded as a rejected model name is.
 */
const MAX_PROJECTS_PER_MINUTE = 50

/** How the recorder runs; the defaults are the production ones. */
export interface RecorderOptions {
  /** How often to write, in milliseconds. */
  readonly flushMs?: number
  /** How many days of rows to keep. */
  readonly retentionDays?: number
  /** The clock, for the minute a route event falls in and the prune cutoff. */
  readonly now?: () => number
}

/** A row while it is counted: the same fields, writable. */
type Mutable<Row> = { -readonly [Field in keyof Row]: Row[Field] }

/** A recorder's mutable counts, each keyed by its row's primary key as JSON. */
interface Pending {
  readonly requests: Map<string, Mutable<RequestMinute>>
  readonly attempts: Map<string, Mutable<AttemptMinute>>
  readonly failures: Map<string, Mutable<FailureMinute>>
  readonly projects: Map<string, Mutable<ProjectMinute>>
}

/**
 * Starts nothing yet: empty counts.
 *
 * @returns the counts
 */
function emptyPending(): Pending {
  return { requests: new Map(), attempts: new Map(), failures: new Map(), projects: new Map() }
}

/**
 * Returns a project's row for a minute, creating an empty one the first time.
 *
 * @param pending - the counts
 * @param minute - the minute
 * @param project - the project, as {@link boundedNames} files it
 * @returns the row
 */
function projectRow(pending: Pending, minute: number, project: string): Mutable<ProjectMinute> {
  const id = JSON.stringify([minute, project])
  const row = pending.projects.get(id) ?? {
    minute,
    project,
    requests: 0,
    failed: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0
  }
  pending.projects.set(id, row)
  return row
}

/**
 * Adds a finished request to its minute's row.
 *
 * @param pending - the counts
 * @param request - the request
 * @param model - the model to file it under: the served one, or for a rejected request the name it
 *   gave, as {@link boundedNames} bounds it
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
    firstEventCount: 0,
    promptCacheKeyRequests: 0
  }
  const duration = Math.max(0, request.endedAt - request.startedAt)
  row.requests += 1
  row.durationMsTotal += duration
  row.durationMsMax = Math.max(row.durationMsMax, duration)
  if (request.firstEventAt !== undefined) {
    row.firstEventMsTotal += Math.max(0, request.firstEventAt - request.startedAt)
    row.firstEventCount += 1
  }
  if (request.promptCacheKey) row.promptCacheKeyRequests += 1
  pending.requests.set(id, row)
}

/** How {@link boundedNames} bounds a name a client chose. */
interface NameBounds {
  /** The longest name kept; a longer one is cut. */
  readonly maxLength: number
  /** Distinct names kept per minute. */
  readonly perMinute: number
  /** What names past {@link NameBounds.perMinute} are filed under. */
  readonly other: string
}

/**
 * Bounds what a name the client chose puts on disk: a rejected request's model name, or a
 * request's project (#366), each of which a client can send any of. A name is cut to its longest,
 * and past the distinct names a minute keeps the rest are filed under one, so a client can't add
 * rows without limit.
 *
 * @param bounds - the longest name, the distinct names a minute, and the name for the rest
 * @returns a function from a minute and a name to the name to store
 */
function boundedNames(bounds: NameBounds): (minute: number, name: string) => string {
  let current = { minute: Number.NaN, names: new Set<string>() }
  return (minute, sent) => {
    if (minute !== current.minute) current = { minute, names: new Set() }
    const name = sent.slice(0, bounds.maxLength)
    if (current.names.has(name)) return name
    if (current.names.size >= bounds.perMinute) return bounds.other
    current.names.add(name)
    return name
  }
}

/** The counts a route row and a project row both add an upstream call's usage to. */
type Spend = Mutable<
  Pick<
    AttemptMinute,
    'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'costUsd'
  >
>

/**
 * Adds one upstream call's tokens and cost to a row.
 *
 * @param row - the row: a route's or a project's
 * @param usage - the call's usage, as the route event carries it
 */
function addSpend(row: Spend, usage: RouteUsage): void {
  row.inputTokens += usage.inputTokens
  row.outputTokens += usage.outputTokens
  row.cacheReadTokens += usage.cacheReadTokens
  row.cacheWriteTokens += usage.cacheWriteTokens
  row.costUsd += usage.costUsd
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
  else if (event.kind === 'usage') addSpend(row, event.usage)
  else {
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
  const sizes = [pending.requests, pending.attempts, pending.failures, pending.projects]
  if (sizes.every((rows) => rows.size === 0)) return undefined
  return {
    requests: [...pending.requests.values()],
    attempts: [...pending.attempts.values()],
    failures: [...pending.failures.values()],
    projects: [...pending.projects.values()]
  }
}

/**
 * Adds a finished request to its project's row, if it named one and reached a model.
 *
 * @param pending - the counts
 * @param request - the request
 * @param nameProject - files the project under its bounded name
 */
function addProjectRequest(
  pending: Pending,
  request: FinishedRequest,
  nameProject: (minute: number, project: string) => string
): void {
  if (request.project === null || request.outcome === 'rejected') return
  const minute = Math.floor(request.endedAt / MS_PER_MINUTE)
  const row = projectRow(pending, minute, nameProject(minute, request.project))
  row.requests += 1
  if (request.outcome === 'failed') row.failed += 1
}

/**
 * Adds an upstream call's tokens and cost to its project's row, if the request named one.
 *
 * @param pending - the counts
 * @param event - the route event
 * @param now - when it happened
 * @param nameProject - files the project under its bounded name
 */
function addProjectUsage(
  pending: Pending,
  event: RouteEvent,
  now: number,
  nameProject: (minute: number, project: string) => string
): void {
  if (event.kind !== 'usage' || event.key.project === null) return
  const minute = Math.floor(now / MS_PER_MINUTE)
  addSpend(projectRow(pending, minute, nameProject(minute, event.key.project)), event.usage)
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
      statsLogger.warn('Could not prune old stats: {reason}', { reason: errorMessage(error) })
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
        reason: errorMessage(error)
      })
    }
  }
  prune()
  const nameProject = boundedNames({
    maxLength: MAX_PROJECT_LENGTH,
    perMinute: MAX_PROJECTS_PER_MINUTE,
    other: OTHER_PROJECT
  })
  const stopTotals = onRouteTotalsChange((event) => {
    const at = now()
    addRouteEvent(pending, event, at)
    addProjectUsage(pending, event, at, nameProject)
  })
  const nameRejected = boundedNames({
    maxLength: MAX_REJECTED_MODEL_LENGTH,
    perMinute: MAX_REJECTED_MODELS_PER_MINUTE,
    other: OTHER_REJECTED_MODEL
  })
  const stopRequests = onActiveRequestsChange((finishedRequest) => {
    if (finishedRequest === undefined) return
    const model =
      finishedRequest.outcome === 'rejected'
        ? nameRejected(Math.floor(finishedRequest.endedAt / MS_PER_MINUTE), finishedRequest.model)
        : finishedRequest.model
    addFinished(pending, finishedRequest, model)
    addProjectRequest(pending, finishedRequest, nameProject)
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
 * Names the stats file: `pi-switchboard-stats.sqlite` in pi's agent dir.
 *
 * @returns its path
 */
export function statsFilePath(): string {
  return join(piAgentDir(), STATS_FILE)
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
  const path = statsFilePath()
  let store: StatsStore
  try {
    store = openStatsStore(path)
  } catch (error) {
    statsLogger.warn('Stats are off: could not open {path}: {reason}', {
      path,
      reason: errorMessage(error)
    })
    recordConsoleEvent(`Stats are off: could not open ${path}`, 'warning')
    return undefined
  }
  const stopRecorder = startStatsRecorder(store)
  const stop = (): void => {
    process.off('exit', stop)
    stopRecorder()
  }
  process.once('exit', stop)
  statsLogger.info('Recording stats to {path}', { path })
  recordConsoleEvent(`Recording stats to ${path}`)
  return stop
}
