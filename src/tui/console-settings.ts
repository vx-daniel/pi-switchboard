/**
 * The console's settings editors (#288): what Enter does on each row of the Settings view.
 *
 * @remarks
 * Each change is checked against the config file's bounds, then saved to `proxy-config.json` at
 * once. A setting the server reads per request applies to the next one; a setting it reads at
 * startup applies when the server restarts, which the editor offers right after saving. Saving
 * never replaces an `authToken` that is not a string (#82): only the auth menu may. The dialogs
 * come in as {@link SettingsEditor.screens}: pi's selector and input in the console, scripted
 * answers in tests.
 *
 * @packageDocumentation
 */

import { getLogLevels } from '@logtape/logtape'
import {
  FailureClassSchema,
  configFileProblem,
  describeConfigFileProblem,
  getConfigPath,
  intBounds,
  isModelExposureMode,
  isPublicModelIdMode,
  loadConfigFromFile,
  ModelExposureModeSchema,
  parseIntText,
  type ProxyConfig,
  ProxyConfigSchema,
  PublicModelIdModeSchema,
  saveConfigToFile
} from '@proxy/config/schema'
import { proxyLogger } from '@proxy/logging'
import { canonicalModelId } from '@proxy/pi/model-id'
import { getAvailableModels } from '@proxy/pi/registry'
import { isLoopbackHost } from '@proxy/server/startup'
import type { ConsoleContext } from '@proxy/tui/console'
import { inBackground } from '@proxy/tui/console-accounts'
import { askLine, type DialogScreens, pickLabel, pickMany, tickList } from '@proxy/tui/dialogs'
import { openAuthMenu } from '@proxy/tui/proxy-auth-menu'
import type { RestartReport } from '@proxy/tui/proxy-server'
import {
  appliesOnRestart,
  pendingRestart,
  SETTING_KEYS,
  type SettingKey,
  settingLabel,
  type SettingOverrides,
  type SettingRow,
  settingRows
} from '@proxy/tui/settings-view'
import type * as z from 'zod'

/** Logger for settings saved from the console. */
const configLogger = proxyLogger('config')

/** What the editors work with. */
export interface SettingsEditor {
  readonly screens: DialogScreens
  /**
   * Asks for any number of a long list's options, keeping its place and offering search.
   *
   * @param title - what the options are for
   * @param options - the options
   * @param ticked - the options ticked at first
   * @returns the options ticked when it closed
   */
  pickMany(title: string, options: readonly string[], ticked: readonly string[]): Promise<string[]>
  /** The available models' canonical IDs, for the custom model list. */
  readonly models: readonly string[]
  /** The providers that have a model, for provider prefixes. */
  readonly providers: readonly string[]
  /** The logins pi has, for the quota reserve. */
  readonly logins: readonly string[]
  /** Whether the server asks for a token now: binding beyond loopback without one asks first. */
  readonly authOn: boolean
  /** The settings a flag or env var holds: saving them changes nothing until it is gone. */
  readonly overrides: SettingOverrides
  /** Opens the proxy auth menu, as `p` does. */
  openAuth(): Promise<void>
  /**
   * Restarts the server with the saved settings.
   *
   * @returns what the restart did
   */
  restart(): Promise<RestartReport>
  /** Reads the status again after a save, so the view shows the change. */
  refresh(): Promise<void>
}

/**
 * Asks for a setting's new value and returns the config with it, or `undefined` to change nothing.
 *
 * @param editor - the editor
 * @param file - the config file as it is now
 * @returns the changed config
 */
type SettingEdit = (editor: SettingsEditor, file: ProxyConfig) => Promise<ProxyConfig | undefined>

/** What the editor says when `proxy-config.json` could not be written; the log says why. */
const NOT_WRITTEN = 'Could not write proxy-config.json; nothing changed. The log says why.'
/** The options of the question after a restart-only setting is saved. */
const RESTART_CHOICES = { now: 'Restart the server now', later: 'Later (r on this view)' } as const
/** The options of a switch. */
const SWITCH = { on: 'On', off: 'Off' } as const
/** The bind address options besides typing one. */
const HOSTS = {
  loopback: '127.0.0.1 (this machine only)',
  everywhere: '0.0.0.0 (every interface)',
  other: 'Another address…'
} as const
/** The row that adds an entry to a map setting. */
const ADD = '+ Add…'
/** What can be done to a map setting's entry. */
const ENTRY = { change: 'Change it', remove: 'Remove it' } as const

/**
 * Tells the operator something that needs no answer, as a selector with one option.
 *
 * @param editor - the dialogs
 * @param message - what to say
 */
