/**
 * Gathers what `pi-switchboard doctor` judges (#299): the config as the proxy would start with it,
 * pi's model runtime and logins, the health reports, and the stats file, read-only.
 *
 * @remarks
 * Nothing is written: the config is only loaded, the stats file is opened read-only, and pi's
 * runtime is initialized offline. A provider is called only with `verify`, as
 * `/healthz/creds?verify=true` does (it may refresh an OAuth token).
 *
 * @packageDocumentation
 */

import { existsSync } from 'node:fs'

import { type CliOverrides, loadConfig, UnusableProxyAuthError } from '@proxy/config/env'
import {
  aliasFallbackOn,
  configFileProblem,
  describeConfigFileProblem,
  isLoopbackHost
} from '@proxy/config/schema'
import {
  type CacheInputs,
  type CatalogModel,
  type DoctorReport,
  doctorReport,
  type GeneralInputs,
  type StatsState
} from '@proxy/doctor/findings'
import { canonicalModelId } from '@proxy/pi/model-id'
import { getAvailableModels, initRegistry } from '@proxy/pi/registry'
import { credentialsHealthReport, modelsHealthReport } from '@proxy/server/health'
import { fileConfigReader, type RequestConfig } from '@proxy/server/routes'
import { statsFilePath } from '@proxy/stats/recorder'
import { openStatsStore } from '@proxy/stats/store'
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
interface StatsRead {
  readonly state: StatsState
  readonly fallbacksByAlias: ReadonlyMap<string, number> | undefined
}

/**
 * Reads the stats file read-only over the window.
 *
 * @param enabled - whether stats are on
 * @param window - the window
 * @param now - the current time
 * @returns what could be read
 */
function readStats(enabled: boolean, window: StatsWindow, now: number): StatsRead {
  if (!enabled) return { state: { kind: 'off' }, fallbacksByAlias: undefined }
  const path = statsFilePath()
  if (!existsSync(path)) return { state: { kind: 'missing', path }, fallbacksByAlias: undefined }
  try {
    const store = openStatsStore(path, { readOnly: true })
    try {
      const range = windowMinutes(window, now)
      const fallbacksByAlias = new Map(
        store.aliases(range).map((alias) => [alias.alias, alias.fallbacks])
      )
      return { state: { kind: 'read', models: store.models(range) }, fallbacksByAlias }
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
 * Loads the server settings the config checks read.
 *
 * @param overrides - the settings the flags give
 * @returns them; `{ unusableAuth }` when proxy auth is set but cannot be applied
 * @throws whatever loading the config throws, other than {@link UnusableProxyAuthError}
 */
function serverSettings(overrides: CliOverrides): GeneralInputs['server'] {
  try {
    const config = loadConfig(overrides)
    return {
      host: config.host,
      proxyAuth: config.proxyAuth.kind === 'token',
      docsUi: config.docsUiEnabled,
      stats: config.statsEnabled
    }
  } catch (error) {
    if (!(error instanceof UnusableProxyAuthError)) throw error
    return { unusableAuth: error.invalid.cause }
  }
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
  const models = modelsHealthReport(requestConfig).body
  const credentials = (await credentialsHealthReport(options.verify)).body
  // Stats are on by default; with proxy auth unusable the proxy would not start, but the file
  // may hold what an earlier run recorded.
  const statsEnabled = 'stats' in server ? server.stats : true
  const stats = readStats(statsEnabled, options.window, options.now)
  const general: GeneralInputs = {
    models,
    credentials,
    server,
    configFileProblem:
      fileProblem === undefined ? undefined : describeConfigFileProblem(fileProblem),
    fallback: fallbackSettings(requestConfig),
    fallbacksByAlias: stats.fallbacksByAlias
  }
  const cache: CacheInputs = {
    stats: stats.state,
    catalog: catalog(),
    retentionLong: process.env.PI_CACHE_RETENTION === 'long'
  }
  return doctorReport(general, cache, { window: options.window, isLoopback: isLoopbackHost })
}
