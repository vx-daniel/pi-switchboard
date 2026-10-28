/**
 * Gathers what `pi-switchboard doctor` judges (#299): the config as the proxy would start with it,
 * pi's model runtime and logins, the health reports, and the stats file, read-only.
 *
 * @remarks
 * Nothing is written: the config is only loaded, the stats file is opened read-only, and pi's
 * runtime is initialized offline. A provider is called only with `verify`, as
 * `/healthz/creds?verify=true` does (it may refresh an OAuth token).
 *
 * The console's Doctor tab (#325) judges its live state with the same builders:
 * {@link judgeDoctorInputs} from the running server's settings, the request config and logins the
 * console last read, and the stats its Stats view reads ({@link readDoctorStats}).
 *
 * @packageDocumentation
 */

import { existsSync } from 'node:fs'

import {
  type CliOverrides,
  loadConfig,
  type ServerConfig,
  UnusableProxyAuthError
} from '@proxy/config/env'
import {
  aliasFallbackOn,
  configFileProblem,
  describeConfigFileProblem,
  isLoopbackHost
} from '@proxy/config/schema'
import {
  type CacheInputs,
  type CatalogModel,
  type CredentialsInput,
  type DoctorReport,
  doctorReport,
  type GeneralInputs,
  type ServerSettings,
  type StatsState
} from '@proxy/doctor/findings'
import { canonicalModelId } from '@proxy/pi/model-id'
import { getAvailableModels, initRegistry } from '@proxy/pi/registry'
import { credentialsHealthReport, modelsHealthReport } from '@proxy/server/health'
import { fileConfigReader, type RequestConfig } from '@proxy/server/routes'
import { statsFilePath } from '@proxy/stats/recorder'
import { openStatsStore, type StatsStore } from '@proxy/stats/store'
import { type StatsWindow, windowMinutes } from '@proxy/stats/windows'
import { errorMessage } from '@proxy/utils/guards'

/** What the doctor is asked to check. */
export interface DoctorOptions {
  /** The settings the server flags give, as `pi-switchboard` with the same flags would apply. */
  readonly overrides: CliOverrides
  /** The stats window the cache section reads. */
  readonly window: StatsWindow
  /** Resolve each credential now, as `/healthz/creds?verify=true` does. */
  readonly verify: boolean
  /** The current time, for the window. */
  readonly now: number
}

/** The stats file's state, with each alias's fallbacks when it was read. */
export interface DoctorStats {
  readonly state: StatsState
  readonly fallbacksByAlias: ReadonlyMap<string, number> | undefined
}

/** Everything the doctor judges besides pi's catalog and the environment, however it was read. */
export interface DoctorInputs {
  /** The server settings, or why proxy auth can't be applied. */
  readonly server: GeneralInputs['server']
  /** The request config: the exposure, the aliases and the login routing. */
  readonly requestConfig: RequestConfig
  readonly credentials: CredentialsInput
  /** Why the config file could not be used, when it could not. */
  readonly configFileProblem: string | undefined
  readonly stats: DoctorStats
  /** The window the stats were read over. */
  readonly window: StatsWindow
  /** The too-few-calls advice's recommendation, when not the CLI's {@link WINDOW_FLAG_ADVICE}. */
  readonly howToWiden?: string
}

/** The too-few-calls advice's recommendation in the CLI. */
const WINDOW_FLAG_ADVICE = 'Try a longer window (--window all), or come back after more traffic.'

/**
 * Reads the doctor's stats over the window from an open stats store: each served model's numbers,
 * and each alias's fallbacks.
 *
 * @param store - the open store
 * @param window - the window
 * @param now - the current time
 * @returns what was read
 * @throws whatever reading the store throws
 */
export function readDoctorStats(
  store: Pick<StatsStore, 'models' | 'aliases'>,
  window: StatsWindow,
  now: number
): DoctorStats {
  const range = windowMinutes(window, now)
  const fallbacksByAlias = new Map(
    store.aliases(range).map((alias) => [alias.alias, alias.fallbacks])
  )
  return { state: { kind: 'read', models: store.models(range) }, fallbacksByAlias }
}

/**
 * Reads the stats file read-only over the window.
 *
 * @param enabled - whether stats are on
 * @param window - the window
 * @param now - the current time
 * @returns what could be read
 */