async function notify(editor: SettingsEditor, message: string): Promise<void> {
  await editor.screens.select(message, ['OK'])
}

/**
 * Asks for a whole number until it is within a setting's bounds, saying why the last one wasn't.
 *
 * @param editor - the dialogs
 * @param title - the question
 * @param schema - the setting's schema, whose bounds the number must be within
 * @returns the number, or `undefined` when cancelled
 */
async function askInt(
  editor: SettingsEditor,
  title: string,
  schema: z.ZodInt
): Promise<number | undefined> {
  const { min, max } = intBounds(schema)
  let question = title
  for (;;) {
    const text = await editor.screens.input(question)
    if (text === undefined) return undefined
    const value = parseIntText(text, schema)
    if (value !== undefined) return value
    question = `Not a whole number from ${String(min)} to ${String(max)}. ${title}`
  }
}

/**
 * Asks to turn a switch on or off.
 *
 * @param editor - the dialogs
 * @param key - the setting
 * @param now - whether it is on now
 * @returns whether to turn it on, or `undefined` when cancelled
 */
async function askSwitch(
  editor: SettingsEditor,
  key: SettingKey,
  now: boolean
): Promise<boolean | undefined> {
  const choice = await editor.screens.select(`${settingLabel(key)} is ${now ? 'on' : 'off'}`, [
    SWITCH.on,
    SWITCH.off
  ])
  return choice === undefined ? undefined : choice === SWITCH.on
}

/**
 * Makes the editor for a switch.
 *
 * @param key - the setting
 * @param field - its field in the config file
 * @returns the editor
 */
function switchEdit(
  key: SettingKey,
  field: 'remoteImages' | 'responsesApi' | 'docsUi' | 'stats'
): SettingEdit {
  return async (editor, file) => {
    const on = await askSwitch(editor, key, file[field])
    return on === undefined ? undefined : { ...file, [field]: on }
  }
}

/**
 * Makes the editor for a whole number.
 *
 * @param field - its field in the config file
 * @param title - the question
 * @returns the editor
 */
function intEdit(
  field: 'port' | 'maxBodySizeMb' | 'upstreamTimeoutSec',
  title: string
): SettingEdit {
  return async (editor, file) => {
    const value = await askInt(
      editor,
      `${title} (now ${String(file[field])})`,
      ProxyConfigSchema.shape[field]
    )
    return value === undefined ? undefined : { ...file, [field]: value }
  }
}

/**
 * Asks for a bind address: this machine, every interface, or one typed in. Listening beyond this
 * machine with proxy auth off asks again first.
 *
 * @param editor - the dialogs, and whether auth is on
 * @param file - the config file
 * @returns the config with the address, or `undefined` to change nothing
 */
async function editHost(
  editor: SettingsEditor,
  file: ProxyConfig
): Promise<ProxyConfig | undefined> {
  const choice = await editor.screens.select(`Listen on (now ${file.host})`, Object.values(HOSTS))
  let host: string | undefined
  if (choice === HOSTS.loopback) host = '127.0.0.1'
  else if (choice === HOSTS.everywhere) host = '0.0.0.0'
  else if (choice === HOSTS.other) host = await askHost(editor)
  if (host === undefined) return undefined
  if (!isLoopbackHost(host) && !editor.authOn) {
    const sure = await editor.screens.select(
      `Proxy auth is off: any client that can reach ${host} could use your logins. Listen there anyway?`,
      ['Listen there', 'Keep the address']
    )
    if (sure !== 'Listen there') return undefined
  }
  return { ...file, host }
}

/**
 * Asks for an address until one is given.
 *
 * @param editor - the dialogs
 * @returns the address, trimmed, or `undefined` when cancelled
 */
async function askHost(editor: SettingsEditor): Promise<string | undefined> {
  let question = 'Address to listen on (an IP address or a host name)'
  for (;;) {
    const text = await editor.screens.input(question)
    if (text === undefined) return undefined
    const parsed = ProxyConfigSchema.shape.host.safeParse(text)
    if (parsed.success) return parsed.data
    question = 'An address is needed. Address to listen on (an IP address or a host name)'
  }
}

/**
 * Asks for the custom model list from the available models, keeping any it already lists that
 * are not available now. With exposure not `custom`, offers to switch to it.
 *
 * @param editor - the dialogs and the models
 * @param file - the config file
 * @returns the config with the list, or `undefined` to change nothing
 */
