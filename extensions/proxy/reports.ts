/**
 * Read-only reports: /proxy show, /proxy models, /proxy verify.
 */

import type { Api, Model } from '@earendil-works/pi-ai'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import {
  configFileAuthTokenInvalid,
  loadConfigFromFile,
  type ProxyConfig
} from '@vx-daniel/pi-openai-proxy/config'
import {
  computeModelExposure,
  type ExposedModel,
  type ModelExposureOutcome
} from '@vx-daniel/pi-openai-proxy/exposure'
import { proxyLogger } from '@vx-daniel/pi-openai-proxy/logging'

import {
  buildExposureConfig,
  getSessionAvailableModels,
  getSessionEnabledModels,
  type ProxyState
} from './state'

/** How many exposed public IDs `/proxy show` lists before summarizing the rest. */
const EXPOSED_PREVIEW_COUNT = 5

const reportsLogger = proxyLogger('extension', 'reports')

// --- /proxy show ---

/** `/proxy show`: reloads the config and shows the server settings and exposure policy. */
export async function showConfig(state: ProxyState, context: ExtensionContext): Promise<void> {
  context.ui.notify(await buildConfigReport(state), 'info')
}

/** Reloads the config into `state` and returns the `/proxy show` text. */
export async function buildConfigReport(state: ProxyState): Promise<string> {
  state.config = loadConfigFromFile()
  const { config } = state
  const enabledModels =
    config.modelExposureMode === 'scoped' ? await getSessionEnabledModels(state) : undefined
  const models = getSessionAvailableModels(state)
  const outcome = computeModelExposure(models, await buildExposureConfig(state))
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
 * The `/proxy show` auth field: the token when one is set, or `invalid` when `authToken` in the
 * file is not a string, which the proxy refuses requests for (#82) rather than turning auth off.
 */
function authSummary(config: ProxyConfig): string {
  if (configFileAuthTokenInvalid()) {
    return 'invalid (authToken in proxy-config.json is not a string: every request is refused)'
  }
  return config.authToken.length > 0 ? `enabled (token: ${config.authToken})` : 'disabled'
}

/** Returns the `/proxy show` server-settings fields; the auth token is shown when one is set. */
function formatServerSettings(config: ProxyConfig): string[] {
  const authDisplay = authSummary(config)
  return [
    `lifetime: ${config.lifetime}`,
    `host: ${config.host}`,
    `port: ${String(config.port)}`,
    `auth: ${authDisplay}`,
    `remote images: ${String(config.remoteImages)}`,
    `max body: ${String(config.maxBodySizeMb)} MB`,
    `timeout: ${String(config.upstreamTimeoutSec)}s`
  ]
}

/**
 * Returns the `/proxy show` exposure-policy fields: ID and exposure mode, then the pi pattern
 * count, custom model count and provider prefixes when there are any. `enabledModels` is pi's
 * `enabledModels` setting, read only in scoped mode.
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
  return lines
}

/**
 * Returns the `/proxy show` exposure-result fields: the exposed public IDs and any unresolved
 * scope patterns, or the exposure error.
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
  return lines
}

/** Returns the `exposed:` field: the first EXPOSED_PREVIEW_COUNT public IDs and how many more. */
function formatExposedPreview(exposedModels: readonly ExposedModel[]): string {
  if (exposedModels.length === 0) return 'exposed: none'
  const preview = exposedModels.slice(0, EXPOSED_PREVIEW_COUNT).map((model) => model.publicId)
  const hidden = exposedModels.length - EXPOSED_PREVIEW_COUNT
  const suffix = hidden > 0 ? ` (+${String(hidden)} more)` : ''
  return `exposed: ${preview.join(', ')}${suffix}`
}

// --- /proxy models ---

/** `/proxy models`: reloads the config and lists every exposed model by provider. */
export async function showModels(state: ProxyState, context: ExtensionContext): Promise<void> {
  const report = await buildModelsReport(state)
  context.ui.notify(report.message, report.level)
}

/** Reloads the config into `state` and returns the `/proxy models` result. */
export async function buildModelsReport(state: ProxyState): Promise<Report> {
  state.config = loadConfigFromFile()
  const models = getSessionAvailableModels(state)
  const outcome = computeModelExposure(models, await buildExposureConfig(state))

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

/** `/proxy verify`: reloads the config and reports anything that would expose fewer models. */
export async function verifyExposure(state: ProxyState, context: ExtensionContext): Promise<void> {
  const report = await buildVerifyReport(state)
  context.ui.notify(report.message, report.level)
}

/** Reloads the config into `state` and returns the `/proxy verify` result. */
export async function buildVerifyReport(state: ProxyState): Promise<Report> {
  state.config = loadConfigFromFile()
  const { config } = state
  const models = getSessionAvailableModels(state)
  // Run the full exposure computation to catch ID/prefix errors
  const outcome = computeModelExposure(models, await buildExposureConfig(state))
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
 */
function collectCustomModelIssues(
  customModels: readonly string[],
  models: readonly Model<Api>[]
): string[] {
  const canonicalSet = new Set(models.map((model) => `${model.provider}/${model.id}`))
  const issues = customModels
    .filter((canonicalId) => !canonicalSet.has(canonicalId))
    .map((canonicalId) => `Custom model '${canonicalId}' is not available (no auth or unknown).`)
  if (customModels.length === 0) {
    issues.push('Custom mode with empty model list will expose 0 models.')
  }
  return issues
}

/** Returns the `/proxy verify` result: a pass with the exposed count, or the issues as a warning. */
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
