/**
 * /proxy settings panel: setting items, value cycling, and the overlay UI.
 */

import { type ExtensionCommandContext, getSettingsListTheme } from '@earendil-works/pi-coding-agent'
import { Container, type SettingItem, SettingsList, Text } from '@earendil-works/pi-tui'
import { getLogLevels, isLogLevel } from '@logtape/logtape'
import {
  configFileAuthTokenInvalid,
  getConfigPath,
  isModelExposureMode,
  isPublicModelIdMode,
  LifetimeSchema,
  loadConfigFromFile,
  ModelExposureModeSchema,
  type ProxyConfig,
  PublicModelIdModeSchema,
  saveConfigToFile
} from '@vx-daniel/pi-openai-proxy/config'
import { proxyLogger } from '@vx-daniel/pi-openai-proxy/logging'

import { buildModelSelectorSubmenu } from './model-selector'
import type { ProxyState } from './state'
import { maybeAutoSyncZed } from './zed-sync'

/** Rows visible in the settings list before it scrolls. */
const SETTINGS_PANEL_VISIBLE_ROWS = 12
/** Highest valid TCP port. */
const MAX_PORT = 65535
/** Random bytes in a generated auth token (rendered as hex, so twice as many characters). */
const AUTH_TOKEN_BYTES = 16
const HEX_RADIX = 16
/** Hex characters per byte. */
const HEX_BYTE_WIDTH = 2
/** Token characters shown in the auth setting description. */
const AUTH_TOKEN_PREVIEW_LENGTH = 8

const settingsLogger = proxyLogger('extension', 'settings')

// --- Dynamic descriptions ---

const ID_MODE_DESCRIPTIONS: Record<string, string> = {
  'collision-prefixed': 'Short names; adds provider/ prefix only when models collide',
  'universal': 'Short names only; fails if any model name is shared by two providers',
  'always-prefixed': 'Always provider/model-id for every model'
}

const EXPOSURE_MODE_DESCRIPTIONS: Record<string, string> = {
  scoped: "Expose models from pi's configured auth (default)",
  all: 'Expose all registered models, including those without auth',
  custom: 'Expose only manually selected models'
}

function idModeDescription(config: ProxyConfig): string {
  return ID_MODE_DESCRIPTIONS[config.publicModelIdMode] ?? ''
}

function exposureModeDescription(config: ProxyConfig): string {
  return EXPOSURE_MODE_DESCRIPTIONS[config.modelExposureMode] ?? ''
}

function customModelsDescription(config: ProxyConfig): string {
  if (config.modelExposureMode === 'custom') return 'Press Enter to open model selector'
  return "Switch exposure mode to 'custom' to select models"
}

/**
 * The auth setting's state: `invalid` when `authToken` in proxy-config.json is not a string, which
 * the proxy refuses requests for (#82), not `disabled`, which would read as auth off.
 */
function authDisplay(config: ProxyConfig, invalid = configFileAuthTokenInvalid()): string {
  if (invalid) return 'invalid'
  return config.authToken.length > 0 ? 'enabled' : 'disabled'
}

function authDescription(config: ProxyConfig, invalid = configFileAuthTokenInvalid()): string {
  if (invalid) {
    return 'authToken in proxy-config.json is not a string: every request is refused. Enable to set a new token'
  }
  if (config.authToken.length > 0) {
    return `Token: ${config.authToken.slice(0, AUTH_TOKEN_PREVIEW_LENGTH)}... (use /proxy show to copy)`
  }
  return 'Require bearer token for all requests'
}

/** The auth row, from one read of the config file. */
function authSettingItem(config: ProxyConfig): SettingItem {
  const invalid = configFileAuthTokenInvalid()
  return {
    id: 'authToken',
    label: 'Proxy auth',
    description: authDescription(config, invalid),
    currentValue: authDisplay(config, invalid),
    // Enter moves to the first value when the current one is not listed. While the token is
    // invalid, that must be `enabled` (a fresh token), never `disabled`, which turns auth off (#82).
    values: invalid ? ['enabled', 'disabled'] : ['disabled', 'enabled']
  }
}

