/**
 * The console's Settings view (#288): every `proxy-config.json` setting a standalone proxy uses,
 * grouped by when a change applies, with the value saved, the value running when a restart is
 * still to apply it, and the flag or env var that wins over the file.
 *
 * @remarks
 * Rendering and the rows it renders, from a {@link SettingsInput}; the editors behind Enter are
 * `src/tui/console-settings.ts`. Aliases and login labels keep their editors in the Models and
 * Accounts views; `lifetime` and `zed` matter only to the pi package and are left out.
 *
 * @packageDocumentation
 */

import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'
import type { CliOverrides, ServerConfig } from '@proxy/config/env'
import { BYTES_PER_MB, type ProxyConfig } from '@proxy/config/schema'
import { firstShown } from '@proxy/tui/panel'
import { highlight, paint, strong } from '@proxy/tui/theme'
import { MS_PER_SECOND } from '@proxy/utils/time'

/** The settings, in the view's order. */
export const SETTING_KEYS = [
  'host',
  'hostOriginGuard',
  'port',
  'maxBodySizeMb',
  'upstreamTimeoutSec',
  'logLevel',
  'remoteImages',
  'responsesApi',
  'docsUi',
  'stats',
  'authToken',
  'publicModelIdMode',
  'modelExposureMode',
  'customModels',
  'providerPrefixes',
  'reserve',
  'loginFallbackOn'
] as const

/** One of the settings the view lists. */
export type SettingKey = (typeof SETTING_KEYS)[number]

/** The view's groups of settings. */
type Section = 'server' | 'features' | 'auth' | 'models' | 'routing'

/** When a change to a setting applies. */
type Applies = 'live' | 'restart'

/** Each group's heading, and when its settings apply. */
const SECTIONS: Readonly<Record<Section, { readonly title: string; readonly applies: Applies }>> = {
  server: { title: 'SERVER', applies: 'restart' },
  features: { title: 'FEATURES', applies: 'restart' },
  auth: { title: 'PROXY AUTH', applies: 'live' },
  models: { title: 'MODELS', applies: 'live' },
  routing: { title: 'ROUTING', applies: 'live' }
}

/** What the heading says about when its settings apply. */
const APPLIES_NOTE: Readonly<Record<Applies, string>> = {
  live: 'applies to the next request',
  restart: 'applies when the server restarts (r)'
}

/** What a setting is, how the view shows it, and what overrides it. */
interface SettingSpec {
  readonly section: Section
  readonly label: string
  /** One or two sentences under the list for the selected setting. */
  readonly help: string
  /**
   * Shows the value the config file holds.
   *
   * @param file - the config file, as loaded
   * @returns the value as the view shows it
   */
  readonly saved: (file: ProxyConfig) => string
  /**
   * Shows the value the server runs with, for a setting read at startup.
   *
   * @param config - the running config
   * @returns the value as the view shows it
   */
  readonly running?: (config: ServerConfig) => string
  /** The flag that sets it, which wins over the file. */
  readonly flag?: string
  /** The env var that sets it, which wins over the file. */
  readonly env?: string
}

/**
 * Shows a switch.
 *
 * @param on - whether it is on
 * @returns `on` or `off`
 */
function onOff(on: boolean): string {
  return on ? 'on' : 'off'
}

/**
 * Shows a list, or `none` when it is empty.
 *
 * @param items - the entries
 * @returns them joined, or `none`
 */
function listed(items: readonly string[]): string {
  return items.length === 0 ? 'none' : items.join(', ')
}

