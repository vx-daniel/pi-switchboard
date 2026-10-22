/**
 * `GET /v1/switchboard/usage` (#224): the stats file's usage over a window, for a proxy run
 * without the console.
 *
 * @remarks
 * Not OpenAI's API, so it lives under `/v1/switchboard/` (constitution, principle I), behind proxy
 * auth like every `/v1` route (principle III). It reads the stats store the recorder writes (#219)
 * through its own connection, opened on the first request: the file is in WAL mode, so reading
 * doesn't wait for the recorder's writes. It answers with routes, counts, timings, tokens and cost
 * only: never message content, the request's `user`, or a credential. A rejected request's model
 * is the client's text, which the recorder already caps.
 *
 * @packageDocumentation
 */

import { proxyLogger } from '@proxy/logging'
import { invalidRequest, type OpenAIError, statsUnavailable } from '@proxy/server/errors'
import { HTTP_BAD_REQUEST, HTTP_OK, HTTP_SERVICE_UNAVAILABLE } from '@proxy/server/http-status'
import { statsFilePath } from '@proxy/stats/recorder'
import {
  type AliasStats,
  type ErrorStats,
  type ModelStats,
  openStatsStore,
  type StatsStore,
  type TimelineBucket,
  type UsageStats
} from '@proxy/stats/store'
import { isStatsWindow, MS_PER_MINUTE, type StatsWindow, windowMinutes } from '@proxy/stats/windows'
import * as z from 'zod'

/** Logger for the usage route. */
const usageLogger = proxyLogger('stats')

/** Minutes per timeline bucket, by window: 24 hours, 28 quarter days, 30 days. */
const BUCKET_MINUTES: Readonly<Record<StatsWindow, number>> = { today: 60, week: 360, all: 1440 }
/**
 * How long one window's answer is reused, in milliseconds: the recorder writes every 5 s, so a
 * fresher read shows nothing new, and a burst of requests costs one read of the file.
 */
const SNAPSHOT_MS = 5000

/** The store's methods the route reads. */
export type UsageStore = Pick<StatsStore, 'timeline' | 'models' | 'aliases' | 'errors' | 'close'>

/** One model's or alias's numbers, as the response shows them. */
const usageFields = {
  requests: z.int().meta({ description: 'Finished requests, rejected ones excluded.' }),
  failed: z.int(),
  left: z.int().meta({ description: 'Requests the client left before the answer.' }),
  average_ms: z.number().nullable().meta({ description: 'Average time per request.' }),
  slowest_ms: z.number(),
  average_first_event_ms: z
    .number()
    .nullable()
    .meta({ description: "Average time to a stream's first event." }),
  attempts: z.int().meta({ description: 'Upstream calls, fallbacks included.' }),
  fallbacks: z.int(),
  input_tokens: z.int(),
  output_tokens: z.int(),
  cache_tokens: z.int().meta({ description: 'Cache reads and writes.' }),
  cost_usd: z.number()
}

/** The body of `GET /v1/switchboard/usage`. */
export const usageSchema = z
  .object({
    object: z.literal('switchboard.usage'),
    window: z.enum(['today', 'week', 'all']),
    from: z.iso.datetime().meta({ description: "The window's first minute." }),
    to: z.iso.datetime().meta({ description: 'The minute after its last.' }),
    bucket_minutes: z.int().meta({ description: 'Minutes per `timeline` bucket.' }),
    models: z.array(z.object({ model: z.string().trim(), ...usageFields })),
    aliases: z.array(
      z.object({
        alias: z
          .string()
          .trim()
          .nullable()
          .meta({ description: 'The alias; `null` for requests that named a model directly.' }),
        ...usageFields
      })
    ),
    failures: z.array(z.object({ class: z.string().trim(), count: z.int() })),
    rejected: z.array(z.object({ status: z.int(), count: z.int() })),
    timeline: z.array(
      z.object({
        start: z.iso.datetime(),
        requests: z.int().meta({ description: 'Finished requests, rejected ones included.' }),
        failed: z.int(),
        rejected: z.int()
      })
    )
  })
  .meta({ id: 'SwitchboardUsage', description: "The stats file's usage over a window." })

/** The body of `GET /v1/switchboard/usage`. */
export type Usage = z.infer<typeof usageSchema>

/**
 * Formats a minute as an ISO 8601 time.
 *
 * @param minute - minutes since the epoch
 * @returns the time
 */
function isoMinute(minute: number): string {
  return new Date(minute * MS_PER_MINUTE).toISOString()
}

/**
 * Shapes one model's or alias's numbers for the response.
 *
 * @param usage - the numbers
 * @returns the response fields
 */
function usageBody(usage: UsageStats): Omit<Usage['models'][number], 'model'> {
  return {
    requests: usage.requests,
    failed: usage.failed,
    left: usage.left,
    average_ms: usage.averageMs ?? null,
    slowest_ms: usage.slowestMs,
    average_first_event_ms: usage.averageFirstEventMs ?? null,
    attempts: usage.attempts,
    fallbacks: usage.fallbacks,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cache_tokens: usage.cacheTokens,
    cost_usd: usage.costUsd
  }
}