function customModelsDisplay(config: ProxyConfig): string {
  if (config.modelExposureMode !== 'custom') return 'n/a'
  return config.customModels.length > 0
    ? `${String(config.customModels.length)} selected`
    : '(none)'
}

// --- Display values ---

/** Display value for each setting, derived from the current config. */
const SETTING_DISPLAY_VALUES = {
  'lifetime': (config: ProxyConfig) => config.lifetime,
  'host': (config: ProxyConfig) => config.host,
  'port': (config: ProxyConfig) => String(config.port),
  'authToken': (config: ProxyConfig) => authDisplay(config),
  'remoteImages': (config: ProxyConfig) => (config.remoteImages ? 'on' : 'off'),
  'maxBodySizeMb': (config: ProxyConfig) => `${String(config.maxBodySizeMb)} MB`,
  'upstreamTimeoutSec': (config: ProxyConfig) => `${String(config.upstreamTimeoutSec)}s`,
  'logLevel': (config: ProxyConfig) => config.logLevel,
  'publicModelIdMode': (config: ProxyConfig) => config.publicModelIdMode,
  'modelExposureMode': (config: ProxyConfig) => config.modelExposureMode,
  'customModels': customModelsDisplay,
  'zed.autoSync': (config: ProxyConfig) => (config.zed.autoSync ? 'on' : 'off'),
  'zed.providerName': (config: ProxyConfig) => config.zed.providerName
} satisfies Record<string, (config: ProxyConfig) => string>

type SettingId = keyof typeof SETTING_DISPLAY_VALUES

function isSettingId(id: string): id is SettingId {
  return Object.hasOwn(SETTING_DISPLAY_VALUES, id)
}

/**
 * Get the display value for a setting after it has been applied.
 */
function getDisplayValue(config: ProxyConfig, id: string): string {
  return isSettingId(id) ? SETTING_DISPLAY_VALUES[id](config) : ''
}

function serverSettingItems(config: ProxyConfig): SettingItem[] {
  return [
    {
      id: 'lifetime',
      label: 'Lifetime',
      description: 'detached = background daemon, session = dies when pi exits',
      currentValue: config.lifetime,
      values: [...LifetimeSchema.options]
    },
    {
      id: 'host',
      label: 'Bind address',
      description: 'Network interface (127.0.0.1 = local only, 0.0.0.0 = all)',
      currentValue: config.host,
      values: ['127.0.0.1', '0.0.0.0']
    },
    {
      id: 'port',
      label: 'Port',
      description: 'HTTP port for the proxy',
      currentValue: String(config.port),
      values: ['4141', '8080', '3000', '9090']
    },
    authSettingItem(config),
    {
      id: 'remoteImages',
      label: 'Remote images',
      description: 'Allow remote image URL fetching (security risk if exposed)',
      currentValue: config.remoteImages ? 'on' : 'off',
      values: ['off', 'on']
    },
    {
      id: 'maxBodySizeMb',
      label: 'Max body size',
      description: 'Maximum request body in MB',
      currentValue: `${String(config.maxBodySizeMb)} MB`,
      values: ['10 MB', '50 MB', '100 MB', '200 MB']
    },
    {
      id: 'upstreamTimeoutSec',
      label: 'Upstream timeout',
      description: 'Max seconds the upstream provider may send nothing before the call is aborted',
      currentValue: `${String(config.upstreamTimeoutSec)}s`,
      values: ['30s', '60s', '120s', '300s']
    },
    {
      id: 'logLevel',
      label: 'Log level',
      description: 'Lowest level the proxy logs (also the extension log, on next pi start)',
      currentValue: config.logLevel,
      values: [...getLogLevels()]
    }
  ]
}