async function editCustomModels(
  editor: SettingsEditor,
  file: ProxyConfig
): Promise<ProxyConfig | undefined> {
  const options = [...new Set([...editor.models, ...file.customModels])]
  if (options.length === 0) {
    await notify(editor, 'No model is available to list: log in to a provider first (n).')
    return undefined
  }
  const customModels = await editor.pickMany(
    'Models custom exposure serves',
    options,
    file.customModels
  )
  return { ...file, customModels }
}

/**
 * Asks for the exposure mode. Choosing `custom` with an empty list opens the list at once, since
 * custom exposure with no model serves nothing.
 *
 * @param editor - the dialogs
 * @param file - the config file
 * @returns the config with the mode, or `undefined` to change nothing
 */
async function editExposureMode(
  editor: SettingsEditor,
  file: ProxyConfig
): Promise<ProxyConfig | undefined> {
  const choice = await editor.screens.select(
    `Exposed models (now ${file.modelExposureMode})`,
    ModelExposureModeSchema.options
  )
  if (choice === undefined || !isModelExposureMode(choice)) return undefined
  const changed = { ...file, modelExposureMode: choice }
  if (choice !== 'custom' || file.customModels.length > 0) return changed
  return (await editCustomModels(editor, changed)) ?? changed
}

/**
 * Asks which entry of a map setting to change, or to add one.
 *
 * @param editor - the dialogs
 * @param title - what the map is
 * @param entries - each entry's key and how it shows
 * @returns the key picked, {@link ADD}, or `undefined` when cancelled
 */
async function pickEntry(
  editor: SettingsEditor,
  title: string,
  entries: readonly (readonly [key: string, shown: string])[]
): Promise<string | undefined> {
  const rows = entries.map(([, shown]) => shown)
  const choice = await editor.screens.select(title, [...rows, ADD])
  if (choice === undefined || choice === ADD) return choice
  return entries[rows.indexOf(choice)]?.[0]
}

/**
 * Asks for a provider's prefix until it is one the config keeps: not empty, no surrounding spaces.
 *
 * @param editor - the dialogs
 * @param provider - the provider
 * @returns the prefix, or `undefined` when cancelled
 */
async function askPrefix(editor: SettingsEditor, provider: string): Promise<string | undefined> {
  const title = `Prefix for ${provider}'s model IDs (instead of "${provider}")`
  let question = title
  for (;;) {
    const text = await editor.screens.input(question)
    if (text === undefined) return undefined
    if (text.length > 0 && text.trim() === text) return text
    question = `A prefix can't be empty or start or end with a space. ${title}`
  }
}

/**
 * Changes, removes or adds one provider prefix.
 *
 * @param editor - the dialogs and the providers
 * @param file - the config file
 * @returns the config with the change, or `undefined` to change nothing
 */
async function editPrefixes(
  editor: SettingsEditor,
  file: ProxyConfig
): Promise<ProxyConfig | undefined> {
  const prefixes = file.providerPrefixes
  const entries = Object.entries(prefixes).map(
    ([provider, prefix]) => [provider, `${provider} → ${prefix}`] as const
  )
  const picked = await pickEntry(editor, 'Provider prefixes', entries)
  if (picked === undefined) return undefined
  const provider = picked === ADD ? await pickNew(editor, editor.providers, prefixes) : picked
  if (provider === undefined) return undefined
  if (picked !== ADD) {
    const action = await editor.screens.select(`${provider} → ${prefixes[provider] ?? ''}`, [
      ENTRY.change,
      ENTRY.remove
    ])
    if (action === undefined) return undefined
    if (action === ENTRY.remove) {
      const { [provider]: _removed, ...rest } = prefixes
      return { ...file, providerPrefixes: rest }
    }
  }
  const prefix = await askPrefix(editor, provider)
  return prefix === undefined
    ? undefined
    : { ...file, providerPrefixes: { ...prefixes, [provider]: prefix } }
}

/**
 * Asks which provider or login to add an entry for: those without one yet.
 *
 * @param editor - the dialogs
 * @param candidates - the providers or logins
 * @param taken - the map, whose keys have an entry already
 * @returns the one picked, or `undefined` when cancelled or there is none left
 */
async function pickNew(
  editor: SettingsEditor,
  candidates: readonly string[],
  taken: Readonly<Record<string, unknown>>
): Promise<string | undefined> {
  const free = candidates.filter((candidate) => !Object.hasOwn(taken, candidate))
  if (free.length === 0) {
    await notify(editor, 'Every one has an entry already.')
    return undefined
  }
  return editor.screens.select('For which?', free)
}

/**
 * Asks for a login's reserve until it is a share from 0 to 1, or empty for none.
 *
 * @param editor - the dialogs
 * @param login - the login
 * @returns the share, `null` for none, or `undefined` when cancelled
 */
