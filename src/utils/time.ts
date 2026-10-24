/**
 * Time units in milliseconds, and the clock readings the proxy derives from them. One home for
 * the constants, so no module declares its own `MS_PER_SECOND = 1000`.
 *
 * @packageDocumentation
 */

/** Milliseconds in one second. */
export const MS_PER_SECOND = 1000
/** Milliseconds in one minute. */
export const MS_PER_MINUTE = 60_000
/** Milliseconds in one hour. */
export const MS_PER_HOUR = 3_600_000
/** Milliseconds in one day. */
export const MS_PER_DAY = 86_400_000

/**
 * Reads the current time as OpenAI's `created` fields carry it: whole seconds since the Unix
 * epoch.
 *
 * @returns `Date.now()` in seconds, rounded down
 */
export function unixSecondsNow(): number {
  return Math.floor(Date.now() / MS_PER_SECOND)
}