/**
 * Reads a window's usage from the store and shapes the response.
 *
 * @param store - the stats store
 * @param window - the window
 * @param now - the current time, in milliseconds since the epoch
 * @returns the body
 */
function readUsage(store: UsageStore, window: StatsWindow, now: number): Usage {
  const range = windowMinutes(window, now)
  const bucketMinutes = BUCKET_MINUTES[window]
  const errors: ErrorStats = store.errors(range)
  return {
    object: 'switchboard.usage',
    window,
    from: isoMinute(range.fromMinute),
    to: isoMinute(range.toMinute),
    bucket_minutes: bucketMinutes,
    models: store.models(range).map((model: ModelStats) => ({
      model: model.model,
      ...usageBody(model)
    })),
    aliases: store.aliases(range).map((alias: AliasStats) => ({
      alias: alias.alias === '' ? null : alias.alias,
      ...usageBody(alias)
    })),
    failures: errors.failures.map((row) => ({ class: row.failureClass, count: row.count })),
    rejected: errors.rejected.map((row) => ({ status: row.status, count: row.count })),
    timeline: store.timeline(range, bucketMinutes).map((bucket: TimelineBucket) => ({
      start: isoMinute(bucket.minute),
      requests: bucket.requests,
      failed: bucket.failed,
      rejected: bucket.rejected
    }))
  }
}

/** Why usage can't be read, for the 503. */
type UsageUnavailable = 'stats-off' | 'unreadable'

/**
 * Closes a store whose read failed, logging rather than throwing: the request still gets its 503.
 *
 * @param store - the store, if one was open
 */
function closeQuietly(store: UsageStore | undefined): void {
  try {
    store?.close()
  } catch (error) {
    usageLogger.debug('Could not close the stats file after a failed read: {reason}', {
      reason: error instanceof Error ? error.message : String(error)
    })
  }
}

/**
 * Creates the route's reader of the stats file: it opens the file on the first request and keeps
 * it open; a file that won't open or read is closed and tried again on the next request. One
 * window's answer is reused for a few seconds ({@link SNAPSHOT_MS}), since the reads are
 * synchronous, on the thread that serves requests.
 *
 * @param statsEnabled - whether the proxy keeps stats (`--no-stats` turns them off)
 * @param open - opens the stats file at a path
 * @returns a function that reads a window, or says why it can't
 */
function createUsageReader(
  statsEnabled: boolean,
  open: (path: string) => UsageStore
): (window: StatsWindow, now: number) => Usage | UsageUnavailable {
  let store: UsageStore | undefined
  let cached:
    | { readonly window: StatsWindow; readonly at: number; readonly usage: Usage }
    | undefined
  return (window, now) => {
    if (!statsEnabled) return 'stats-off'
    if (cached?.window === window && now - cached.at < SNAPSHOT_MS) return cached.usage
    try {
      store ??= open(statsFilePath())
      const usage = readUsage(store, window, now)
      cached = { window, at: now, usage }
      return usage
    } catch (error) {
      // Closed and opened again on the next request: the file may have been fixed or unlocked.
      closeQuietly(store)
      store = undefined
      usageLogger.warn('Could not read usage from the stats file: {reason}', {
        reason: error instanceof Error ? error.message : String(error)
      })
      return 'unreadable'
    }
  }
}

/** The route's answer: a status and its body. */
export type UsageAnswer =
  | { readonly status: typeof HTTP_OK; readonly body: Usage }
  | {
      readonly status: typeof HTTP_BAD_REQUEST | typeof HTTP_SERVICE_UNAVAILABLE
      readonly body: OpenAIError
    }

/**
 * Creates the answer of `GET /v1/switchboard/usage`: the window's usage, a `400` for a window it
 * doesn't know, or a `503` when stats are off or the file can't be read.
 *
 * @param statsEnabled - whether the proxy keeps stats
 * @param open - opens the stats file at a path; `openStatsStore` but in tests
 * @returns a function from the `window` query value and the time to the answer
 */
export function createUsageAnswer(
  statsEnabled: boolean,
  open: (path: string) => UsageStore = openStatsStore
): (window: string | readonly string[] | undefined, now: number) => UsageAnswer {
  const read = createUsageReader(statsEnabled, open)
  return (window, now) => {
    // A repeated `window` counts by its first value, as `verify` does on /healthz/creds.
    const asked = (typeof window === 'string' ? window : window?.[0]) ?? 'today'
    if (!isStatsWindow(asked)) {
      return {
        status: HTTP_BAD_REQUEST,
        body: invalidRequest('`window` must be `today`, `week` or `all`', 'window')
      }
    }
    const usage = read(asked, now)
    if (usage === 'stats-off') {
      return {
        status: HTTP_SERVICE_UNAVAILABLE,
        body: statsUnavailable('Stats are off (--no-stats): the proxy keeps no usage to read')
      }
    }
    if (usage === 'unreadable') {
      return {
        status: HTTP_SERVICE_UNAVAILABLE,
        body: statsUnavailable('The stats file could not be read; see the proxy log')
      }
    }
    return { status: HTTP_OK, body: usage }
  }
}