/** Every setting the view lists. */
const SPECS: Readonly<Record<SettingKey, SettingSpec>> = {
  host: {
    section: 'server',
    label: 'Bind address',
    help: 'Where the proxy listens: 127.0.0.1 for this machine only, 0.0.0.0 for every interface.',
    saved: (file) => file.host,
    running: (config) => config.host,
    flag: '--host',
    env: 'PI_SWITCHBOARD_HOST'
  },
  hostOriginGuard: {
    section: 'server',
    label: 'Host/origin guard',
    help: 'Refuse requests a web page could send (a DNS-rebinding Host, another Origin). For a proxy without a token; a token stops web pages anyway.',
    saved: (file) => onOff(file.hostOriginGuard),
    running: (config) => onOff(config.hostOriginGuardEnabled),
    flag: '--host-origin-guard',
    env: 'PI_SWITCHBOARD_HOST_ORIGIN_GUARD'
  },
  port: {
    section: 'server',
    label: 'Port',
    help: 'The TCP port the proxy listens on, 1 to 65535.',
    saved: (file) => String(file.port),
    running: (config) => String(config.port),
    flag: '--port',
    env: 'PI_SWITCHBOARD_PORT'
  },
  maxBodySizeMb: {
    section: 'server',
    label: 'Max request body',
    help: 'The largest request body the proxy reads, 1 to 500 MB; a larger one is refused.',
    saved: (file) => `${String(file.maxBodySizeMb)} MB`,
    running: (config) => `${String(Math.round(config.maxBodySize / BYTES_PER_MB))} MB`,
    flag: '--max-body-size',
    env: 'PI_SWITCHBOARD_MAX_BODY_SIZE'
  },
  upstreamTimeoutSec: {
    section: 'server',
    label: 'Upstream idle timeout',
    help: 'How long a provider may send nothing before the call is aborted, 5 to 600 seconds.',
    saved: (file) => `${String(file.upstreamTimeoutSec)} s`,
    running: (config) => `${String(Math.round(config.upstreamTimeoutMs / MS_PER_SECOND))} s`,
    flag: '--upstream-timeout',
    env: 'PI_SWITCHBOARD_UPSTREAM_TIMEOUT_MS'
  },
  logLevel: {
    section: 'server',
    label: 'Log level',
    help: 'The lowest level the proxy logs, from trace to fatal.',
    saved: (file) => file.logLevel,
    running: (config) => config.logLevel,
    flag: '--log-level',
    env: 'PI_SWITCHBOARD_LOG_LEVEL'
  },
  remoteImages: {
    section: 'features',
    label: 'Remote images',
    help: 'Fetch image URLs for clients and inline them, from public http and https hosts only. Off, a request with one is refused.',
    saved: (file) => onOff(file.remoteImages),
    running: (config) => onOff(config.remoteImagesEnabled),
    flag: '--remote-images',
    env: 'PI_SWITCHBOARD_REMOTE_IMAGES'
  },
  responsesApi: {
    section: 'features',
    label: 'Responses API',
    help: 'Answer the experimental POST /v1/responses.',
    saved: (file) => onOff(file.responsesApi),
    running: (config) => onOff(config.responsesApiEnabled),
    flag: '--responses-api',
    env: 'PI_SWITCHBOARD_RESPONSES_API'
  },
  docsUi: {
    section: 'features',
    label: 'Docs page',
    help: 'Serve Swagger UI at /docs, without proxy auth; its scripts load from a CDN.',
    saved: (file) => onOff(file.docsUi),
    running: (config) => onOff(config.docsUiEnabled),
    flag: '--docs-ui',
    env: 'PI_SWITCHBOARD_DOCS_UI'
  },
  stats: {
    section: 'features',
    label: 'Stats',
    help: 'Keep per-minute traffic stats for the Stats view in pi-switchboard-stats.sqlite: counts, timings, tokens and cost, never content.',
    saved: (file) => onOff(file.stats),
    running: (config) => onOff(config.statsEnabled),
    flag: '--stats',
    env: 'PI_SWITCHBOARD_STATS'
  },
  authToken: {
    section: 'auth',
    label: 'Proxy auth',
    help: 'The bearer token clients must send. Enter opens the proxy auth menu, as p does anywhere.',
    // The view shows whether a token is set, never the token.
    saved: (file) => onOff(file.authToken.length > 0),
    flag: '--auth-token',
    env: 'PI_SWITCHBOARD_AUTH_TOKEN'
  },
  publicModelIdMode: {
    section: 'models',
    label: 'Public model IDs',
    help: 'collision-prefixed adds the provider prefix only where providers share a model name; universal never prefixes; always-prefixed always does.',
    saved: (file) => file.publicModelIdMode
  },
  modelExposureMode: {
    section: 'models',
    label: 'Exposed models',
    help: "scoped serves the models pi's enabledModels selects (every model with a login without one); all serves every model with a login; custom serves the list below.",
    saved: (file) => file.modelExposureMode
  },
  customModels: {
    section: 'models',
    label: 'Custom model list',
    help: 'The models custom exposure serves, as provider/model-id. Other modes ignore it.',
    saved: (file) => {
      const count = `${String(file.customModels.length)} ${file.customModels.length === 1 ? 'model' : 'models'}`
      return file.modelExposureMode === 'custom' ? count : `${count} (custom mode only)`
    }
  },
  providerPrefixes: {
    section: 'models',
    label: 'Provider prefixes',
    help: "The prefix a provider's public model IDs take instead of the provider's name.",
    saved: (file) =>
      listed(
        Object.entries(file.providerPrefixes).map(([provider, prefix]) => `${provider}=${prefix}`)
      )
  },
  reserve: {
    section: 'routing',
    label: 'Quota reserve',
    help: 'The share of each quota window, 0 to 1, a fallback chain leaves free on a login: below it, the chain moves on.',
    saved: (file) =>
      listed(
        Object.entries(file.routing.reserve).map(([login, share]) => `${login} ${String(share)}`)
      )
  },
  loginFallbackOn: {
    section: 'routing',
    label: 'Login fallback',
    help: "The failures that move a request to the next login of the model's provider.",
    saved: (file) => listed(file.routing.logins.fallbackOn)
  }
}