/** The panel's rows, built from the state's config (and, for auth, the config file). */
export function buildSettingItems(state: ProxyState): SettingItem[] {
  const { config } = state
  return [
    ...serverSettingItems(config),
    // --- Model exposure ---
    {
      id: 'publicModelIdMode',
      label: 'Model ID format',
      description: idModeDescription(config),
      currentValue: config.publicModelIdMode,
      values: [...PublicModelIdModeSchema.options]
    },
    {
      id: 'modelExposureMode',
      label: 'Exposure mode',
      description: exposureModeDescription(config),
      currentValue: config.modelExposureMode,
      values: [...ModelExposureModeSchema.options]
    },
    {
      id: 'customModels',
      label: 'Select models',
      description: customModelsDescription(config),
      currentValue: customModelsDisplay(config),
      ...(config.modelExposureMode === 'custom'
        ? {
            submenu: (_currentValue: string, done: (selectedValue?: string) => void) =>
              buildModelSelectorSubmenu(state, done)
          }
        : {})
    },
    // --- Zed sync ---
    {
      id: 'zed.autoSync',
      label: 'Zed auto-sync',
      description: 'Sync models to Zed settings.json when config changes',
      currentValue: config.zed.autoSync ? 'on' : 'off',
      values: ['off', 'on']
    },
    {
      id: 'zed.providerName',
      label: 'Zed provider name',
      description: "Provider label in Zed's openai_compatible section",
      currentValue: config.zed.providerName,
      values: ['Pi Proxy']
    }
  ]
}

/**
 * Update descriptions on items that change dynamically based on the current value.
 */
export function refreshDescriptions(items: SettingItem[], config: ProxyConfig): void {
  for (const settingItem of items) {
    switch (settingItem.id) {
      case 'publicModelIdMode':
        settingItem.description = idModeDescription(config)
        break
      case 'modelExposureMode':
        settingItem.description = exposureModeDescription(config)
        break
      case 'customModels':
        settingItem.description = customModelsDescription(config)
        break
      case 'authToken':
        settingItem.description = authDescription(config)
        break
    }
  }
}

// --- Applying changes ---

