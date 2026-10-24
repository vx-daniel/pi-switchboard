/**
 * /proxy settings panel: setting items, value cycling, and the overlay UI.
 *
 * @packageDocumentation
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
  MAX_PORT,
  ModelExposureModeSchema,
  type ProxyConfig,
  PublicModelIdModeSchema,
  saveConfigToFile
} from '@vx-daniel/pi-switchboard/config'
import { proxyLogger } from '@vx-daniel/pi-switchboard/logging'

import { buildModelSelectorSubmenu } from './model-selector'
import { type ProxyState, tokenPreview } from './state'
import { maybeAutoSyncZed } from './zed-sync'

/** Rows visible in the settings list before it scrolls. */
const SETTINGS_PANEL_VISIBLE_ROWS = 12
/** Random bytes in a generated auth token (rendered as hex, so twice as many characters). */
const AUTH_TOKEN_BYTES = 16
/** Radix for rendering token bytes as hex. */
const HEX_RADIX = 16
/** Hex characters per byte. */
const HEX_BYTE_WIDTH = 2

/** Logger for settings changes made in the panel. */
const settingsLogger = proxyLogger('extension', 'settings')

// --- Dynamic descriptions ---

/** Description shown for each public model ID mode. */
const ID_MODE_DESCRIPTIONS: Record<string, string> = {
  'collision-prefixed': 'Short names; adds provider/ prefix only when models collide',
  'universal': 'Short names only; fails if any model name is shared by two providers',
  'always-prefixed': 'Always provider/model-id for every model'
}

/** Description shown for each model exposure mode. */
const EXPOSURE_MODE_DESCRIPTIONS: Record<string, string> = {
  scoped: "Expose models from pi's configured auth (default)",
  all: 'Expose all registered models, including those without auth',
  custom: 'Expose only manually selected models'
}

/**
 * Returns the description for the configured public model ID mode.
 *
 * @param config - the current proxy config
 * @returns the description, or an empty string for an unknown mode
 */
function idModeDescription(config: ProxyConfig): string {
  return ID_MODE_DESCRIPTIONS[config.publicModelIdMode] ?? ''
}

/**
 * Returns the description for the configured model exposure mode.
 *
 * @param config - the current proxy config
 * @returns the description, or an empty string for an unknown mode
 */
function exposureModeDescription(config: ProxyConfig): string {
  return EXPOSURE_MODE_DESCRIPTIONS[config.modelExposureMode] ?? ''
}

/**
 * Returns the "Select models" row description, which depends on the exposure mode.
 *
 * @param config - the current proxy config
 * @returns how to open the selector in custom mode, otherwise how to reach custom mode
 */
function customModelsDescription(config: ProxyConfig): string {
  if (config.modelExposureMode === 'custom') return 'Press Enter to open model selector'
  return "Switch exposure mode to 'custom' to select models"
}

/**
 * Returns the auth setting's state.
 *
 * @remarks
 * `invalid` when `authToken` in proxy-config.json is not a string, which the proxy refuses to
 * start with (#82), not `disabled`, which would read as auth off.
 *
 * @param config - the current proxy config
 * @param invalid - whether the file's `authToken` is invalid; read from the file by default
 * @returns `invalid`, `enabled`, or `disabled`
 */
function authDisplay(config: ProxyConfig, invalid = configFileAuthTokenInvalid()): string {
  if (invalid) return 'invalid'
  return config.authToken.length > 0 ? 'enabled' : 'disabled'
}

/**
 * Returns the auth row description: the invalid-token warning, a token preview, or what enabling
 * does.
 *
 * @param config - the current proxy config
 * @param invalid - whether the file's `authToken` is invalid; read from the file by default
 * @returns the description
 */
function authDescription(config: ProxyConfig, invalid = configFileAuthTokenInvalid()): string {
  if (invalid) {
    return 'authToken in proxy-config.json is not a string: the proxy refuses to start. Enable to set a new token'
  }
  if (config.authToken.length > 0) {
    return `Token: ${tokenPreview(config.authToken)} (use /proxy token to copy)`
  }
  return 'Require bearer token for all requests'
}

/**
 * Builds the auth row from one read of the config file.
 *
 * @param config - the current proxy config
 * @returns the auth setting item
 */
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

/**
 * Returns the "Select models" display value.
 *
 * @param config - the current proxy config
 * @returns `n/a` outside custom mode, otherwise the selected count or `(none)`
 */
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
  'docsUi': (config: ProxyConfig) => (config.docsUi ? 'on' : 'off'),
  'stats': (config: ProxyConfig) => (config.stats ? 'on' : 'off'),
  'maxBodySizeMb': (config: ProxyConfig) => `${String(config.maxBodySizeMb)} MB`,
  'upstreamTimeoutSec': (config: ProxyConfig) => `${String(config.upstreamTimeoutSec)}s`,
  'logLevel': (config: ProxyConfig) => config.logLevel,
  'publicModelIdMode': (config: ProxyConfig) => config.publicModelIdMode,
  'modelExposureMode': (config: ProxyConfig) => config.modelExposureMode,
  'customModels': customModelsDisplay,
  'zed.autoSync': (config: ProxyConfig) => (config.zed.autoSync ? 'on' : 'off'),
  'zed.providerName': (config: ProxyConfig) => config.zed.providerName
} satisfies Record<string, (config: ProxyConfig) => string>