/** What the view reads: the config file, the running config and auth, and what overrides what. */
export interface SettingsInput {
  /** The config file, as loaded. */
  readonly file: ProxyConfig
  /** The config the server runs with. */
  readonly running: ServerConfig
  /** Whether the server asks for a token now: the auth menu can change it without a restart. */
  readonly authOn: boolean
  /** Whether the file's `authToken` is not a string (#82): the proxy keeps it, and says so. */
  readonly authInvalid: boolean
  /** The settings a flag or env var sets. */
  readonly overrides: SettingOverrides
}

/** Setting -> the flag or env var that sets it, which wins over the config file. */
export type SettingOverrides = Readonly<Partial<Record<SettingKey, string>>>

/** One setting as the view lists it. */
export interface SettingRow {
  readonly key: SettingKey
  readonly label: string
  /** The value the config file holds. */
  readonly saved: string
  /** The value running now, when it differs from the saved one. */
  readonly running?: string
  /** The flag or env var that wins over the saved value. */
  readonly override?: string
  readonly applies: Applies
}

/** The settings a flag sets: {@link CliOverrides} names them as the config file does. */
const FLAG_SETTINGS = [
  'host',
  'port',
  'authToken',
  'hostOriginGuard',
  'remoteImages',
  'docsUi',
  'responsesApi',
  'stats',
  'maxBodySizeMb',
  'upstreamTimeoutSec',
  'logLevel'
] as const satisfies readonly (keyof CliOverrides & SettingKey)[]

/**
 * Finds the settings a flag or env var sets: those the config file can't change. A flag is named
 * rather than an env var for the same setting, since it wins.
 *
 * @param cli - the settings the flags set
 * @param env - the environment
 * @returns setting -> the flag or env var
 */
export function settingOverrides(
  cli: CliOverrides,
  env: Readonly<Record<string, string | undefined>>
): SettingOverrides {
  const overrides: Partial<Record<SettingKey, string>> = {}
  for (const key of SETTING_KEYS) {
    const envName = SPECS[key].env
    if (envName !== undefined && env[envName] !== undefined) overrides[key] = envName
  }
  for (const key of FLAG_SETTINGS) {
    const flag = SPECS[key].flag
    if (flag !== undefined && cli[key] !== undefined) overrides[key] = flag
  }
  return overrides
}

/**
 * Shows the auth the server applies now, or that the file's token is invalid.
 *
 * @param input - the view's input
 * @returns the saved and running values
 */
function authValues(input: SettingsInput): { saved: string; running: string } {
  const saved = input.authInvalid ? 'invalid' : SPECS.authToken.saved(input.file)
  return { saved, running: onOff(input.authOn) }
}

/**
 * Lists the settings as the view shows them.
 *
 * @param input - the config file, the running config and auth, and the overrides
 * @returns one row per setting, in {@link SETTING_KEYS} order
 */
export function settingRows(input: SettingsInput): SettingRow[] {
  return SETTING_KEYS.map((key) => {
    const spec = SPECS[key]
    const { saved, running } =
      key === 'authToken'
        ? authValues(input)
        : { saved: spec.saved(input.file), running: spec.running?.(input.running) }
    const override = input.overrides[key]
    return {
      key,
      label: spec.label,
      saved,
      ...(running === undefined || running === saved ? {} : { running }),
      ...(override === undefined ? {} : { override }),
      applies: SECTIONS[spec.section].applies
    }
  })
}

/**
 * Counts the settings a restart would change: saved, not running, and not held by a flag or env var.
 *
 * @param rows - the rows
 * @returns how many
 */
export function pendingRestart(rows: readonly SettingRow[]): number {
  return rows.filter(
    (row) => row.applies === 'restart' && row.running !== undefined && row.override === undefined
  ).length
}

/**
 * Says whether a setting applies only when the server restarts.
 *
 * @param key - the setting
 * @returns whether a restart applies it
 */
export function appliesOnRestart(key: SettingKey): boolean {
  return SECTIONS[SPECS[key].section].applies === 'restart'
}

/**
 * Names a setting, for dialogs.
 *
 * @param key - the setting
 * @returns its label
 */
export function settingLabel(key: SettingKey): string {
  return SPECS[key].label
}

