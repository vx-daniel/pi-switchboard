/**
 * The console's cached reads of the stats store besides the dashboard's own (`dashboard.ts`):
 * today's cost for the status strip, and the Doctor view's numbers (#325). Each keeps its own
 * snapshot for a few seconds, so readers on every redraw neither query the file each time nor
 * push out each other's snapshot.
 *
 * @packageDocumentation
 */

import { type DoctorStats, readDoctorStats } from '@proxy/doctor/collect'
import type { StatsStore } from '@proxy/stats/store'
import { type StatsWindow, windowMinutes } from '@proxy/stats/windows'

/** How long a snapshot of the stats store is reused, in milliseconds. */
export const SNAPSHOT_MS = 5000

/**
 * Creates the status strip's reader of today's cost: the cost of the requests since local
 * midnight, read again only after a few seconds. It keeps its own snapshot, so the strip reading
 * it on every redraw doesn't push out the dashboard's.
 *
 * @param store - the stats store
 * @param now - the clock
 * @returns a function to today's cost, in US dollars
 */
export function createTodayCostSource(
  store: Pick<StatsStore, 'models'>,
  now: () => number = Date.now
): () => number {
  let cached: { at: number; costUsd: number } | undefined
  return () => {
    const at = now()
    if (cached !== undefined && at - cached.at < SNAPSHOT_MS) return cached.costUsd
    const models = store.models(windowMinutes('today', at))
    const costUsd = models.reduce((total, model) => total + model.costUsd, 0)
    cached = { at, costUsd }
    return costUsd
  }
}

/**
 * Creates the Doctor view's reader of the stats store (#325): each model's numbers and each
 * alias's fallbacks over a window, read again only after a few seconds or for another window.
 * The Doctor tab's count reads it on every redraw, whatever view is shown.
 *
 * @param store - the stats store
 * @param now - the clock
 * @returns a function from a window to what the doctor reads of it
 */
export function createDoctorStatsSource(
  store: Pick<StatsStore, 'models' | 'aliases'>,
  now: () => number = Date.now
): (window: StatsWindow) => DoctorStats {
  let cached: { window: StatsWindow; at: number; stats: DoctorStats } | undefined
  return (window) => {
    const at = now()
    if (cached?.window === window && at - cached.at < SNAPSHOT_MS) return cached.stats
    const stats = readDoctorStats(store, window, at)
    cached = { window, at, stats }
    return stats
  }
}
