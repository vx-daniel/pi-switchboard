/**
 * Read-only reports: /proxy show, /proxy token, /proxy models, /proxy verify.
 *
 * @packageDocumentation
 */

import { type Api, getSupportedThinkingLevels, type Model } from '@earendil-works/pi-ai'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import {
  aliasFallbackOn,
  authOffRisk,
  aliasModels,
  configFileAuthTokenInvalid,
  isAliasChain,
  loadConfigFromFile,
  type ProxyConfig,
  targetSummary
} from '@vx-daniel/pi-switchboard/config'
import {
  canonicalModelId,
  computeModelExposure,
  type ExposedModel,
  type ModelExposureOutcome
} from '@vx-daniel/pi-switchboard/exposure'
import { proxyLogger } from '@vx-daniel/pi-switchboard/logging'

import {
  buildExposureConfig,
  getSessionAvailableModels,
  getSessionEnabledModels,
  type ProxyState,
  tokenPreview
} from './state'

/** How many exposed public IDs `/proxy show` lists before summarizing the rest. */
const EXPOSED_PREVIEW_COUNT = 5

/** Logger for the report subcommands. */
const reportsLogger = proxyLogger('extension', 'reports')

// --- /proxy show ---

/**
 * Handles `/proxy show`: reloads the config and shows the server settings and exposure policy.
 *
 * @param state - the extension state; its config is replaced by the file's
 * @param context - the extension context, used for the notification
 * @throws Error when the session's model registry is not available yet
 */
export async function showConfig(state: ProxyState, context: ExtensionContext): Promise<void> {
  context.ui.notify(await buildConfigReport(state), 'info')
}

/**
 * Reloads the config into `state` and returns the `/proxy show` text.
 *
 * @param state - the extension state; its config is replaced by the file's
 * @returns two lines: the server settings, then the exposure policy and result
 * @throws Error when the session's model registry is not available yet
 */
export async function buildConfigReport(state: ProxyState): Promise<string> {
  state.config = loadConfigFromFile()
  const { config } = state
  const enabledModels =
    config.modelExposureMode === 'scoped' ? await getSessionEnabledModels(state) : undefined
  const models = getSessionAvailableModels(state)
  const outcome = computeModelExposure(
    models,
    await buildExposureConfig(state),
    getSupportedThinkingLevels
  )
  if (!outcome.ok) {
    reportsLogger.warn('Model exposure error in /proxy show: {message}', {
      message: outcome.message
    })
  }
  reportsLogger.debug('/proxy show: {availableCount} available, {exposedCount} exposed', {
    availableCount: models.length,
    exposedCount: outcome.ok ? outcome.models.length : 0,
    exposureMode: config.modelExposureMode
  })

  const exposureLines = [
    ...formatExposurePolicy(config, enabledModels),
    ...formatExposureOutcome(outcome)
  ]
  return `${formatServerSettings(config).join(' | ')}\n${exposureLines.join(' | ')}`
}

/**
 * Returns the `/proxy show` auth field.
 *
 * @remarks
 * Shows a preview of the token, never the whole of it (#90): `/proxy show` output gets pasted
 * into issues and chats. `/proxy token` shows it whole. `invalid` when `authToken` in the file is
 * not a string, which the proxy refuses to start with (#82) rather than turning auth off.
 *
 * @param config - the loaded proxy config
 * @returns `enabled (token: <preview>; /proxy token shows it)`, the `disabled` warning (who can use
 *   the proxy without a token, by where it listens and whether the host/origin guard is on), or the
 *   `invalid` explanation
 */
function authSummary(config: ProxyConfig): string {
  if (configFileAuthTokenInvalid()) {
    return 'invalid (authToken in proxy-config.json is not a string: the proxy refuses to start)'
  }
  if (config.authToken.length > 0) {
    return `enabled (token: ${tokenPreview(config.authToken)}; /proxy token shows it)`
  }
  return `disabled (${authOffRisk(config.host, config.hostOriginGuard)}; set a token in /proxy config)`
}

// --- /proxy token ---

