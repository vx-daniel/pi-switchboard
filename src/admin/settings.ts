/**
 * The admin UI's Settings page (#367, phase 2): the settings as the console lists them
 * (`src/config/settings.ts`), each with the value an editor changes and the kind of input it takes,
 * and the one write an editor makes, saved to `proxy-config.json` and logged for audit.
 *
 * @remarks
 * Writes are checked by `src/config/setting-writes.ts` with the schemas the file is loaded with.
 * Proxy auth is shown (on or off, never the token) but not written: the token is a credential and
 * stays in the console (constitution III). A file that can't be read or parsed is never written
 * over, as in the console. The audit line names the operator, the setting and its value before and
 * after, as the Settings view shows values, so it never holds a token.
 *
 * @packageDocumentation
 */

import { getLogLevels } from '@logtape/logtape'
import {
  badRequest,
  fileUnusable,
  notFound,
  notWritten,
  type Refusal,
  type WriteAnswer
} from '@proxy/admin/answers'
import type { AdminServerFacts } from '@proxy/admin/reads'
import {
  configFileAuthTokenInvalid,
  configFileProblem,
  describeConfigFileProblem,
  FailureClassSchema,
  getConfigPath,
  intBounds,
  loadConfigFromFile,
  ModelExposureModeSchema,
  type ProxyConfig,
  ProxyConfigSchema,
  PublicModelIdModeSchema,
  saveConfigToFile
} from '@proxy/config/schema'
import { isWritableSetting, type WritableSetting, writeSetting } from '@proxy/config/setting-writes'
import {
  pendingRestart,
  type Section,
  SETTING_KEYS,
  type SettingKey,
  settingHelp,
  type SettingRow,
  settingRows,
  settingSection
} from '@proxy/config/settings'
import { proxyLogger } from '@proxy/logging'
import { canonicalModelId } from '@proxy/pi/model-id'
import { getAvailableModels, getCredentialStatuses } from '@proxy/pi/registry'
import { HTTP_OK } from '@proxy/server/http-status'

/** Logger for the changes operators make. */
const auditLogger = proxyLogger('admin', 'audit')

/** The input a setting takes on the page. */
export type SettingInput =
  | { readonly kind: 'text' }
  | { readonly kind: 'int'; readonly min: number; readonly max: number }
  | { readonly kind: 'switch' }
  | { readonly kind: 'choice'; readonly options: readonly string[] }
  | { readonly kind: 'many'; readonly options: readonly string[] }
  | { readonly kind: 'prefixes'; readonly options: readonly string[] }
  | { readonly kind: 'shares'; readonly options: readonly string[] }
  | { readonly kind: 'console' }

/** One setting on the page. */
export interface SettingEntry extends SettingRow {
  readonly section: Section
  readonly help: string
  /** The value an editor changes, as the file holds it; `null` for proxy auth. */
  readonly value: unknown
  readonly input: SettingInput
}

/** The Settings page's data. */
export interface SettingsSnapshot {
  /** Where the settings are saved. */
  readonly path: string
  /** Why the file can't be used, so nothing is written over it; `null` when it can. */
  readonly fileProblem: string | null
  readonly settings: readonly SettingEntry[]
  /** Settings saved but not running, which a restart would apply. */
  readonly pendingRestart: number
}

/** A write's answer: the page's data after it, or why it was refused. */
export type SettingAnswer = WriteAnswer<SettingsSnapshot>

/** The file's fields, whose schemas bound the numbers. */
const FIELDS = ProxyConfigSchema.shape

/** What the page's choices are drawn from now. */
interface Choices {
  readonly models: readonly string[]
  readonly providers: readonly string[]
  readonly logins: readonly string[]
}

/**
 * Reads what the settings' choices are drawn from: the available models, their providers, and the
 * logins pi has.
 *
 * @returns the choices
 */
async function readChoices(): Promise<Choices> {
  const available = getAvailableModels()
  const accounts = await getCredentialStatuses(false)
  return {
    models: [...new Set(available.map((model) => canonicalModelId(model)))].toSorted(),
    providers: [...new Set(available.map((model) => model.provider))].toSorted(),
    logins: accounts.map((account) => account.provider)
  }
}

/** A switch's input. */
const SWITCH_INPUT: SettingInput = { kind: 'switch' }