async function askShare(editor: SettingsEditor, login: string): Promise<number | null | undefined> {
  const title = `Share of each quota window to keep free on ${login}, 0 to 1 (empty for none)`
  let question = title
  for (;;) {
    const text = await editor.screens.input(question)
    if (text === undefined) return undefined
    const trimmed = text.trim()
    if (trimmed === '') return null
    const share = Number(trimmed)
    if (Number.isFinite(share) && share >= 0 && share <= 1) return share
    question = `Not a share from 0 to 1, such as 0.2. ${title}`
  }
}

/**
 * Sets or clears one login's quota reserve.
 *
 * @param editor - the dialogs and the logins
 * @param file - the config file
 * @returns the config with the change, or `undefined` to change nothing
 */
async function editReserve(
  editor: SettingsEditor,
  file: ProxyConfig
): Promise<ProxyConfig | undefined> {
  const reserve = file.routing.reserve
  const logins = [...new Set([...editor.logins, ...Object.keys(reserve)])]
  const entries = logins.map((login) => {
    const share = reserve[login]
    return [login, `${login}  ${share === undefined ? 'none' : String(share)}`] as const
  })
  const picked = await pickEntry(editor, 'Quota reserve per login', entries)
  if (picked === undefined) return undefined
  const login = picked === ADD ? await askLogin(editor) : picked
  if (login === undefined) return undefined
  const share = await askShare(editor, login)
  if (share === undefined) return undefined
  const { [login]: _previous, ...rest } = reserve
  const next = share === null ? rest : { ...rest, [login]: share }
  return { ...file, routing: { ...file.routing, reserve: next } }
}

/**
 * Asks for a login's name, for a reserve on a login pi has no credential for yet.
 *
 * @param editor - the dialogs
 * @returns the name, trimmed, or `undefined` when cancelled or empty
 */
async function askLogin(editor: SettingsEditor): Promise<string | undefined> {
  const text = await editor.screens.input('Login (provider) name, such as anthropic or anthropic-2')
  const login = text?.trim()
  return login === undefined || login === '' ? undefined : login
}

/** Each setting's editor; proxy auth opens the auth menu instead. */
const EDITS: Readonly<Record<Exclude<SettingKey, 'authToken'>, SettingEdit>> = {
  host: editHost,
  port: intEdit('port', 'Port to listen on, 1 to 65535'),
  maxBodySizeMb: intEdit('maxBodySizeMb', 'Largest request body in MB, 1 to 500'),
  upstreamTimeoutSec: intEdit(
    'upstreamTimeoutSec',
    'Seconds a provider may send nothing before the call is aborted, 5 to 600'
  ),
  logLevel: async (editor, file) => {
    const level = await editor.screens.select(`Log level (now ${file.logLevel})`, getLogLevels())
    const found = getLogLevels().find((candidate) => candidate === level)
    return found === undefined ? undefined : { ...file, logLevel: found }
  },
  remoteImages: switchEdit('remoteImages', 'remoteImages'),
  responsesApi: switchEdit('responsesApi', 'responsesApi'),
  docsUi: switchEdit('docsUi', 'docsUi'),
  stats: switchEdit('stats', 'stats'),
  publicModelIdMode: async (editor, file) => {
    const mode = await editor.screens.select(
      `Public model IDs (now ${file.publicModelIdMode})`,
      PublicModelIdModeSchema.options
    )
    return mode === undefined || !isPublicModelIdMode(mode)
      ? undefined
      : { ...file, publicModelIdMode: mode }
  },
  modelExposureMode: editExposureMode,
  customModels: editCustomModels,
  providerPrefixes: editPrefixes,
  reserve: editReserve,
  loginFallbackOn: async (editor, file) => {
    const fallbackOn = await tickList(
      editor.screens,
      "Move a request to the provider's next login on",
      FailureClassSchema.options,
      file.routing.logins.fallbackOn
    )
    return fallbackOn === undefined
      ? undefined
      : { ...file, routing: { ...file.routing, logins: { fallbackOn } } }
  }
}

/**
 * Restarts the server, and says why when the proxy still runs as before.
 *
 * @param editor - the editor
 */
async function restartServer(editor: SettingsEditor): Promise<void> {
  const report = await editor.restart()
  if (report.kind === 'refused') {
    await notify(
      editor,
      'The saved settings can not start the proxy: proxy auth is set but can not be applied. The log says why; the proxy still runs as before.'
    )
  } else if (report.kind === 'kept') {
    await notify(
      editor,
      `The server could not listen with the saved settings (${report.reason}); it still runs as before.`
    )
  }
}