/** Columns the selection mark takes before a row: `› ` or two spaces. */
const MARK_COLUMNS = 2
/** The label column. */
const LABEL_COLUMNS = 24
/** The value column at its widest; the note after it takes the rest. */
const VALUE_COLUMNS = 34
/** Rows kept under the list for the selected setting's help, its blank row included. */
const HELP_ROWS = 3

/**
 * Says what a row's note is: the override that wins over the saved value, or the running value a
 * restart would replace.
 *
 * @param row - the row
 * @returns the note, colored, or `''`
 */
function rowNote(row: SettingRow): string {
  if (row.override !== undefined) return paint('warning', `${row.override} wins over the file`)
  if (row.running === undefined) return ''
  return row.applies === 'restart'
    ? paint('warning', `running ${row.running}; restart (r) to apply`)
    : paint('warning', `running ${row.running} until the server restarts`)
}

/**
 * Renders one setting's line.
 *
 * @param row - the setting
 * @param selected - whether it is the selected one
 * @param width - the view's columns
 * @returns the line
 */
function settingLine(row: SettingRow, selected: boolean, width: number): string {
  const valueColumns = Math.max(0, Math.min(VALUE_COLUMNS, width - MARK_COLUMNS - LABEL_COLUMNS))
  const label = truncateToWidth(row.label, LABEL_COLUMNS - 1, '…', true)
  const value = truncateToWidth(row.saved, valueColumns - 1, '…', true)
  const mark = selected ? '› ' : '  '
  const text = `${mark}${label} ${value}`
  const line = selected ? highlight(text) : `${mark}${label} ${strong(value)}`
  return truncateToWidth(`${line} ${rowNote(row)}`, width)
}

/**
 * Lays out every line of the list: a heading per group, each setting under it, a blank row between
 * groups.
 *
 * @param rows - the settings
 * @param selected - the selected setting's index in `rows`
 * @param width - the view's columns
 * @returns the lines, and which one is the selected setting
 */
function listLines(
  rows: readonly SettingRow[],
  selected: number,
  width: number
): { lines: string[]; selectedLine: number } {
  const lines: string[] = []
  let selectedLine = 0
  let section: Section | undefined
  for (const [rowIndex, row] of rows.entries()) {
    const rowSection = SPECS[row.key].section
    if (rowSection !== section) {
      if (section !== undefined) lines.push('')
      section = rowSection
      const { title, applies } = SECTIONS[rowSection]
      lines.push(truncateToWidth(`${strong(title)}  ${paint('dim', APPLIES_NOTE[applies])}`, width))
    }
    if (rowIndex === selected) selectedLine = lines.length
    lines.push(settingLine(row, rowIndex === selected, width))
  }
  return { lines, selectedLine }
}

/**
 * Says, over the list, that the config file can't be used: the view shows the defaults it loads
 * as, and nothing is saved over it (#288).
 *
 * @param problem - why the file can't be used, or `undefined` when it can
 * @param width - the view's columns
 * @returns the banner and a blank row, or nothing
 */
function problemBanner(problem: string | undefined, width: number): string[] {
  if (problem === undefined) return []
  const text = `proxy-config.json ${problem}: these are the defaults it loads as, and nothing is saved over it until it is fixed or removed.`
  return [...wrapTextWithAnsi(paint('error', text), width), '']
}

/**
 * Renders the Settings view: a banner when the config file can't be used, the settings by group,
 * scrolled to keep the selected one on screen, and its help under them.
 *
 * @param rows - the settings ({@link settingRows})
 * @param selected - the selected setting's index
 * @param size - the space available
 * @param size.height - rows
 * @param size.width - columns
 * @param problem - why the config file can't be used (`is not valid JSON`); `undefined` when it can
 * @returns the view's rows
 */
export function settingsViewRows(
  rows: readonly SettingRow[],
  selected: number,
  size: { readonly height: number; readonly width: number },
  problem?: string
): string[] {
  const { width, height } = size
  const banner = problemBanner(problem, width)
  const chosen = rows[selected]
  const help =
    chosen === undefined ? [] : wrapTextWithAnsi(paint('dim', SPECS[chosen.key].help), width)
  const helpRows = help.length === 0 ? 0 : Math.min(help.length + 1, HELP_ROWS + 1)
  const visible = Math.max(1, height - helpRows - banner.length)
  const { lines, selectedLine } = listLines(rows, selected, width)
  const first = firstShown(selectedLine, lines.length, visible)
  const shown = [...banner, ...lines.slice(first, first + visible)]
  if (helpRows === 0) return shown
  const padding = Array.from(
    { length: Math.max(0, visible + banner.length - shown.length) },
    () => ''
  )
  return [...shown, ...padding, '', ...help.slice(0, helpRows - 1)].map((row) =>
    visibleWidth(row) > width ? truncateToWidth(row, width) : row
  )
}