/**
 * Handles `/proxy token`: reloads the config and shows the whole proxy auth token, for copying
 * into a client.
 *
 * @remarks
 * The token reaches the notification only, never a log line. Without a token it says auth is
 * off; with an `authToken` that is not a string, that it is invalid (#82).
 *
 * @param state - the extension state; its config is replaced by the file's
 * @param context - the extension context, used for the notification
 */
export function showToken(state: ProxyState, context: ExtensionContext): void {
  state.config = loadConfigFromFile()
  if (configFileAuthTokenInvalid()) {
    context.ui.notify(
      'Proxy auth is invalid: authToken in proxy-config.json is not a string. Set a new token in /proxy config.',
      'warning'
    )
  } else if (state.config.authToken.length === 0) {
    context.ui.notify('Proxy auth is disabled: no token is set.', 'info')
  } else {
    reportsLogger.debug('Showed the proxy auth token')
    context.ui.notify(`Proxy auth token: ${state.config.authToken}`, 'info')
  }
}

/**
 * Returns the `/proxy show` server-settings fields; a set auth token is shown as a preview.
 *
 * @param config - the loaded proxy config
 * @returns one `name: value` string per field
 */
function formatServerSettings(config: ProxyConfig): string[] {
  const authDisplay = authSummary(config)
  return [
    `lifetime: ${config.lifetime}`,
    `host: ${config.host}`,
    `port: ${String(config.port)}`,
    `auth: ${authDisplay}`,
    `host/origin guard: ${config.hostOriginGuard ? 'on' : 'off'}`,
    `remote images: ${String(config.remoteImages)}`,
    `docs ui: ${String(config.docsUi)}`,
    `responses api: ${String(config.responsesApi)}`,
    `stats: ${String(config.stats)}`,
    `max body: ${String(config.maxBodySizeMb)} MB`,
    `timeout: ${String(config.upstreamTimeoutSec)}s`
  ]
}

/**
 * Returns the `/proxy show` exposure-policy fields: ID and exposure mode, then, when there are
 * any, the pi pattern count (scoped mode only), custom model count (custom mode only), provider
 * prefixes, and aliases with their fallback chains (#66, #67).
 *
 * @param config - the loaded proxy config
 * @param enabledModels - pi's `enabledModels` setting; the caller reads it only in scoped mode
 * @returns one `name: value` string per field
 */
function formatExposurePolicy(
  config: ProxyConfig,
  enabledModels: readonly string[] | undefined
): string[] {
  const lines = [`id mode: ${config.publicModelIdMode}`, `exposure: ${config.modelExposureMode}`]
  if (enabledModels !== undefined && enabledModels.length > 0) {
    lines.push(`enabled: ${String(enabledModels.length)} pi pattern(s)`)
  }
  if (config.modelExposureMode === 'custom' && config.customModels.length > 0) {
    lines.push(`models: ${String(config.customModels.length)} custom`)
  }
  const prefixKeys = Object.keys(config.providerPrefixes)
  if (prefixKeys.length > 0) {
    const pairs = prefixKeys.map(
      (providerName) => `${providerName}=${config.providerPrefixes[providerName] ?? providerName}`
    )
    lines.push(`prefixes: ${pairs.join(', ')}`)
  }
  const aliasPairs = Object.entries(config.aliases).map(([alias, target]) => {
    const models = aliasModels(target).map((aliasTarget) =>
      aliasTarget.reasoningEffort === undefined
        ? targetSummary(aliasTarget)
        : `${targetSummary(aliasTarget)}@${aliasTarget.reasoningEffort}`
    )
    if (!isAliasChain(target)) return `${alias}=${models.join('')}`
    return `${alias}=${models.join(' > ')} (on ${aliasFallbackOn(target).join(', ') || 'nothing'})`
  })
  if (aliasPairs.length > 0) lines.push(`aliases: ${aliasPairs.join(', ')}`)
  return lines
}

/**
 * Returns the `/proxy show` exposure-result fields: the exposed public IDs, any unresolved scope
 * patterns and any aliases left out, or the exposure error.
 *
 * @param outcome - the result of `computeModelExposure`
 * @returns one `name: value` string per field
 */
