/**
 * Shared mutable state for the /proxy extension, plus model registry access.
 *
 * @packageDocumentation
 */

import type { ChildProcess } from 'node:child_process'

import type { Api, Model } from '@earendil-works/pi-ai'
import {
  type ExtensionContext,
  type ModelRegistry,
  SettingsManager
} from '@earendil-works/pi-coding-agent'
import { loadConfigFromFile, type ProxyConfig } from '@vx-daniel/pi-openai-proxy/config'
import type { ModelExposureConfig } from '@vx-daniel/pi-openai-proxy/exposure'

/** Mutable state shared by every /proxy handler for the lifetime of the extension. */
export interface ProxyState {
  config: ProxyConfig
  sessionProcess: ChildProcess | undefined
  modelRegistry: ModelRegistry | undefined
  readonly settingsManager: SettingsManager
  /** Package root: the directory holding package.json, dist/, and extensions/. */
  readonly packageRoot: string
}

/**
 * Creates the extension state with the config loaded from disk and no session process.
 *
 * @param packageRoot - the package root: the directory holding package.json, dist/, and
 *   extensions/
 * @returns a fresh state; `modelRegistry` stays undefined until {@link useModelRegistry} runs
 */
export function createProxyState(packageRoot: string): ProxyState {
  return {
    config: loadConfigFromFile(),
    sessionProcess: undefined,
    modelRegistry: undefined,
    settingsManager: SettingsManager.create(process.cwd()),
    packageRoot
  }
}

/**
 * Stores the session's model registry on the state and refreshes it without network access.
 *
 * @remarks
 * Pi 1.x does not let an extension build its own registry (`AuthStorage` and
 * `ModelRegistry.create()` are gone), so every handler that reads models calls this first with
 * its context. The refresh reloads models.json and stored credentials, so a model list taken at
 * session start does not miss a later `/login`.
 *
 * @param state - the extension state to update
 * @param context - the handler's extension context, whose `modelRegistry` is used
 */
export async function useModelRegistry(
  state: ProxyState,
  context: ExtensionContext
): Promise<void> {
  state.modelRegistry = context.modelRegistry
  await state.modelRegistry.refresh({ allowNetwork: false })
}

/**
 * Returns the models pi's live session can use now.
 *
 * @remarks
 * Not the standalone proxy's `getAvailableModels` (`src/pi/registry.ts`), which reads that
 * process's own runtime.
 *
 * @param state - the extension state; {@link useModelRegistry} must have run
 * @returns the session's available models
 * @throws Error when no model registry has been stored yet
 */
export function getSessionAvailableModels(state: ProxyState): Model<Api>[] {
  if (state.modelRegistry === undefined) {
    throw new Error('The model registry is only available once a session has started.')
  }
  return state.modelRegistry.getAvailable()
}

/**
 * Returns pi's `enabledModels` setting, reloaded from disk.
 *
 * @param state - the extension state holding pi's settings manager
 * @returns the enabled model patterns, or undefined when no filter is set
 */
export async function getSessionEnabledModels(
  state: ProxyState
): Promise<readonly string[] | undefined> {
  await state.settingsManager.reload()
  return state.settingsManager.getEnabledModels()
}

/**
 * Builds the model exposure config from the proxy config and pi's `enabledModels` setting.
 *
 * @param state - the extension state holding the current proxy config
 * @returns the exposure config for `computeModelExposure`
 */
export async function buildExposureConfig(state: ProxyState): Promise<ModelExposureConfig> {
  return {
    publicModelIdMode: state.config.publicModelIdMode,
    modelExposureMode: state.config.modelExposureMode,
    enabledModels: await getSessionEnabledModels(state),
    customModels: state.config.customModels,
    providerPrefixes: state.config.providerPrefixes
  }
}

/**
 * Returns the proxy's base URL, without the `/v1` path.
 *
 * @param config - the proxy config whose host and port are used
 * @returns `http://<host>:<port>` from the config
 */
export function proxyUrl(config: ProxyConfig): string {
  return `http://${config.host}:${String(config.port)}`
}
