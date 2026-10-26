/**
 * The console's state (#61): what the status read every few seconds holds, and what every render
 * reads, as the console opens.
 *
 * @packageDocumentation
 */

import {
  type AliasTarget,
  configFileAuthTokenInvalid,
  configFileProblem,
  describeConfigFileProblem,
  loadConfigFromFile,
  type LoginLabels,
  type ProxyConfig,
  type Reserve
} from '@proxy/config/schema'
import type { ModelExposureResult } from '@proxy/openai/model-exposure'
import type { StatsWindow } from '@proxy/stats/windows'
import type { LogViewport } from '@proxy/tui/log-view'
import type { View } from '@proxy/tui/navigation'
import type { RequestsViewport } from '@proxy/tui/requests-view'
import type { RefreshState } from '@proxy/tui/status-refresh'

/** What the status line shows; read every few seconds, never the credentials themselves. */
export interface Status {
  readonly available: number
  /** Exposed model count, or the exposure config's error. */
  readonly exposed: number | string
  readonly cooldowns: number
  readonly modelsJsonError: string | undefined
  /** The quota reserve per provider (`routing.reserve`), to mark a provider below it. */
  readonly reserve: Reserve
  /** Provider -> the label the operator gave the login (`labels`). */
  readonly labels: LoginLabels
  /** The exposure the Models view lists and the alias editor checks names against (#230). */
  readonly exposure: ModelExposureResult | undefined
  /** The configured aliases, exposed or not. */
  readonly aliases: Readonly<Record<string, AliasTarget>>
  /** The config file, as the Settings view shows it (#288). */
  readonly file: ProxyConfig
  /** Whether the file's `authToken` is not a string (#82). */
  readonly authInvalid: boolean
  /** Why the config file can't be used (`is not valid JSON`); `undefined` when it can (#288). */
  readonly fileProblem: string | undefined
}

/** The console's state, which every render reads. */
export interface ConsoleState extends RefreshState<Status> {
  view: View
  /** Whether the first view shows the raw log rather than the Requests table (`r`). */
  logRaw: boolean
  /** Where the raw log is: following new lines, or pinned to the lines on screen. */
  logView: LogViewport
  /** Where the Requests table is: following new requests, or pinned to the ones on screen. */
  requestsView: RequestsViewport
  /** The selected row of the accounts view; the row after the accounts opens the login. */
  selected: number
  /** The selected row of the Models view: a model, an alias, or the new-alias row (#230). */
  modelsSelected: number
  /** The selected setting of the Settings view (#288). */
  settingsSelected: number
  /** Open client connections, counted every tick; `undefined` before the first count. */
  connections: number | undefined
  /** Whether the operator hid the sidebar (`s`). */
  sidebarHidden: boolean
  /** The window the Stats dashboard shows. */
  statsWindow: StatsWindow
}

/**
 * Makes the console's state as it opens: the first view, nothing read or selected yet.
 *
 * @returns the state
 */
export function initialState(): ConsoleState {
  return {
    view: 'logs',
    logRaw: false,
    logView: undefined,
    requestsView: undefined,
    status: undefined,
    accounts: [],
    verification: new Map(),
    credentialChanges: new Map(),
    selected: 0,
    modelsSelected: 0,
    settingsSelected: 0,
    connections: undefined,
    sidebarHidden: false,
    statsWindow: 'today'
  }
}

/**
 * Reads what the status takes from the config file: the file as the Settings view shows it, the
 * login labels, and whether its token or the file itself can't be used.
 *
 * @returns those fields of the status
 */
export function configFileStatus(): Pick<
  Status,
  'file' | 'labels' | 'authInvalid' | 'fileProblem'
> {
  const file = loadConfigFromFile()
  const problem = configFileProblem()
  return {
    file,
    labels: file.labels,
    authInvalid: configFileAuthTokenInvalid(),
    fileProblem: problem === undefined ? undefined : describeConfigFileProblem(problem)
  }
}