function readStats(enabled: boolean, window: StatsWindow, now: number): DoctorStats {
  if (!enabled) return { state: { kind: 'off' }, fallbacksByAlias: undefined }
  const path = statsFilePath()
  if (!existsSync(path)) return { state: { kind: 'missing', path }, fallbacksByAlias: undefined }
  try {
    const store = openStatsStore(path, { readOnly: true })
    try {
      return readDoctorStats(store, window, now)
    } finally {
      store.close()
    }
  } catch (error) {
    return {
      state: { kind: 'unreadable', reason: errorMessage(error) },
      fallbacksByAlias: undefined
    }
  }
}

/**
 * Reads pi's catalog entry for each available model, by canonical ID: a provider's first login
 * comes first, so its prices stand for the model.
 *
 * @returns the catalog
 */
function catalog(): Map<string, CatalogModel> {
  const byId = new Map<string, CatalogModel>()
  for (const model of getAvailableModels()) {
    const id = canonicalModelId(model)
    if (!byId.has(id)) byId.set(id, { api: model.api, baseUrl: model.baseUrl, cost: model.cost })
  }
  return byId
}

/**
 * Lists the aliases with a fallback chain, and the `fallbackOn` each names.
 *
 * @param config - the request config
 * @returns the fallback settings
 */
function fallbackSettings(config: RequestConfig): GeneralInputs['fallback'] {
  return {
    aliases: Object.entries(config.aliases).map(([alias, target]) => ({
      alias,
      fallbackOn: aliasFallbackOn(target)
    })),
    logins: config.loginFallbackOn ?? []
  }
}

/**
 * Takes the settings the config checks read from a server config.
 *
 * @param config - the server config
 * @param proxyAuth - whether proxy auth needs a token; the console's `p` changes it while running
 * @returns the settings
 */
export function serverSettingsOf(
  config: Pick<ServerConfig, 'host' | 'docsUiEnabled' | 'statsEnabled'>,
  proxyAuth: boolean
): ServerSettings {
  return {
    host: config.host,
    proxyAuth,
    docsUi: config.docsUiEnabled,
    stats: config.statsEnabled
  }
}

/**
 * Loads the server settings the config checks read.
 *
 * @param overrides - the settings the flags give
 * @returns them; `{ unusableAuth }` when proxy auth is set but cannot be applied
 * @throws whatever loading the config throws, other than {@link UnusableProxyAuthError}
 */
function serverSettings(overrides: CliOverrides): GeneralInputs['server'] {
  try {
    const config = loadConfig(overrides)
    return serverSettingsOf(config, config.proxyAuth.kind === 'token')
  } catch (error) {
    if (!(error instanceof UnusableProxyAuthError)) throw error
    return { unusableAuth: error.invalid.cause }
  }
}

/**
 * Judges the doctor's inputs with pi's catalog and `PI_CACHE_RETENTION` from this process's
 * environment: the proxy's own in the console, the shell's in the CLI.
 *
 * @param inputs - what was read
 * @returns the report
 * @throws Error when pi's model runtime is not initialized
 */
export function judgeDoctorInputs(inputs: DoctorInputs): DoctorReport {
  const general: GeneralInputs = {
    models: modelsHealthReport(inputs.requestConfig).body,
    credentials: inputs.credentials,
    server: inputs.server,
    configFileProblem: inputs.configFileProblem,
    fallback: fallbackSettings(inputs.requestConfig),
    fallbacksByAlias: inputs.stats.fallbacksByAlias
  }
  const cache: CacheInputs = {
    stats: inputs.stats.state,
    catalog: catalog(),
    retentionLong: process.env.PI_CACHE_RETENTION === 'long',
    howToWiden: inputs.howToWiden ?? WINDOW_FLAG_ADVICE
  }
  return doctorReport(general, cache, { window: inputs.window, isLoopback: isLoopbackHost })
}

/**
 * Reads everything the doctor judges, and judges it.
 *
 * @param options - the flags' settings, the window, `verify` and the time
 * @returns the report
 */
export async function collectReport(options: DoctorOptions): Promise<DoctorReport> {
  const server = serverSettings(options.overrides)
  const fileProblem = configFileProblem()
  await initRegistry()
  const requestConfig = await fileConfigReader()
  const credentials = (await credentialsHealthReport(options.verify)).body
  // Stats are on by default; with proxy auth unusable the proxy would not start, but the file
  // may hold what an earlier run recorded.
  const statsEnabled = 'stats' in server ? server.stats : true
  return judgeDoctorInputs({
    server,
    requestConfig,
    credentials,
    configFileProblem:
      fileProblem === undefined ? undefined : describeConfigFileProblem(fileProblem),
    stats: readStats(statsEnabled, options.window, options.now),
    window: options.window
  })
}