/** Each setting's input, from the choices drawn from the proxy's models and logins. */
const INPUTS: Readonly<Record<SettingKey, (choices: Choices) => SettingInput>> = {
  host: () => ({ kind: 'text' }),
  port: () => ({ kind: 'int', ...intBounds(FIELDS.port) }),
  maxBodySizeMb: () => ({ kind: 'int', ...intBounds(FIELDS.maxBodySizeMb) }),
  upstreamTimeoutSec: () => ({ kind: 'int', ...intBounds(FIELDS.upstreamTimeoutSec) }),
  hostOriginGuard: () => SWITCH_INPUT,
  remoteImages: () => SWITCH_INPUT,
  responsesApi: () => SWITCH_INPUT,
  docsUi: () => SWITCH_INPUT,
  stats: () => SWITCH_INPUT,
  consoleLog: () => SWITCH_INPUT,
  logLevel: () => ({ kind: 'choice', options: getLogLevels() }),
  publicModelIdMode: () => ({ kind: 'choice', options: PublicModelIdModeSchema.options }),
  modelExposureMode: () => ({ kind: 'choice', options: ModelExposureModeSchema.options }),
  customModels: (choices) => ({ kind: 'many', options: choices.models }),
  providerPrefixes: (choices) => ({ kind: 'prefixes', options: choices.providers }),
  reserve: (choices) => ({ kind: 'shares', options: choices.logins }),
  loginFallbackOn: () => ({ kind: 'many', options: FailureClassSchema.options }),
  authToken: () => ({ kind: 'console' })
}

/**
 * Reads the value an editor changes, as the file holds it.
 *
 * @param file - the config file
 * @param key - the setting
 * @returns the value; `null` for proxy auth, whose token is never sent
 */
function valueOf(file: ProxyConfig, key: SettingKey): unknown {
  if (key === 'authToken') return null
  if (key === 'reserve') return file.routing.reserve
  if (key === 'loginFallbackOn') return file.routing.logins.fallbackOn
  return file[key]
}

/**
 * Reads the Settings page's data.
 *
 * @param server - the API listener's running config and what overrides it
 * @returns the settings, with their values and inputs
 */
export async function settingsSnapshot(server: AdminServerFacts): Promise<SettingsSnapshot> {
  const problem = configFileProblem()
  const file = loadConfigFromFile()
  const choices = await readChoices()
  const rows = settingRows({
    file,
    running: server.running,
    authOn: server.proxyAuth,
    authInvalid: configFileAuthTokenInvalid(),
    overrides: server.overrides
  })
  return {
    path: getConfigPath(),
    fileProblem: problem === undefined ? null : describeConfigFileProblem(problem),
    settings: rows.map((row) => ({
      ...row,
      section: settingSection(row.key),
      help: settingHelp(row.key),
      value: valueOf(file, row.key),
      input: INPUTS[row.key](choices)
    })),
    pendingRestart: pendingRestart(rows)
  }
}

/**
 * Says how a setting shows in the file, for the audit line: as the Settings view shows it.
 *
 * @param file - the config file
 * @param server - the running config, for the rows
 * @param key - the setting
 * @returns the value as shown
 */
function shown(file: ProxyConfig, server: AdminServerFacts, key: SettingKey): string {
  const rows = settingRows({
    file,
    running: server.running,
    authOn: server.proxyAuth,
    authInvalid: false,
    overrides: server.overrides
  })
  return rows.find((row) => row.key === key)?.saved ?? ''
}

/** What a write sends. */
export interface SettingChange {
  /** The operator, an editor, for the audit line. */
  readonly login: string
  readonly key: string
  readonly value: unknown
  /** Whether they confirmed listening beyond this machine with proxy auth off. */
  readonly confirmed: boolean
}

/**
 * Finds the setting a write names, if it is one a value can change.
 *
 * @param key - the name sent
 * @returns the setting, or the answer refusing it
 */
function writableKey(key: string): WritableSetting | Refusal {
  const setting = SETTING_KEYS.find((candidate) => candidate === key)
  if (setting === undefined) return notFound('unknown_setting', `There is no setting ${key}.`)
  if (!isWritableSetting(setting)) {
    return badRequest(
      'console_only',
      'Proxy auth is a credential: change it in the console (pi-switchboard tui, p).'
    )
  }
  return setting
}

/**
 * Changes one setting for an editor: checks it, saves it, and logs who changed what. Only an
 * editor's request reaches it (`src/admin/api.ts` refuses a viewer's write).
 *
 * @param server - the running config and what overrides it
 * @param change - who, which setting and the value
 * @returns the page's data after the change, or why it was refused
 */
export async function changeSetting(
  server: AdminServerFacts,
  change: SettingChange
): Promise<SettingAnswer> {
  const key = writableKey(change.key)
  if (typeof key !== 'string') return key
  const unusable = fileUnusable()
  if (unusable !== undefined) return unusable
  const file = loadConfigFromFile()
  const written = writeSetting(file, key, change.value, {
    authOn: server.proxyAuth,
    confirmed: change.confirmed
  })
  if (!written.ok) {
    return badRequest(
      written.code === 'confirm' ? 'confirm_required' : 'invalid_value',
      written.message
    )
  }
  if (JSON.stringify(written.file) !== JSON.stringify(file)) {
    if (!saveConfigToFile(written.file)) return notWritten()
    auditLogger.info('{login} changed {setting} from {before} to {after}', {
      login: change.login,
      setting: key,
      before: shown(file, server, key),
      after: shown(written.file, server, key)
    })
  }
  return { status: HTTP_OK, body: await settingsSnapshot(server) }
}
