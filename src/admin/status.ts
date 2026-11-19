/**
 * What the admin UI's status strip and sidebar show (#367), as the console's do: the proxy's
 * version, address and auth, its models and cooldowns, the last half hour of chat requests, what
 * today cost, and the traffic since it started.
 *
 * @remarks
 * Read from the running process, like the pages' snapshots (`src/admin/reads.ts`): the console's
 * own counters (`requestsPerMinute`, `routeTotals`) over the stores the API listener fills. The
 * console's open-connection count needs the API server's handle, which the admin listener does
 * not hold, so the strip here leaves it out.
 *
 * @packageDocumentation
 */

import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import type { AdminServerFacts } from '@proxy/admin/reads'
import { isLoopbackHost } from '@proxy/config/schema'
import { computeModelExposure } from '@proxy/openai/model-exposure'
import { activeCooldowns } from '@proxy/pi/cooldowns'
import { getAvailableModels, getModelsJsonError } from '@proxy/pi/registry'
import { finishedRequests } from '@proxy/server/active-requests'
import { type RouteTotals, routeTotals, routeTotalsSince } from '@proxy/server/route-totals'
import { fileConfigReader } from '@proxy/server/routes'
import { requestsPerMinute } from '@proxy/tui/status-strip'

import packageJson from '../../package.json' with { type: 'json' }

/** Milliseconds in a second: `process.uptime()` is in seconds. */
const MS_PER_SECOND = 1000

/** The status strip's and the sidebar's data. */
export interface StatusSnapshot {
  readonly version: string
  /** The API listener's `host:port`. */
  readonly address: string
  readonly proxyAuth: 'token' | 'off'
  /** Whether the API listener is reachable beyond this machine. */
  readonly beyondLoopback: boolean
  readonly uptimeMs: number
  /** How many models pi has available. */
  readonly available: number
  /** How many are exposed, or why the exposure config can't be applied. */
  readonly exposed: number | string
  /** Why pi's models.json did not load, or `null`. */
  readonly modelsJsonError: string | null
  /** The active cooldowns. */
  readonly cooldowns: number
  /** Chat requests finished per minute over the last half hour, oldest first. */
  readonly perMinute: readonly number[]
  /** Whether the kept finished requests may miss some of the oldest minutes. */
  readonly saturated: boolean
  /** What today's requests cost in US dollars, or `null` while stats are off or unreadable. */
  readonly todayCostUsd: number | null
  /** The traffic since the proxy started (#70), per route. */
  readonly session: { readonly since: number; readonly totals: readonly RouteTotals[] }
}

/**
 * Reads the status.
 *
 * @param server - the API listener's settings
 * @param todayCostUsd - what today's requests cost, or `null` when the stats can't say
 * @param now - the time now
 * @returns the snapshot
 */
export async function statusSnapshot(
  server: AdminServerFacts,
  todayCostUsd: number | null,
  now: number
): Promise<StatusSnapshot> {
  const available = getAvailableModels()
  const exposure = computeModelExposure(
    available,
    await fileConfigReader(),
    getSupportedThinkingLevels
  )
  const { perMinute, saturated } = requestsPerMinute(finishedRequests(), now)
  return {
    version: packageJson.version,
    address: `${server.running.host}:${String(server.running.port)}`,
    proxyAuth: server.proxyAuth ? 'token' : 'off',
    beyondLoopback: !isLoopbackHost(server.running.host),
    uptimeMs: Math.round(process.uptime() * MS_PER_SECOND),
    available: available.length,
    exposed: exposure.ok ? exposure.models.length : exposure.message,
    modelsJsonError: getModelsJsonError() ?? null,
    cooldowns: activeCooldowns(now).length,
    perMinute,
    saturated,
    todayCostUsd,
    session: { since: routeTotalsSince(), totals: routeTotals() }
  }
}