/** ID of a panel setting. */
type SettingId = keyof typeof SETTING_DISPLAY_VALUES

/**
 * Checks that `id` names a panel setting.
 *
 * @param id - the setting ID from the list
 * @returns whether `id` is a {@link SettingId}
 */
function isSettingId(id: string): id is SettingId {
  return Object.hasOwn(SETTING_DISPLAY_VALUES, id)
}

/**
 * Returns the display value for a setting after it has been applied.
 *
 * @param config - the reloaded proxy config
 * @param id - the setting ID
 * @returns the display value, or an empty string for an unknown ID
 */
function getDisplayValue(config: ProxyConfig, id: string): string {
  return isSettingId(id) ? SETTING_DISPLAY_VALUES[id](config) : ''
}

/**
 * Builds the server rows: lifetime, host, port, auth, remote images, body size, timeout and log
 * level.
 *
 * @param config - the current proxy config
 * @returns the server setting items
 */
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
      description:
        'Fetch remote image URLs server-side and inline them; public hosts only (the proxy makes requests for its clients)',
      currentValue: config.remoteImages ? 'on' : 'off',
      values: ['off', 'on']
    },
    {
      id: 'docsUi',
      label: 'Docs UI',
      description:
        'Serve the Swagger UI docs page at /docs, without proxy auth; its scripts load from a CDN',
      currentValue: config.docsUi ? 'on' : 'off',
      values: ['off', 'on']
    },
    {
      id: 'stats',
      label: 'Stats',
      description:
        'Keep per-minute traffic stats (counts and timings, never content) in pi-switchboard-stats.sqlite, for the console',
      currentValue: config.stats ? 'on' : 'off',
      values: ['on', 'off']
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

/**
 * Builds the panel's rows from the state's config (and, for auth, the config file).
 *
 * @param state - the extension state; the model selector submenu also uses it
 * @returns every setting item, in panel order
 */
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
 * Updates, in place, the descriptions that depend on current values: ID mode, exposure mode,
 * "Select models" and auth.
 *
 * @param items - the panel's setting items
 * @param config - the reloaded proxy config
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

/**
 * Parses a value such as `50 MB` or `60s` to its leading positive integer.
 *
 * @param value - the selected value
 * @returns the integer, or undefined when it is not a positive integer
 */
function parsePositiveInt(value: string): number | undefined {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

/**
 * Generates a random auth token of {@link AUTH_TOKEN_BYTES} bytes as lowercase hex.
 *
 * @returns the token
 */
function generateAuthToken(): string {
  const bytes = new Uint8Array(AUTH_TOKEN_BYTES)
  crypto.getRandomValues(bytes)
  return Array.from(bytes)
    .map((byte) => byte.toString(HEX_RADIX).padStart(HEX_BYTE_WIDTH, '0'))
    .join('')
}

/** Returns the config with a newly selected setting value applied. */
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
  'docsUi': (config, value) => ({ ...config, docsUi: value === 'on' }),
  'stats': (config, value) => ({ ...config, stats: value === 'on' }),
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

/**
 * Checks that `id` names a setting with an entry in {@link CONFIG_UPDATERS}.
 *
 * @param id - the setting ID
 * @returns whether `id` has a config updater
 */
function isConfigUpdaterId(id: string): id is keyof typeof CONFIG_UPDATERS {
  return Object.hasOwn(CONFIG_UPDATERS, id)
}

/**
 * Applies a setting change, saves it, and reloads the config.
 *
 * @remarks
 * Enabling auth generates a token only when none is set. An unknown ID changes nothing: it is
 * logged and the config file is not written.
 *
 * @param state - the extension state; its config is replaced by the reloaded file
 * @param id - the setting ID
 * @param value - the newly selected value
 * @returns the newly generated auth token when enabling auth created one, otherwise undefined
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
    // Nothing changes, so nothing is saved, and the one warning says so (#95).
    settingsLogger.warn('Unknown setting {settingId}; ignored', { settingId: id })
    return undefined
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

/**
 * Opens the settings panel as an overlay; each change is applied, saved and followed by Zed
 * auto-sync.
 *
 * @param state - the extension state; its config is reloaded from the file first
 * @param context - the command context, used for the overlay and notifications
 */
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

          // Not awaited, so the panel redraws at once; it logs its own failures and never rejects.
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
