/**
 * What the admin UI's read-only pages show (#367, phase 1), read from the running proxy as the
 * console reads it: the requests in memory, the logins with their quota, reserve, cooldowns and
 * routing place, the exposed models and aliases, and the doctor's report.
 *
 * @remarks
 * The admin listener runs in the proxy's process, so these read the same in-memory stores and the
 * same config file the API listener uses. Nothing here calls a provider, resolves a credential or
 * writes a file, and nothing returns a credential: the logins are pi's credential statuses (as
 * `/healthz/creds` serves them), the models are what `GET /v1/switchboard/models` serves, and the
 * requests hold no message content. Stats come from the usage reader (`src/server/usage.ts`).
 *
 * @packageDocumentation
 */

import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import type { ServerConfig } from '@proxy/config/env'
import type { AliasTarget, FamilyTarget } from '@proxy/config/schema'
import {
  configFileProblem,
  describeConfigFileProblem,
  loadConfigFromFile
} from '@proxy/config/schema'
import { readStats, judgeDoctorInputs, serverSettingsOf } from '@proxy/doctor/collect'
import type { DoctorReport } from '@proxy/doctor/findings'
import type { AliasDiagnostic } from '@proxy/openai/model-aliases'
import { computeModelExposure } from '@proxy/openai/model-exposure'
import { type LoginDiagnostic, loginBase } from '@proxy/openai/model-logins'
import { buildPiModelList, type PiModelList } from '@proxy/openai/models'
import { activeCooldowns, type Cooldown } from '@proxy/pi/cooldowns'
import { providerQuota, type ProviderQuota } from '@proxy/pi/quota'
import {
  getAvailableModels,
  getCredentialStatuses,
  getModelsJsonError,
  type ProviderCredentialStatus
} from '@proxy/pi/registry'
import {
  activeRequests,
  type ActiveRequest,
  type FinishedRequest,
  finishedRequests
} from '@proxy/server/active-requests'
import { type ConsoleEvent, consoleEvents } from '@proxy/server/console-events'
import { credentialsHealthReport } from '@proxy/server/health'
import { type HttpRequest, httpRequests } from '@proxy/server/http-requests'
import { providerBelowReserve, type ReserveSkip } from '@proxy/server/route-reserve'
import { fileConfigReader } from '@proxy/server/routes'
import type { StatsWindow } from '@proxy/stats/windows'
import { type LoginPlace, loginPlaces } from '@proxy/tui/login-routing'

/** What the server runs with that the doctor and the status strip read: the API listener's settings. */
export type AdminServerFacts = Pick<
  ServerConfig,
  'host' | 'port' | 'docsUiEnabled' | 'statsEnabled'
> & {
  /** Whether proxy auth needs a token. */
  readonly proxyAuth: boolean
}

/** The Requests page: the HTTP requests, the chats behind them, and the proxy's events. */
export interface RequestsSnapshot {
  /** The HTTP requests kept and in flight, oldest first. */
  readonly requests: readonly HttpRequest[]
  /** The chat requests in flight, oldest first. */
  readonly active: readonly ActiveRequest[]
  /** The chat requests that finished, newest first. */
  readonly finished: readonly FinishedRequest[]
  /** The lifecycle events, oldest first. */
  readonly events: readonly ConsoleEvent[]
}

/** One login on the Accounts page. */
export interface AccountSnapshot extends ProviderCredentialStatus {
  /** The provider it is a login of: `anthropic` for `anthropic-account-2` (#227). */
  readonly base: string
  /** The label the operator gave it (`labels`), or `null`. */
  readonly label: string | null
  /** Its latest quota report, or `null` when it reported none. */
  readonly quota: ProviderQuota | null
  /** Why it is below its `routing.reserve`, or `null` when it is not. */
  readonly belowReserve: ReserveSkip | null
  /** Its active cooldowns, the provider's and its models'. */
  readonly cooldowns: readonly Cooldown[]
  /** Its place in its provider's routing order, or `null` when it has none. */
  readonly place: LoginPlace | null
}