function formatExposureOutcome(outcome: ModelExposureOutcome): string[] {
  if (!outcome.ok) return [`error: ${outcome.message}`]
  const lines = [formatExposedPreview(outcome.models)]
  if (outcome.scopeDiagnostics.length > 0) {
    const patterns = outcome.scopeDiagnostics.map(
      (diagnostic) => `${diagnostic.pattern} (${diagnostic.code})`
    )
    lines.push(`unresolved: ${patterns.join(', ')}`)
  }
  if (outcome.aliasDiagnostics.length > 0) {
    const ignored = outcome.aliasDiagnostics.map(
      (diagnostic) => `${diagnostic.alias} (${diagnostic.code})`
    )
    lines.push(`aliases ignored: ${ignored.join(', ')}`)
  }
  return lines
}

/**
 * Returns the `exposed:` field: the first {@link EXPOSED_PREVIEW_COUNT} public IDs and how many
 * more.
 *
 * @param exposedModels - the exposed models, in exposure order
 * @returns the field, or `exposed: none` when the list is empty
 */
function formatExposedPreview(exposedModels: readonly ExposedModel[]): string {
  if (exposedModels.length === 0) return 'exposed: none'
  const preview = exposedModels.slice(0, EXPOSED_PREVIEW_COUNT).map((model) => model.publicId)
  const hidden = exposedModels.length - EXPOSED_PREVIEW_COUNT
  const suffix = hidden > 0 ? ` (+${String(hidden)} more)` : ''
  return `exposed: ${preview.join(', ')}${suffix}`
}

// --- /proxy models ---

/**
 * Handles `/proxy models`: reloads the config and lists every exposed model by provider.
 *
 * @param state - the extension state; its config is replaced by the file's
 * @param context - the extension context, used for the notification
 * @throws Error when the session's model registry is not available yet
 */
export async function showModels(state: ProxyState, context: ExtensionContext): Promise<void> {
  const report = await buildModelsReport(state)
  context.ui.notify(report.message, report.level)
}

/**
 * Reloads the config into `state` and returns the `/proxy models` result.
 *
 * @param state - the extension state; its config is replaced by the file's
 * @returns the models grouped by provider at `info`, a no-models hint at `info`, or the
 *   exposure error at `warning`
 * @throws Error when the session's model registry is not available yet
 */
export async function buildModelsReport(state: ProxyState): Promise<Report> {
  state.config = loadConfigFromFile()
  const models = getSessionAvailableModels(state)
  const outcome = computeModelExposure(
    models,
    await buildExposureConfig(state),
    getSupportedThinkingLevels
  )

  if (!outcome.ok) {
    reportsLogger.warn('Model exposure error in /proxy models: {message}', {
      message: outcome.message
    })
    return { message: `Model exposure error: ${outcome.message}`, level: 'warning' }
  }

  reportsLogger.debug('/proxy models: {availableCount} available, {exposedCount} exposed', {
    availableCount: models.length,
    exposedCount: outcome.models.length
  })
  if (outcome.models.length === 0) {
    return { message: 'No models exposed. Check /proxy verify for details.', level: 'info' }
  }

  // Group models by provider for readable output
  const byProvider = new Map<string, { publicId: string; canonicalId: string }[]>()
  for (const model of outcome.models) {
    const list = byProvider.get(model.provider)
    const entry = { publicId: model.publicId, canonicalId: model.canonicalId }
    if (list === undefined) {
      byProvider.set(model.provider, [entry])
    } else {
      list.push(entry)
    }
  }

  const sections: string[] = []
  for (const [provider, entries] of byProvider) {
    const lines = entries.map((modelEntry) => {
      // Only show canonical ID when it differs from the public ID
      if (modelEntry.publicId === modelEntry.canonicalId) {
        return `  ${modelEntry.publicId}`
      }
      return `  ${modelEntry.publicId}  (${modelEntry.canonicalId})`
    })
    sections.push(`${provider} (${String(entries.length)}):\n${lines.join('\n')}`)
  }

  const header = `${String(outcome.models.length)} exposed model(s)`
  return { message: `${header}\n\n${sections.join('\n\n')}`, level: 'info' }
}