function parsePositiveInt(value: string): number | undefined {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function generateAuthToken(): string {
  const bytes = new Uint8Array(AUTH_TOKEN_BYTES)
  crypto.getRandomValues(bytes)
  return Array.from(bytes)
    .map((byte) => byte.toString(HEX_RADIX).padStart(HEX_BYTE_WIDTH, '0'))
    .join('')
}

type ConfigUpdater = (config: ProxyConfig, value: string) => ProxyConfig

/** How a newly selected value changes the config. `authToken` is handled by applySetting. */
const CONFIG_UPDATERS: Record<Exclude<SettingId, 'authToken'>, ConfigUpdater> = {
  'lifetime': (config, value) => ({
    ...config,
    lifetime: value === 'session' ? 'session' : 'detached'
  }),
  'host': (config, value) => ({ ...config, host: value }),
  'port': (config, value) => ({
    ...config,
    port: Math.max(1, Math.min(MAX_PORT, Number.parseInt(value, 10) || config.port))
  }),
  'remoteImages': (config, value) => ({ ...config, remoteImages: value === 'on' }),
  'maxBodySizeMb': (config, value) => {
    const mb = parsePositiveInt(value)
    return mb === undefined ? config : { ...config, maxBodySizeMb: mb }
  },
  'upstreamTimeoutSec': (config, value) => {
    const sec = parsePositiveInt(value)
    return sec === undefined ? config : { ...config, upstreamTimeoutSec: sec }
  },
  'logLevel': (config, value) => (isLogLevel(value) ? { ...config, logLevel: value } : config),
  'publicModelIdMode': (config, value) =>
    isPublicModelIdMode(value) ? { ...config, publicModelIdMode: value } : config,
  'modelExposureMode': (config, value) =>
    isModelExposureMode(value) ? { ...config, modelExposureMode: value } : config,
  // Handled by submenu -- no cycling
  'customModels': (config) => config,
  'zed.autoSync': (config, value) => ({
    ...config,
    zed: { ...config.zed, autoSync: value === 'on' }
  }),
  'zed.providerName': (config, value) =>
    value.length > 0 ? { ...config, zed: { ...config.zed, providerName: value } } : config
}

function isConfigUpdaterId(id: string): id is keyof typeof CONFIG_UPDATERS {
  return Object.hasOwn(CONFIG_UPDATERS, id)
}

/**
 * Apply a setting change, persist it, and reload the config.
 * Returns the newly generated auth token when enabling auth created one.
 */
export function applySetting(state: ProxyState, id: string, value: string): string | undefined {
  let generatedToken: string | undefined
  if (id === 'authToken') {
    if (value === 'disabled') {
      state.config = { ...state.config, authToken: '' }
    } else if (state.config.authToken.length === 0) {
      generatedToken = generateAuthToken()
      state.config = { ...state.config, authToken: generatedToken }
    }
  } else if (isConfigUpdaterId(id)) {
    state.config = CONFIG_UPDATERS[id](state.config, value)
  } else {
    settingsLogger.warn('Unknown setting {settingId}; saving config unchanged', { settingId: id })
  }
  // Only a choice made on the auth row may replace an invalid authToken in the file (#82); any
  // other setting saves the file's value back, so it cannot quietly turn auth off.
  saveConfigToFile(state.config, { replaceInvalidAuthToken: id === 'authToken' })
  state.config = loadConfigFromFile()
  settingsLogger.debug('Saved config to {configPath}', { configPath: getConfigPath() })
  const applied = getDisplayValue(state.config, id)
  if (id === 'authToken') {
    // The token itself is never logged: only whether auth is on, and whether a token was generated.
    settingsLogger.info('Setting authToken changed: proxy auth {applied}', {
      settingId: id,
      applied,
      tokenGenerated: generatedToken !== undefined
    })
  } else if (id === 'customModels') {
    // Each toggle is logged by the model selector; this is the submenu closing.
    settingsLogger.debug('Model selector closed: {applied}', { settingId: id, applied })
  } else if (applied === value) {
    settingsLogger.info('Setting {settingId} changed to {value}', { settingId: id, value })
  } else {
    settingsLogger.warn('Setting {settingId}: value {value} not applied as given; now {applied}', {
      settingId: id,
      value,
      applied
    })
  }
  return generatedToken
}

// --- Panel ---

export async function openSettingsPanel(
  state: ProxyState,
  context: ExtensionCommandContext
): Promise<void> {
  state.config = loadConfigFromFile()

  await context.ui.custom<undefined>(
    (tui, theme, _kb, done) => {
      const container = new Container()
      container.addChild(new Text(theme.fg('accent', theme.bold('Proxy Settings')), 1, 0))
      container.addChild(new Text(theme.fg('dim', getConfigPath()), 1, 0))

      const items = buildSettingItems(state)
      const settingsList = new SettingsList(
        items,
        SETTINGS_PANEL_VISIBLE_ROWS,
        getSettingsListTheme(),
        (id, newValue) => {
          const generatedToken = applySetting(state, id, newValue)
          if (generatedToken !== undefined) {
            context.ui.notify(`Auth token: ${generatedToken}`, 'info')
          }

          // Update display value and descriptions in-place (preserves selection)
          settingsList.updateValue(id, getDisplayValue(state.config, id))
          refreshDescriptions(items, state.config)

          // When exposure mode changes, update the "Select models" item
          if (id === 'modelExposureMode') {
            settingsList.updateValue('customModels', customModelsDisplay(state.config))
          }

          void maybeAutoSyncZed(state, context)
          tui.requestRender()
        },
        () => done(undefined),
        { enableSearch: true }
      )

      container.addChild(settingsList)
      container.addChild(
        new Text(
          theme.fg(
            'dim',
            'Esc: close | Arrow keys: navigate | Space: toggle | Restart proxy to apply'
          ),
          1,
          0
        )
      )

      return {
        render(width: number): string[] {
          return container.render(width)
        },
        invalidate(): void {
          container.invalidate()
        },
        handleInput(data: string): void {
          settingsList.handleInput(data)
          tui.requestRender()
        }
      }
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: 'center',
        width: 80,
        maxHeight: '85%',
        margin: 1
      }
    }
  )
}
