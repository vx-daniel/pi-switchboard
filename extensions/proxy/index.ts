/**
 * Pi extension: /proxy command family with config panel.
 *
 * @remarks
 * Command family:
 *   /proxy            Open settings panel
 *   /proxy start      Start the proxy server
 *   /proxy stop       Stop the proxy server
 *   /proxy restart    Stop, then start the proxy server
 *   /proxy status     Show proxy status
 *   /proxy verify     Validate model exposure config against available models
 *   /proxy models     List all exposed models with their public IDs
 *   /proxy zed-sync   Sync exposed models to Zed settings.json (--dry-run)
 *   /proxy config     Open settings panel (alias)
 *   /proxy show       Summarize current config and exposure policy (token as a preview)
 *   /proxy token      Show the whole proxy auth token
 *   /proxy path       Show config file location
 *   /proxy reset      Restore default settings
 *   /proxy help       Usage line
 *
 * Config schema imported from @vx-daniel/pi-switchboard/config (SSOT).
 * Model-exposure engine imported from @vx-daniel/pi-switchboard/exposure.
 *
 * pi loads this directory as one extension through its index.ts; the sibling modules are
 * imported here and are not discovered as separate extensions.
 *
 * @packageDocumentation
 */

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import {
  DEFAULT_CONFIG,
  getConfigPath,
  loadConfigFromFile,
  saveConfigToFile
} from '@vx-daniel/pi-switchboard/config'
import { configureFileLogging, proxyLogger } from '@vx-daniel/pi-switchboard/logging'

import {
  refreshStatus,
  restartProxy,
  showStatus,
  startProxy,
  stopProxy,
  stopSessionProcess
} from './process'
import { showConfig, showModels, showToken, verifyExposure } from './reports'
import { openSettingsPanel } from './settings-panel'
import { createProxyState, type ProxyState, useModelRegistry } from './state'
import { handleZedSync, maybeAutoSyncZed } from './zed-sync'

/** /proxy subcommand names offered as argument completions. */
const SUBCOMMANDS = [
  'start',
  'stop',
  'restart',
  'status',
  'verify',
  'models',
  'zed-sync',
  'config',
  'show',
  'token',
  'path',
  'reset',
  'help'
]
/** Logger for the extension's lifecycle and command dispatch. */
const extensionLogger = proxyLogger('extension')

/** Usage line shown by `/proxy help` and for an unknown subcommand. */
const USAGE =
  '/proxy [start|stop|restart|status|verify|models|zed-sync|config|show|token|path|reset|help]'

/** Handler for one /proxy subcommand; `args` is the full argument string, subcommand included. */
type SubcommandHandler = (
  state: ProxyState,
  context: ExtensionCommandContext,
  args: string
) => Promise<void> | void

/** Subcommands other than the settings panel (`""` and `config`). */
const SUBCOMMAND_HANDLERS: Record<string, SubcommandHandler> = {
  'start': startProxy,
  'stop': stopProxy,
  'restart': restartProxy,
  'status': showStatus,
  'verify': verifyExposure,
  'models': showModels,
  'zed-sync': handleZedSync,
  'show': showConfig,
  'token': showToken,
  'path': (_state, context) => {
    context.ui.notify(getConfigPath(), 'info')
  },
  'reset': (state, context) => {
    state.config = { ...DEFAULT_CONFIG }
    // A reset is an explicit choice: it may replace an invalid authToken with the default, off (#82).
    saveConfigToFile(state.config, { replaceInvalidAuthToken: true })
    extensionLogger.info('Proxy settings reset to defaults and saved to {configPath}', {
      configPath: getConfigPath()
    })
    context.ui.notify('Proxy settings reset to defaults', 'info')
  },
  'help': (_state, context) => {
    context.ui.notify(USAGE, 'info')
  }
}

/**
 * Opens the settings panel, or warns and points at `/proxy show` when pi has no interactive UI.
 *
 * @param state - the extension state
 * @param context - the command context, used for the UI
 */
async function openSettingsPanelIfInteractive(
  state: ProxyState,
  context: ExtensionCommandContext
): Promise<void> {
  if (!context.hasUI) {
    extensionLogger.warn('Settings panel requested without an interactive UI')
    context.ui.notify('/proxy requires interactive mode. Use /proxy show instead.', 'warning')
    return
  }
  await openSettingsPanel(state, context)
}

/**
 * Registers the /proxy command and the session lifecycle hooks with pi.
 *
 * @remarks
 * On `session_start` it loads the config, runs Zed auto-sync if enabled, and refreshes the status
 * line; on `session_shutdown` it stops a session-tied proxy.
 *
 * @param pi - the pi extension API (only `on` and `registerCommand` are used)
 */
export default function proxyExtension(pi: Pick<ExtensionAPI, 'on' | 'registerCommand'>): void {
  // Opt-in logging: the extension writes nothing unless PI_PROXY_EXTENSION_LOG_FILE names a file,
  // because console output would corrupt pi's terminal UI.
  const logFile = process.env.PI_PROXY_EXTENSION_LOG_FILE
  if (logFile !== undefined && logFile.length > 0) {
    const level = loadConfigFromFile().logLevel
    configureFileLogging(logFile, level)
    extensionLogger.info('Extension file logging enabled at level {level}', { level, logFile })
  }

  // This file lives at <package root>/extensions/proxy/index.ts.
  const extensionDir = dirname(fileURLToPath(import.meta.url))
  const state = createProxyState(resolve(extensionDir, '..', '..'))

  // --- Lifecycle ---

  pi.on('session_start', async (_event, context) => {
    extensionLogger.info('Session started; loading config from {configPath}', {
      configPath: getConfigPath()
    })
    await useModelRegistry(state, context)
    state.config = loadConfigFromFile()
    extensionLogger.debug(
      'Config loaded: lifetime {lifetime}, {host}:{port}, exposure {exposure}',
      {
        lifetime: state.config.lifetime,
        host: state.config.host,
        port: state.config.port,
        exposure: state.config.modelExposureMode,
        logLevel: state.config.logLevel
      }
    )
    await maybeAutoSyncZed(state, context)
    await refreshStatus(state, context)
  })

  pi.on('session_shutdown', async () => {
    extensionLogger.info('Session shutting down')
    stopSessionProcess(state)
  })

  // --- Command family ---

  pi.registerCommand('proxy', {
    description: 'Manage the OpenAI-compatible proxy',
    getArgumentCompletions: (prefix) => {
      const trimmed = prefix.trimStart()
      const matches = SUBCOMMANDS.filter((subcommand) => subcommand.startsWith(trimmed))
      return matches.length > 0
        ? matches.map((subcommand) => ({ value: subcommand, label: subcommand }))
        : null
    },
    handler: async (args, context) => {
      await useModelRegistry(state, context)
      const sub = args.trim().split(/\s+/)[0] ?? ''
      extensionLogger.debug('Dispatching /proxy subcommand {subcommand}', {
        subcommand: sub === '' ? '(panel)' : sub
      })

      if (sub === '' || sub === 'config') {
        await openSettingsPanelIfInteractive(state, context)
        return
      }
      const run = Object.hasOwn(SUBCOMMAND_HANDLERS, sub) ? SUBCOMMAND_HANDLERS[sub] : undefined
      if (run === undefined) {
        extensionLogger.warn('Unknown /proxy subcommand {subcommand}', { subcommand: sub })
        context.ui.notify(USAGE, 'warning')
        return
      }
      await run(state, context, args)
    }
  })
}
