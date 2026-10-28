/**
 * Zed sync: push exposed models into Zed's settings.json.
 *
 * @packageDocumentation
 */

import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import { loadConfigFromFile } from '@vx-daniel/pi-switchboard/config'
import { computeModelExposure } from '@vx-daniel/pi-switchboard/exposure'
import { proxyLogger } from '@vx-daniel/pi-switchboard/logging'
import { syncToZed, type ZedSyncOptions } from '@vx-daniel/pi-switchboard/sync/zed'

import { buildExposureConfig, getSessionAvailableModels, type ProxyState } from './state'

/** Logger for `/proxy zed-sync` and Zed auto-sync. */
const zedSyncLogger = proxyLogger('extension', 'zed-sync')

/**
 * Runs Zed sync for the session's exposed models. Shared by the command and auto-sync.
 *
 * @param state - the extension state; its config supplies the proxy URL and Zed provider name
 * @param dryRun - whether to report the changes without writing Zed's settings.json
 * @returns `ok` and a user-facing message: the sync summary and settings path, or the error
 * @throws Error when the session's model registry is not available yet, or the file system error
 *   when Zed's settings.json cannot be read or written
 */
async function runZedSync(
  state: ProxyState,
  dryRun: boolean
): Promise<{ ok: boolean; message: string }> {
  const available = getSessionAvailableModels(state)
  const outcome = computeModelExposure(
    available,
    await buildExposureConfig(state),
    getSupportedThinkingLevels
  )
  if (!outcome.ok) {
    return { ok: false, message: `Model exposure error: ${outcome.message}` }
  }

  if (outcome.models.length === 0) {
    return { ok: false, message: 'No models exposed. Nothing to sync.' }
  }

  const syncOptions: ZedSyncOptions = {
    providerName: state.config.zed.providerName,
    apiUrl: `http://${state.config.host}:${String(state.config.port)}/v1`,
    dryRun
  }

  zedSyncLogger.debug('Syncing {modelCount} models to Zed as {providerName} (dry run {dryRun})', {
    modelCount: outcome.models.length,
    providerName: syncOptions.providerName,
    apiUrl: syncOptions.apiUrl,
    dryRun
  })
  const result = syncToZed(outcome.models, syncOptions)

  if (!result.ok) {
    return { ok: false, message: result.error ?? 'Zed sync failed' }
  }

  // A dry run's summary already says so: `syncToZed` starts it with "[dry-run]" (#92).
  return { ok: true, message: `${result.summary} (${result.configPath})` }
}

/**
 * Handles `/proxy zed-sync`: reloads the config, syncs, and notifies the result.
 *
 * @param state - the extension state
 * @param context - the extension context, used for the notification
 * @param args - the /proxy argument string; `--dry-run` anywhere in it makes a dry run
 * @throws Error when the session's model registry is not available yet, or the file system error
 *   when Zed's settings.json cannot be read or written
 */
export async function handleZedSync(
  state: ProxyState,
  context: ExtensionContext,
  args: string
): Promise<void> {
  state.config = loadConfigFromFile()
  const dryRun = args.includes('--dry-run')
  const result = await runZedSync(state, dryRun)
  if (result.ok) {
    zedSyncLogger.info('Zed sync succeeded: {message}', { message: result.message, dryRun })
  } else {
    zedSyncLogger.error('Zed sync failed: {message}', { message: result.message, dryRun })
  }
  context.ui.notify(`Zed sync: ${result.message}`, result.ok ? 'info' : 'error')
}

/**
 * Syncs to Zed when `zed.autoSync` is on. Called at session start and after the settings panel
 * saves a change.
 *
 * @remarks
 * A failure, thrown or reported, is logged but not shown in the UI, so auto-sync does not
 * interrupt the user. It never rejects: the settings panel does not wait for it (#111), and at
 * session start a throw would stop the status refresh that follows.
 *
 * @param state - the extension state
 * @param context - the extension context, used for the success notification
 */
export async function maybeAutoSyncZed(
  state: ProxyState,
  context: ExtensionContext
): Promise<void> {
  if (!state.config.zed.autoSync) {
    zedSyncLogger.debug('Zed auto-sync disabled; skipping')
    return
  }
  let result: { ok: boolean; message: string }
  try {
    result = await runZedSync(state, false)
  } catch (error: unknown) {
    zedSyncLogger.warn('Zed auto-sync failed: {error}', { error })
    return
  }
  if (result.ok) {
    zedSyncLogger.info('Zed auto-sync succeeded: {message}', { message: result.message })
    context.ui.notify(`Zed auto-sync: ${result.message}`, 'info')
  } else {
    // Silent in the UI on failure during auto-sync -- don't spam the user
    zedSyncLogger.warn('Zed auto-sync failed: {message}', { message: result.message })
  }
}