/** The Models page: the exposed models and aliases, and what the config says about them. */
export interface ModelsSnapshot {
  /** The exposed models, as `GET /v1/switchboard/models` lists them. */
  readonly models: PiModelList['data']
  /** The exposed aliases, each as its target under the alias. */
  readonly aliases: PiModelList['data']
  /** The configured aliases, exposed or not. */
  readonly configured: Readonly<Record<string, AliasTarget>>
  /** The built-in `-latest` aliases (#231). */
  readonly latest: Readonly<Record<string, FamilyTarget>>
  /** Why aliases or their targets are left out. */
  readonly aliasDiagnostics: readonly AliasDiagnostic[]
  /** Login settings that name no login, and providers whose every login is disabled. */
  readonly loginDiagnostics: readonly LoginDiagnostic[]
  /** How many models pi has available, exposed or not. */
  readonly available: number
  /** Why models.json did not load, or `null`. */
  readonly modelsJsonError: string | null
}

/** The Models page when the exposure config can't be applied: why. */
export interface ModelsUnavailable {
  readonly unavailable: string
}

/** The too-few-calls advice's recommendation on the admin UI: its window choice. */
const HOW_TO_WIDEN = 'Try a longer window (All: 30 days), or come back after more traffic.'

/** The not-verified advice's recommendation on the admin UI, which verifies no login. */
const HOW_TO_VERIFY =
  "Run `pi-switchboard doctor --verify` in a terminal on the proxy's machine (as /healthz/creds?verify=true, it may refresh an OAuth token)."

/**
 * Reads the Requests page's snapshot from the stores the API listener fills.
 *
 * @returns the requests, the chats and the events, as they are now
 */
export function requestsSnapshot(): RequestsSnapshot {
  return {
    requests: httpRequests(),
    active: activeRequests(),
    finished: finishedRequests(),
    events: consoleEvents()
  }
}

/**
 * Reads the Accounts page's snapshot: each login pi has a credential for, from local state only
 * (no credential is resolved), with what routing knows about it.
 *
 * @param now - the current time, for quotas, reserves and cooldowns
 * @returns one entry per login, in pi's order
 */
export async function accountsSnapshot(now: number): Promise<AccountSnapshot[]> {
  const file = loadConfigFromFile()
  const accounts = await getCredentialStatuses(false)
  const places = loginPlaces(
    accounts.map((account) => account.provider),
    file.routing.logins
  )
  const cooldowns = activeCooldowns(now)
  return accounts.map((account) => ({
    ...account,
    base: loginBase(account.provider).base,
    label: file.labels[account.provider] ?? null,
    quota: providerQuota(account.provider, now) ?? null,
    belowReserve: providerBelowReserve(account.provider, file.routing.reserve, now) ?? null,
    cooldowns: cooldowns.filter((cooldown) => cooldown.provider === account.provider),
    place: places.get(account.provider) ?? null
  }))
}

/**
 * Reads the Models page's snapshot from the config file and pi's models, as a request would see
 * them now.
 *
 * @returns the snapshot, or why the exposure config can't be applied
 */
export async function modelsSnapshot(): Promise<ModelsSnapshot | ModelsUnavailable> {
  const config = await fileConfigReader()
  const available = getAvailableModels()
  const exposure = computeModelExposure(available, config, getSupportedThinkingLevels)
  if (!exposure.ok) return { unavailable: exposure.message }
  return {
    models: buildPiModelList(exposure.models).data,
    aliases: buildPiModelList(exposure.aliases).data,
    configured: config.aliases,
    latest: exposure.latestAliases,
    aliasDiagnostics: exposure.aliasDiagnostics,
    loginDiagnostics: exposure.loginDiagnostics,
    available: available.length,
    modelsJsonError: getModelsJsonError() ?? null
  }
}

/**
 * Judges the running proxy as `pi-switchboard doctor` would, from this process: the API
 * listener's settings, the config file as a request reads it, the logins from local state (none is
 * verified), and the stats file read-only over the window.
 *
 * @param server - the API listener's settings
 * @param window - the stats window
 * @param now - the current time
 * @returns the report
 */
export async function doctorSnapshot(
  server: AdminServerFacts,
  window: StatsWindow,
  now: number
): Promise<DoctorReport> {
  const problem = configFileProblem()
  return judgeDoctorInputs({
    server: serverSettingsOf(server, server.proxyAuth),
    requestConfig: await fileConfigReader(),
    credentials: { ...(await credentialsHealthReport(false)).body, howToVerify: HOW_TO_VERIFY },
    configFileProblem: problem === undefined ? undefined : describeConfigFileProblem(problem),
    stats: readStats(server.statsEnabled, window, now),
    window,
    howToWiden: HOW_TO_WIDEN
  })
}