/**
 * After a restart-only setting is saved: says when a flag or env var keeps it from applying, or
 * offers to restart now.
 *
 * @param editor - the editor
 * @param key - the setting saved
 */
async function afterRestartOnlySave(editor: SettingsEditor, key: SettingKey): Promise<void> {
  const override = editor.overrides[key]
  if (override !== undefined) {
    await notify(
      editor,
      `Saved, but ${override} wins over the file: ${settingLabel(key)} stays as it is until it is gone.`
    )
    return
  }
  const choice = await editor.screens.select(
    `Saved. ${settingLabel(key)} applies when the server restarts.`,
    Object.values(RESTART_CHOICES)
  )
  if (choice === RESTART_CHOICES.now) await restartServer(editor)
}

/**
 * Runs what Enter does on a setting: asks for its new value, saves it, and for a setting read at
 * startup offers to restart the server. A config file that can't be read or parsed is not edited:
 * it loads as the defaults, and saving would replace what it holds with them (#288).
 *
 * @param editor - the editor
 * @param key - the setting
 */
export async function runSetting(editor: SettingsEditor, key: SettingKey): Promise<void> {
  if (key === 'authToken') {
    await editor.openAuth()
    await editor.refresh()
    return
  }
  const problem = configFileProblem()
  if (problem !== undefined) {
    await notify(
      editor,
      `proxy-config.json ${describeConfigFileProblem(problem)}: fix or remove it first; nothing is saved over it.`
    )
    return
  }
  const file = loadConfigFromFile()
  const next = await EDITS[key](editor, file)
  if (next === undefined || JSON.stringify(next) === JSON.stringify(file)) return
  // Not `replaceInvalidAuthToken`: an invalid token in the file stays for the auth menu (#82).
  if (!saveConfigToFile(next)) {
    await notify(editor, NOT_WRITTEN)
    return
  }
  configLogger.info('Saved {setting} to {path}', { setting: key, path: getConfigPath() })
  await editor.refresh()
  if (appliesOnRestart(key)) await afterRestartOnlySave(editor, key)
}

/**
 * Builds the editor on pi's own dialogs, over the console's models, logins and server.
 *
 * @param context - the console
 * @returns the editor
 */
function editorFor(context: ConsoleContext): SettingsEditor {
  const { tui } = context
  const available = getAvailableModels()
  return {
    screens: {
      select: (title, labels) => pickLabel(tui, title, labels),
      input: (title) => askLine(tui, title)
    },
    pickMany: (title, options, ticked) => pickMany(tui, title, options, ticked),
    models: available.map(canonicalModelId),
    providers: [...new Set(available.map((model) => model.provider))],
    logins: context.state.accounts.map((account) => account.provider),
    authOn: context.proxyAuth.current().kind === 'token',
    overrides: context.startup.overrides,
    openAuth: () => openAuthMenu(tui, context.config, context.proxyAuth),
    restart: () => context.restart(),
    refresh: () => context.refresh()
  }
}

/**
 * Opens what Enter does on the Settings view's selected row, on pi's own dialogs.
 *
 * @param context - the console
 */
export function openSelectedSetting(context: ConsoleContext): void {
  const key = SETTING_KEYS[context.state.settingsSelected]
  if (key === undefined) return
  inBackground(runSetting(editorFor(context), key), 'Editing settings')
}

/**
 * Restarts the server with the saved settings (`r` on the Settings view).
 *
 * @param context - the console
 */
export function openRestart(context: ConsoleContext): void {
  inBackground(restartServer(editorFor(context)), 'Restarting the server')
}

/**
 * Lists the settings as the Settings view shows them: none before the first status read.
 *
 * @param context - the console: the file last read, the running config and auth, the overrides
 * @returns the rows
 */
export function currentSettingRows(context: ConsoleContext): SettingRow[] {
  const { status } = context.state
  if (status === undefined) return []
  return settingRows({
    file: status.file,
    running: context.config,
    authOn: context.proxyAuth.current().kind === 'token',
    authInvalid: status.authInvalid,
    overrides: context.startup.overrides
  })
}

/**
 * Says whether the saved settings all run, or how many wait for a restart.
 *
 * @param context - the console
 * @returns `2 to apply on restart`, or `all in effect`
 */
export function settingsContext(context: ConsoleContext): string {
  const pending = pendingRestart(currentSettingRows(context))
  return pending === 0 ? 'all in effect' : `${String(pending)} to apply on restart`
}