// --- /proxy verify ---

/** A report's text and the notification level to show it at. */
export interface Report {
  readonly message: string
  readonly level: 'info' | 'warning'
}

/**
 * Handles `/proxy verify`: reloads the config and reports anything that would expose fewer
 * models or fail exposure.
 *
 * @param state - the extension state; its config is replaced by the file's
 * @param context - the extension context, used for the notification
 * @throws Error when the session's model registry is not available yet
 */
export async function verifyExposure(state: ProxyState, context: ExtensionContext): Promise<void> {
  const report = await buildVerifyReport(state)
  context.ui.notify(report.message, report.level)
}

/**
 * Reloads the config into `state` and returns the `/proxy verify` result.
 *
 * @param state - the extension state; its config is replaced by the file's
 * @returns a pass at `info`, or the issues at `warning`
 * @throws Error when the session's model registry is not available yet
 */
export async function buildVerifyReport(state: ProxyState): Promise<Report> {
  state.config = loadConfigFromFile()
  const { config } = state
  const models = getSessionAvailableModels(state)
  // Run the full exposure computation to catch ID/prefix errors
  const outcome = computeModelExposure(
    models,
    await buildExposureConfig(state),
    getSupportedThinkingLevels
  )
  const issues = collectExposureIssues(config, models, outcome)
  const exposedCount = outcome.ok ? outcome.models.length : 0

  reportsLogger.debug(
    'Verify: {availableCount} available, {exposedCount} exposed, {issueCount} issue(s)',
    {
      availableCount: models.length,
      exposedCount,
      issueCount: issues.length,
      exposureMode: config.modelExposureMode,
      customModelCount: config.customModels.length
    }
  )
  for (const issue of issues) {
    reportsLogger.warn('Verify found an issue: {issue}', { issue })
  }
  return formatVerifyReport(issues, exposedCount)
}

/**
 * Returns every `/proxy verify` issue, in report order: no available models, custom-mode
 * problems, then the exposure error.
 *
 * @param config - the loaded proxy config
 * @param models - the session's available models
 * @param outcome - the result of `computeModelExposure`
 * @returns the issue messages; empty when there are none
 */
function collectExposureIssues(
  config: ProxyConfig,
  models: readonly Model<Api>[],
  outcome: ModelExposureOutcome
): string[] {
  const issues: string[] = []
  if (models.length === 0) {
    issues.push('No models have auth configured. The proxy will expose 0 models.')
  }
  if (config.modelExposureMode === 'custom') {
    issues.push(...collectCustomModelIssues(config.customModels, models))
  }
  if (!outcome.ok) {
    issues.push(outcome.message)
  }
  return issues
}

/**
 * Returns the custom-mode issues: each custom model that is not an available canonical ID, then
 * an empty custom list.
 *
 * @param customModels - the configured canonical IDs (`provider/model`)
 * @param models - the session's available models
 * @returns the issue messages; empty when there are none
 */
function collectCustomModelIssues(
  customModels: readonly string[],
  models: readonly Model<Api>[]
): string[] {
  const canonicalSet = new Set(models.map((model) => canonicalModelId(model)))
  const issues = customModels
    .filter((canonicalId) => !canonicalSet.has(canonicalId))
    .map((canonicalId) => `Custom model '${canonicalId}' is not available (no auth or unknown).`)
  if (customModels.length === 0) {
    issues.push('Custom mode with empty model list will expose 0 models.')
  }
  return issues
}

/**
 * Returns the `/proxy verify` result: a pass with the exposed count, or the issues as a warning.
 *
 * @param issues - the issue messages
 * @param exposedCount - how many models are exposed
 * @returns the report to notify
 */
function formatVerifyReport(issues: readonly string[], exposedCount: number): Report {
  if (issues.length === 0) {
    return {
      message: `Verification passed. ${String(exposedCount)} models exposed.`,
      level: 'info'
    }
  }
  return {
    message: `Verification found ${String(issues.length)} issue(s):\n${issues.join('\n')}`,
    level: 'warning'
  }
}
