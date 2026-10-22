/**
 * The windows the stats are read over (#216, #224): today, the last week, or all 30 days the
 * stats file keeps. The console's Stats view and `GET /v1/switchboard/usage` both use them.
 *
 * @packageDocumentation
 */

import type { MinuteRange } from '@proxy/stats/store'

/** The windows, shortest first. */
export const STATS_WINDOWS = ['today', 'week', 'all'] as const

/** A window of the stats file's history. */
export type StatsWindow = (typeof STATS_WINDOWS)[number]

/** Milliseconds in a minute: the stats are kept per minute. */
export const MS_PER_MINUTE = 60_000
/** Minutes in a day. */
const MINUTES_PER_DAY = 1440
/** Days in each window that isn't today; `all` is the stats file's retention. */
const WINDOW_DAYS = { week: 7, all: 30 } as const

/**
 * Checks whether a text names a window.
 *
 * @param value - the text
 * @returns whether it is `today`, `week` or `all`
 */
export function isStatsWindow(value: string): value is StatsWindow {
  return STATS_WINDOWS.some((window) => window === value)
}

/**
 * Works out the minutes a window covers, up to and including the current minute.
 *
 * @param window - the window: `today` from local midnight, `week` the last 7 days, `all` the last 30
 * @param now - the current time, in milliseconds since the epoch
 * @returns the minutes
 */
export function windowMinutes(window: StatsWindow, now: number): MinuteRange {
  const toMinute = Math.floor(now / MS_PER_MINUTE) + 1
  if (window === 'today') {
    const midnight = new Date(now)
    midnight.setHours(0, 0, 0, 0)
    return { fromMinute: Math.floor(midnight.getTime() / MS_PER_MINUTE), toMinute }
  }
  return { fromMinute: toMinute - WINDOW_DAYS[window] * MINUTES_PER_DAY, toMinute }
}
