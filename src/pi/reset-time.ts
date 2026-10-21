/**
 * When a rate-limited or overloaded provider says it will take requests again (#68), read from the
 * failed response itself.
 *
 * @remarks
 * pi calls its `onResponse` hook only for a successful response on most APIs, so the proxy passes
 * pi a `fetch` ({@link capturingFetch}) that keeps a copy of every 429, 503 and 529: status, headers
 * and body. {@link resetAfterMs} reads a wait from it, first source found:
 * 1. `retry-after-ms`, then `retry-after` (seconds or an HTTP date);
 * 2. the body's `resets_in_seconds`, `retry_after` or `resets_at` (Codex's usage limit sends these);
 * 3. the providers' reset headers, the latest of them: OpenAI's `x-ratelimit-reset-*` (durations
 *    such as `6m0s`) and Anthropic's `anthropic-ratelimit-*-reset` (timestamps);
 * 4. the message's own words: "try again in 1h2m", "retry after 30 seconds", "resets in 3 days".
 *
 * None found is `undefined`: the cooldown then uses its growing default (`src/pi/cooldowns.ts`).
 *
 * @packageDocumentation
 */

import { MS_PER_SECOND } from '@proxy/config/schema'
import {
  HTTP_OVERLOADED,
  HTTP_SERVICE_UNAVAILABLE,
  HTTP_TOO_MANY_REQUESTS
} from '@proxy/server/http-status'
import { isRecord } from '@proxy/utils/guards'

/** A failed upstream response, as {@link capturingFetch} kept it. */
export interface FailedResponse {
  readonly status: number
  readonly headers: Headers
  /** The body's first {@link BODY_LIMIT} characters. */
  readonly body: string
}

/** The statuses whose response is kept: those that start a cooldown. */
const CAPTURED_STATUSES: ReadonlySet<number> = new Set([
  HTTP_TOO_MANY_REQUESTS,
  HTTP_SERVICE_UNAVAILABLE,
  HTTP_OVERLOADED
])

/** How much of an error body is kept: enough for any provider's error JSON. */
const BODY_LIMIT = 16_384

/** Milliseconds in a minute. */
const MS_PER_MINUTE = 60_000
/** Milliseconds in an hour. */
const MS_PER_HOUR = 3_600_000
/** Milliseconds in a day. */
const MS_PER_DAY = 86_400_000

/** Milliseconds in each unit a duration can be written in, by the unit's lower-case name. */
const UNIT_MS: ReadonlyMap<string, number> = new Map([
  ...['ms', 'millisecond', 'milliseconds'].map((unit) => [unit, 1] as const),
  ...['s', 'sec', 'secs', 'second', 'seconds'].map((unit) => [unit, MS_PER_SECOND] as const),
  ...['m', 'min', 'mins', 'minute', 'minutes'].map((unit) => [unit, MS_PER_MINUTE] as const),
  ...['h', 'hr', 'hrs', 'hour', 'hours'].map((unit) => [unit, MS_PER_HOUR] as const),
  ...['d', 'day', 'days'].map((unit) => [unit, MS_PER_DAY] as const)
])

/**
 * One `<number><unit>` part of a duration, such as `6m`, `0.5s` or `3 days`. A unit ends at the
 * next non-letter, so `6m0s` reads as 6 minutes and 0 seconds.
 */
const DURATION_PART =
  /(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|hr|h|days?|d)(?![a-z])/gi

/** A run of duration parts, such as `1h2m3.5s` or `3 days 4 hours`. */
const DURATION_RUN = new RegExp(`^\\s*(?:${DURATION_PART.source}[\\s,]*(?:and\\s+)?)+$`, 'i')

/** The phrases a message puts before the wait. */
const WAIT_PHRASE =
  /(?:try again in|retry after|retry in|resets? in|available again in|wait)\s+((?:\d+(?:\.\d+)?\s*[a-z]+[\s,]*(?:and\s+)?)+)/i

/** A Unix time in seconds is past this; anything smaller is a number of seconds to wait. */
const EPOCH_SECONDS_FLOOR = 1_000_000_000

/**
 * Reads a duration such as `6m0s`, `500ms` or `3 days 4 hours`.
 *
 * @param text - the duration as written
 * @returns the duration in milliseconds, or `undefined` when `text` is not one
 */
function parseDuration(text: string): number | undefined {
  if (!DURATION_RUN.test(text)) return undefined
  let total = 0
  for (const [, amount, unit] of text.matchAll(DURATION_PART)) {
    const factor = unit === undefined ? undefined : UNIT_MS.get(unit.toLowerCase())
    if (amount === undefined || factor === undefined) return undefined
    total += Number.parseFloat(amount) * factor
  }
  return total
}

/**
 * Reads a point in time or a wait, as reset headers and bodies write them: a number of seconds, a
 * Unix time in seconds, a duration, or a date.
 *
 * @param value - the value as written
 * @param now - the current time, in milliseconds since the epoch
 * @returns the wait in milliseconds from `now`, or `undefined` when unreadable
 */
