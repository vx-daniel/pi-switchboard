/**
 * How the admin pages write numbers and times: durations, clock times, shares, token counts and
 * dollars, each in one place so every page writes them alike.
 *
 * @packageDocumentation
 */

/** Milliseconds in a second. */
const MS_PER_SECOND = 1000
/** Seconds in a minute, and minutes in an hour. */
const SIXTY = 60
/** Milliseconds in a minute. */
const MS_PER_MINUTE = SIXTY * MS_PER_SECOND
/** Milliseconds in an hour. */
const MS_PER_HOUR = SIXTY * MS_PER_MINUTE
/** A share's scale to a percentage. */
const PERCENT = 100
/** Digits a two-digit minute or second pads to. */
const TWO_DIGITS = 2

/** Token counts, compact: `12.3K`. */
const COMPACT = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })
/** Dollars to the cent. */
const DOLLARS = new Intl.NumberFormat('en', { style: 'currency', currency: 'USD' })
/** Dollars to a tenth of a cent, for amounts under a dollar. */
const SMALL_DOLLARS = new Intl.NumberFormat('en', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 3
})
/** A clock time to the second. */
const CLOCK = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
})

/**
 * Writes a duration: milliseconds under a second, seconds under a minute, then minutes.
 *
 * @param ms - the duration in milliseconds
 * @returns `340 ms`, `2.4 s` or `3m 05s`
 */
export function duration(ms: number): string {
  if (ms < MS_PER_SECOND) return `${String(Math.round(ms))} ms`
  if (ms < MS_PER_MINUTE) return `${(ms / MS_PER_SECOND).toFixed(1)} s`
  const minutes = Math.floor(ms / MS_PER_MINUTE)
  const seconds = Math.round((ms % MS_PER_MINUTE) / MS_PER_SECOND)
  return `${String(minutes)}m ${String(seconds).padStart(TWO_DIGITS, '0')}s`
}

/**
 * Writes how long until a time: hours and minutes, or minutes, or `now`.
 *
 * @param at - the time, in milliseconds since the epoch
 * @param now - the time now
 * @returns `in 3h 12m`, `in 4m` or `now`
 */
export function until(at: number, now: number): string {
  const left = at - now
  if (left < MS_PER_MINUTE) return 'now'
  const hours = Math.floor(left / MS_PER_HOUR)
  const minutes = Math.floor((left % MS_PER_HOUR) / MS_PER_MINUTE)
  return hours > 0 ? `in ${String(hours)}h ${String(minutes)}m` : `in ${String(minutes)}m`
}

/** Hours in a day. */
const HOURS_PER_DAY = 24
/** Milliseconds in a day. */
const MS_PER_DAY = HOURS_PER_DAY * MS_PER_HOUR

/**
 * Writes a duration compactly, as the console's sidebar and strip do: its two largest units.
 *
 * @param ms - the duration in milliseconds
 * @returns `45s`, `12m`, `3h 12m` or `2d 4h`
 */
export function compactDuration(ms: number): string {
  const span = Math.max(0, ms)
  if (span < MS_PER_MINUTE) return `${String(Math.floor(span / MS_PER_SECOND))}s`
  if (span < MS_PER_HOUR) return `${String(Math.floor(span / MS_PER_MINUTE))}m`
  if (span < MS_PER_DAY) {
    return `${String(Math.floor(span / MS_PER_HOUR))}h ${String(Math.floor((span % MS_PER_HOUR) / MS_PER_MINUTE))}m`
  }
  return `${String(Math.floor(span / MS_PER_DAY))}d ${String(Math.floor((span % MS_PER_DAY) / MS_PER_HOUR))}h`
}

/**
 * Writes a clock time.
 *
 * @param at - the time, in milliseconds since the epoch
 * @returns `14:03:27`
 */
export function clock(at: number): string {
  return CLOCK.format(at)
}

/**
 * Writes a share as a whole percentage.
 *
 * @param share - from 0 to 1
 * @returns `42%`
 */
export function percent(share: number): string {
  return `${String(Math.round(share * PERCENT))}%`
}

/**
 * Writes a token count compactly.
 *
 * @param count - the tokens
 * @returns `950`, `12.3K`, `4.1M`
 */
export function tokens(count: number): string {
  return COMPACT.format(count)
}

/**
 * Writes an amount in dollars.
 *
 * @param amount - dollars
 * @returns `$1.23`, `$0.004`
 */
export function dollars(amount: number): string {
  return (amount < 1 ? SMALL_DOLLARS : DOLLARS).format(amount)
}