function parseResetValue(value: unknown, now: number): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > EPOCH_SECONDS_FLOOR ? value * MS_PER_SECOND - now : value * MS_PER_SECOND
  }
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const trimmed = value.trim()
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return parseResetValue(Number.parseFloat(trimmed), now)
  const duration = parseDuration(trimmed)
  if (duration !== undefined) return duration
  const date = Date.parse(trimmed)
  return Number.isNaN(date) ? undefined : date - now
}

/**
 * Reads the wait from the standard `retry-after-ms` and `retry-after` headers.
 *
 * @param headers - the response headers
 * @param now - the current time
 * @returns the wait in milliseconds, or `undefined`
 */
function fromRetryAfter(headers: Headers, now: number): number | undefined {
  const retryAfterMs = Number.parseFloat(headers.get('retry-after-ms') ?? '')
  if (Number.isFinite(retryAfterMs)) return retryAfterMs
  const retryAfter = headers.get('retry-after')
  if (retryAfter === null) return undefined
  const seconds = Number.parseFloat(retryAfter)
  if (/^\s*\d+(?:\.\d+)?\s*$/.test(retryAfter)) return seconds * MS_PER_SECOND
  const date = Date.parse(retryAfter)
  return Number.isNaN(date) ? undefined : date - now
}

/**
 * Reads the wait from a JSON error body's own fields, at the top level or under `error`.
 *
 * @param body - the parsed body
 * @param now - the current time
 * @returns the wait in milliseconds, or `undefined`
 */
function fromBodyFields(body: unknown, now: number): number | undefined {
  const scopes = isRecord(body) ? [body, body['error']].filter(isRecord) : []
  for (const scope of scopes) {
    if (typeof scope['resets_in_seconds'] === 'number') {
      return scope['resets_in_seconds'] * MS_PER_SECOND
    }
    if (typeof scope['retry_after'] === 'number') return scope['retry_after'] * MS_PER_SECOND
    const resetsAt = parseResetValue(scope['resets_at'], now)
    if (resetsAt !== undefined) return resetsAt
  }
  return undefined
}

/**
 * Reads the latest of the providers' reset headers.
 *
 * @param headers - the response headers
 * @param now - the current time
 * @returns the longest wait any of them gives, or `undefined` when there is none
 */
function fromResetHeaders(headers: Headers, now: number): number | undefined {
  let latest: number | undefined
  for (const [headerName, headerValue] of headers) {
    if (!/ratelimit.*reset/i.test(headerName)) continue
    const wait = parseResetValue(headerValue, now)
    if (wait !== undefined && (latest === undefined || wait > latest)) latest = wait
  }
  return latest
}

/**
 * Reads the wait a message states in words: "try again in 20s".
 *
 * @param body - the body text, JSON or not
 * @returns the wait in milliseconds, or `undefined`
 */
function fromMessage(body: string): number | undefined {
  const phrase = WAIT_PHRASE.exec(body)?.[1]?.replace(/[\s,]+$/, '')
  return phrase === undefined ? undefined : parseDuration(phrase)
}

/**
 * Parses a body as JSON, or not at all.
 *
 * @param body - the body text
 * @returns the parsed value, or `undefined` when it is not JSON
 */
function parseJson(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

/**
 * Reads how long a failed response says to wait before trying the provider again.
 *
 * @param response - the failed response
 * @param now - the current time, in milliseconds since the epoch; `Date.now()` by default
 * @returns the wait in milliseconds, at least 1, or `undefined` when the response gives none
 */
export function resetAfterMs(
  response: FailedResponse,
  now: number = Date.now()
): number | undefined {
  const wait =
    fromRetryAfter(response.headers, now) ??
    fromBodyFields(parseJson(response.body), now) ??
    fromResetHeaders(response.headers, now) ??
    fromMessage(response.body)
  return wait !== undefined && Number.isFinite(wait) && wait > 0 ? Math.ceil(wait) : undefined
}

/**
 * Wraps `fetch` so that a 429, 503 or 529 response is copied to `onFailure` before pi reads it.
 *
 * @remarks
 * The body is read from a clone, so pi and the provider SDK still read the original. Only those
 * statuses are cloned: a successful stream is passed through untouched.
 *
 * @param onFailure - receives each captured response
 * @param base - the `fetch` to wrap; the global one by default
 * @returns the wrapped `fetch`, for pi's `fetch` stream option
 */
export function capturingFetch(
  onFailure: (response: FailedResponse) => void,
  base: typeof globalThis.fetch = globalThis.fetch
): typeof globalThis.fetch {
  return async (input, init) => {
    const response = await base(input, init)
    if (CAPTURED_STATUSES.has(response.status)) {
      const body = await response
        .clone()
        .text()
        .catch(() => '')
      onFailure({
        status: response.status,
        headers: response.headers,
        body: body.slice(0, BODY_LIMIT)
      })
    }
    return response
  }
}
