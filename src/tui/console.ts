/**
 * The console (`pi-switchboard tui`, #61): one process holds the HTTP server, a full-screen pi-tui
 * view and the proxy's model runtime. It shows the live logs, the proxy's status and pi's logins,
 * and runs logins and logouts on pi's own screens.
 *
 * @remarks
 * Quitting the console stops the proxy. Logins go through `src/tui/login.ts`, so a new login is
 * served at once, by the same runtime. While the console runs, a stray write to stderr (one that
 * bypasses LogTape) goes to the raw log instead of corrupting the screen.
 *
 * @packageDocumentation
 */

import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import {
  type Component,
  Key,
  type KeyId,
  matchesKey,
  ProcessTerminal,
  truncateToWidth,
  TuiAltScreen,
  KeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS
} from '@earendil-works/pi-tui'
import type { ServerType } from '@hono/node-server'
import type { ServerConfig } from '@proxy/config/env'
import type { AliasTarget, LoginLabels, Reserve } from '@proxy/config/schema'
import { computeModelExposure, type ModelExposureResult } from '@proxy/openai/model-exposure'
import { activeCooldowns, clearCooldownsFor } from '@proxy/pi/cooldowns'
import { providerQuota } from '@proxy/pi/quota'
import {
  getAvailableModels,
  getCredentialStatuses,
  getModelsJsonError,
  initRegistry
} from '@proxy/pi/registry'
import {
  activeRequests,
  finishedRequests,
  onActiveRequestsChange
} from '@proxy/server/active-requests'
import { httpRequests, onHttpRequestsChange } from '@proxy/server/http-requests'
import { createProxyAuthSwitch, type ProxyAuthSwitch } from '@proxy/server/proxy-auth'
import { providerBelowReserve } from '@proxy/server/route-reserve'
import { onRouteTotalsChange, routeTotals } from '@proxy/server/route-totals'
import { fileConfigReader } from '@proxy/server/routes'
import { listen } from '@proxy/server/startup'
import type { StatsWindow } from '@proxy/stats/windows'
import { accountRows, accountsSnapshot, type AccountsView } from '@proxy/tui/accounts-view'
import { inBackground, openLogin, openLogout, openSelected } from '@proxy/tui/console-accounts'
import { openSelectedModelsItem } from '@proxy/tui/console-models'
import { openStatsView, type StatsView } from '@proxy/tui/dashboard'
import { exposedModelsLabel } from '@proxy/tui/frame'
import { consoleLayout, type ConsoleLayout } from '@proxy/tui/layout'
import type { LogBuffer } from '@proxy/tui/log-buffer'
import { type LogViewport, logViewRows, scrollLogView, wheelLines } from '@proxy/tui/log-view'
import { loginLabels } from '@proxy/tui/login'
import { modelsItems, modelsRows, modelsViewData } from '@proxy/tui/models-view'
import { moveSelection, STATS_WINDOW_KEYS, stepView, type View } from '@proxy/tui/navigation'
import { openAuthMenu } from '@proxy/tui/proxy-auth-menu'
import {
  chatsById,
  requestsRows,
  type RequestsViewport,
  scrollRequestsView
} from '@proxy/tui/requests-view'
import { consoleScreen } from '@proxy/tui/screen'
import { type SidebarInput, sidebarRows } from '@proxy/tui/sidebar'
import { createRefresh, type RefreshState } from '@proxy/tui/status-refresh'
import { requestsPerMinute, type StatusStripInput } from '@proxy/tui/status-strip'
import { captureWrites } from '@proxy/tui/stderr-capture'
import { installConsoleTheme } from '@proxy/tui/theme'

import packageJson from '../../package.json' with { type: 'json' }

/** How often the status line and the accounts list are read again. */
const STATUS_REFRESH_MS = 5000
/** How often the sidebar's clocks (uptime, elapsed, time left) and connection count move on. */
const TICK_MS = 1000
/** Lines a page key scrolls the raw log or the Requests table by. */
const PAGE_LINES = 10
/** What the status line shows; read every few seconds, never the credentials themselves. */
interface Status {
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
}

/** The console's state, which every render reads. */
interface ConsoleState extends RefreshState<Status> {
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
  /** Open client connections, counted every tick; `undefined` before the first count. */
  connections: number | undefined
  /** Whether the operator hid the sidebar (`s`). */
  sidebarHidden: boolean
  /** The window the Stats dashboard shows. */
  statsWindow: StatsWindow
}

/** What the key handlers and the login flow need. */
export interface ConsoleContext {
  readonly config: ServerConfig
  readonly logs: LogBuffer
  readonly tui: TuiAltScreen
  readonly state: ConsoleState
  /** When the console started the proxy, in milliseconds since the epoch. */
  readonly startedAt: number
  /** The proxy auth the server applies, which the auth menu (`p`) changes. */
  readonly proxyAuth: ProxyAuthSwitch
  /** The Stats view: the dashboard, or the totals since the proxy started without stats. */
  readonly statsView: StatsView
  /**
   * Reads the status and accounts again, then redraws.
   *
   * @param verify - whether to resolve each credential now, which may refresh an OAuth token
   */
  refresh(verify?: boolean): Promise<void>
  /** Stops the console and the proxy. */
  quit(): void
}

/**
 * Reads the status line's data: available and exposed models, cooldowns, the models.json error.
 *
 * @returns the status
 */
async function readStatus(): Promise<Status> {
  const available = getAvailableModels()
  const config = await fileConfigReader()
  const exposure = computeModelExposure(available, config, getSupportedThinkingLevels)
  return {
    available: available.length,
    exposed: exposure.ok ? exposure.models.length : exposure.message,
    cooldowns: activeCooldowns().length,
    modelsJsonError: getModelsJsonError(),
    reserve: config.reserve ?? {},
    labels: loginLabels(),
    exposure: exposure.ok ? exposure : undefined,
    aliases: config.aliases
  }
}

/**
 * Gathers what the status strip shows, now: the proxy's address and auth, the last status read,
 * the uptime and connections, and the last half hour of finished chat requests.
 *
 * @param context - the console
 * @param now - the current time
 * @returns the snapshot
 */
function stripInput(context: ConsoleContext, now: number): StatusStripInput {
  const { config, state } = context
  const traffic = requestsPerMinute(finishedRequests(), now)
  // Before the first status read, the strip shows no model counts and no errors.
  const status =
    state.status === undefined
      ? { exposed: undefined, available: undefined, cooldowns: 0, modelsJsonError: false }
      : {
          exposed: state.status.exposed,
          available: state.status.available,
          cooldowns: state.status.cooldowns,
          modelsJsonError: state.status.modelsJsonError !== undefined
        }
  return {
    ...status,
    version: packageJson.version,
    address: `${config.host}:${String(config.port)}`,
    proxyAuth: context.proxyAuth.current().kind,
    uptimeMs: now - context.startedAt,
    connections: state.connections,
    perMinute: traffic.perMinute,
    saturated: traffic.saturated,
    todayCostUsd: context.statsView.todayCostUsd()
  }
}

/**
 * What the right end of the tab row says about each view: what is in flight on Requests, the logins
 * and cooldowns on Accounts, the window on Stats, the models and aliases on Models.
 */
const TAB_CONTEXT: Readonly<Record<View, (state: ConsoleState) => string>> = {
  logs: () => {
    const inFlight = activeRequests().length
    return inFlight === 0 ? 'idle' : `${String(inFlight)} in flight`
  },
  accounts: (state) =>
    `${String(state.accounts.length)} logins · ${String(state.status?.cooldowns ?? 0)} cooldowns`,
  stats: (state) => STATS_WINDOW_KEYS[state.statsWindow][1],
  models: (state) =>
    exposedModelsLabel(state.status?.exposed, Object.keys(state.status?.aliases ?? {}).length)
}

/**
 * What the right end of the frame's bottom border notes about each view: how many log lines,
 * logins or exposed models it holds, and on Stats how long the stats file keeps its history (nothing
 * while the view shows the totals instead).
 */
const FRAME_NOTE: Readonly<Record<View, (context: ConsoleContext) => string>> = {
  logs: ({ logs, state }) =>
    state.logRaw
      ? `raw log · ${String(logs.dropped() + logs.lines().length)} lines`
      : `${String(httpRequests().length)} requests`,
  accounts: ({ state }) => `${String(state.accounts.length)} logins`,
  stats: ({ statsView }) => statsView.frameNote(),
  models: ({ state }) => exposedModelsLabel(state.status?.exposed)
}

/** What the Accounts view takes from the status before the first read: no reserve, no labels. */
const NO_STATUS_SETTINGS: Pick<Status, 'reserve' | 'labels'> = { reserve: {}, labels: {} }

/**
 * Gathers what the Accounts view shows, now: the logins, the selected row, the labels, each
 * login's quota report and reserve check, and the cooldowns.
 *
 * @param state - the console's state: the accounts, the selected row, and the status with the
 *   reserve per login and the labels
 * @param now - the current time
 * @returns the snapshot
 */
function accountsView(state: ConsoleState, now: number): AccountsView {
  const { reserve, labels } = state.status ?? NO_STATUS_SETTINGS
  return accountsSnapshot(
    {
      accounts: state.accounts,
      selected: state.selected,
      labels,
      now,
      cooldowns: activeCooldowns(now)
    },
    {
      quota: (login) => providerQuota(login, now),
      belowReserve: (login) => providerBelowReserve(login, reserve, now)
    }
  )
}

/**
 * Renders the Models view from the console's state.
 *
 * @param state - the console's state: the last exposure and aliases read, and the selected row
 * @param size - the space available
 * @param size.height - rows
 * @param size.width - columns
 * @returns the rows
 */
function modelsViewRows(
  state: ConsoleState,
  size: { readonly height: number; readonly width: number }
): string[] {
  return modelsRows({ ...modelsViewData(state.status), selected: state.modelsSelected }, size)
}

/**
 * Renders the first view: the Requests table, or the raw log after `r`.
 *
 * @param state - the console's state: which of the two, and where each is
 * @param logs - the log buffer
 * @param size - the space available
 * @param size.height - rows
 * @param size.width - columns
 * @returns the rows
 */
function logsRows(
  state: ConsoleState,
  logs: LogBuffer,
  size: { readonly height: number; readonly width: number }
): string[] {
  if (state.logRaw) return logViewRows(state.logView, logs, size)
  const data = {
    requests: httpRequests(),
    chats: chatsById(activeRequests(), finishedRequests()),
    now: Date.now()
  }
  return requestsRows(state.requestsView, data, size)
}

/**
 * Scrolls the first view, the raw log or the Requests table, whichever is shown.
 *
 * @param context - the console
 * @param lines - lines or requests to scroll up (positive) or down (negative)
 */
function scrollLogs(context: ConsoleContext, lines: number): void {
  const { state } = context
  if (state.logRaw) state.logView = scrollLogView(state.logView, context.logs, lines)
  else state.requestsView = scrollRequestsView(state.requestsView, httpRequests(), lines)
}

/**
 * Renders the current view's body.
 *
 * @param context - the console
 * @param size - the space available
 * @param size.height - rows
 * @param size.width - columns
 * @returns the body's rows
 */
function viewRows(
  context: ConsoleContext,
  size: { readonly height: number; readonly width: number }
): string[] {
  const { state, logs } = context
  if (state.view === 'logs') return logsRows(state, logs, size)
  if (state.view === 'accounts') return accountRows(accountsView(state, Date.now()), size)
  if (state.view === 'models') return modelsViewRows(state, size)
  return context.statsView.rows(state.statsWindow, size)
}

/**
 * Gathers what the sidebar shows, now: each login with its label and quota, the cooldowns, the
 * requests in flight and the route totals.
 *
 * @param context - the console
 * @returns the snapshot
 */
function sidebarInput(context: ConsoleContext): SidebarInput {
  const { state } = context
  const now = Date.now()
  const status: Partial<Status> = state.status ?? {}
  const reserve = status.reserve ?? {}
  return {
    now,
    accounts: state.accounts.map((account) => ({
      provider: account.provider,
      type: account.type,
      label: status.labels?.[account.provider],
      models: account.availableModelCount,
      quota: providerQuota(account.provider, now),
      belowReserve: providerBelowReserve(account.provider, reserve, now) !== undefined
    })),
    cooldowns: activeCooldowns(now),
    active: activeRequests(),
    finished: finishedRequests(),
    totals: routeTotals()
  }
}

/**
 * Renders the screen for a layout: the strip, the framed view with the sidebar beside it, and the
 * footer.
 *
 * @param context - the console
 * @param layout - where everything goes
 * @returns the rows
 */
function screenRows(context: ConsoleContext, layout: ConsoleLayout): string[] {
  const now = Date.now()
  const sidebar =
    layout.sidebarWidth === undefined
      ? undefined
      : sidebarRows(sidebarInput(context), { height: layout.frameRows, width: layout.sidebarWidth })
  return consoleScreen({
    view: context.state.view,
    layout,
    now,
    strip: stripInput(context, now),
    context: TAB_CONTEXT[context.state.view](context.state),
    note: FRAME_NOTE[context.state.view](context),
    body: viewRows(context, { height: layout.viewHeight, width: layout.viewWidth }),
    sidebar
  })
}

/**
 * Creates the console's root component: the status strip, the tabs and the framed view with the
 * sidebar beside it on a wide enough terminal, and the footer on the screen's last row.
 *
 * @param context - the console
 * @param terminal - the terminal, for its height
 * @param handleInput - what a key does
 * @returns the component
 */
function createRootView(
  context: ConsoleContext,
  terminal: ProcessTerminal,
  handleInput: (data: string) => void
): Component {
  return {
    render(width) {
      const layout = consoleLayout(
        { columns: width, rows: terminal.rows },
        context.state.sidebarHidden
      )
      return screenRows(context, layout).map((row) => truncateToWidth(row, width))
    },
    handleInput,
    handleMouse(event) {
      // The wheel scrolls the first view, the table or the raw log; elsewhere it does nothing.
      const lines = wheelLines(event)
      if (lines === undefined || context.state.view !== 'logs') return undefined
      scrollLogs(context, lines)
      return { handled: true }
    },
    invalidate() {
      // Nothing is cached between renders.
    }
  }
}

/**
 * Moves the selection in the Models view, stopping at its ends.
 *
 * @param state - the console's state: the last status read and the selected row
 * @param step - rows to move: negative moves up
 * @returns the row moved to
 */
function moveModelsSelection(state: ConsoleState, step: number): number {
  const items = modelsItems(modelsViewData(state.status))
  return moveSelection(state.modelsSelected, items.length - 1, step)
}

/**
 * Moves within the current view: scrolls the logs, or moves the selection in the accounts.
 *
 * @param context - the console
 * @param step - lines or rows to move: positive moves down
 */
function moveWithin(context: ConsoleContext, step: number): void {
  const { state } = context
  if (state.view === 'logs') scrollLogs(context, -step)
  else if (state.view === 'accounts') {
    state.selected = moveSelection(state.selected, state.accounts.length, step)
  } else if (state.view === 'models') state.modelsSelected = moveModelsSelection(state, step)
}

/**
 * Lists the console's keys and what each does. Keys go to pi's dialogs instead while one is open.
 *
 * @param context - the console the actions act on
 * @returns each key with its action
 */
function keyActions(context: ConsoleContext): readonly (readonly [KeyId, () => void])[] {
  const { state } = context
  // The window keys act on the Stats view only, where the footer lists them.
  const pickWindow = (window: StatsWindow) => (): void => {
    if (state.view === 'stats') state.statsWindow = window
  }
  // Ends every cooldown (#182), in the views whose footer lists the key; the route ends one.
  const clearCooldowns = (): void => {
    if (state.view !== 'accounts' && state.view !== 'models') return
    clearCooldownsFor({})
    inBackground(context.refresh(), 'Reading the status')
  }
  return [
    ['q', () => context.quit()],
    [Key.ctrl('c'), () => context.quit()],
    ['1', () => (state.view = 'logs')],
    ['2', () => (state.view = 'accounts')],
    ['3', () => (state.view = 'stats')],
    ['4', () => (state.view = 'models')],
    [Key.tab, () => (state.view = stepView(state.view, 1))],
    [Key.right, () => (state.view = stepView(state.view, 1))],
    [Key.shift('tab'), () => (state.view = stepView(state.view, -1))],
    [Key.left, () => (state.view = stepView(state.view, -1))],
    [
      Key.enter,
      () => {
        if (state.view === 'accounts') openSelected(context)
        else if (state.view === 'models') openSelectedModelsItem(context)
      }
    ],
    ['n', () => openLogin(context)],
    ['x', () => inBackground(openLogout(context), 'Logout')],
    ['v', () => inBackground(context.refresh(true), 'Verifying the logins')],
    ['s', () => (state.sidebarHidden = !state.sidebarHidden)],
    ['c', clearCooldowns],
    ['p', () => inBackground(openAuthMenu(context.tui, context.config, context.proxyAuth), 'Auth')],
    ['t', pickWindow('today')],
    ['w', pickWindow('week')],
    ['a', pickWindow('all')],
    [Key.up, () => moveWithin(context, -1)],
    [Key.down, () => moveWithin(context, 1)],
    [Key.pageUp, () => moveWithin(context, -PAGE_LINES)],
    [Key.pageDown, () => moveWithin(context, PAGE_LINES)],
    [
      Key.end,
      () => {
        state.logView = undefined
        state.requestsView = undefined
      }
    ],
    // The Requests table or the raw log, on the first view, where the footer lists the key.
    [
      'r',
      () => {
        if (state.view === 'logs') state.logRaw = !state.logRaw
      }
    ]
  ]
}

/**
 * Creates a promise and the function that resolves it, in the executor form the project's ES2023
 * lib allows (`Promise.withResolvers` is ES2024).
 *
 * @returns the promise and its resolver
 */
function settleable(): { promise: Promise<void>; settle: () => void } {
  let settle: () => void = () => undefined
  const promise = new Promise<void>((resolve) => {
    settle = resolve
  })
  return { promise, settle }
}

/**
 * Starts what keeps the screen current: a redraw on every log line and every change to the route
 * totals, the chat requests in flight or the HTTP requests, the open connections counted and the
 * sidebar's clocks moved on every second, the status read every few seconds, and stray stderr
 * writes sent to the raw log.
 *
 * @param context - the console
 * @param server - the proxy's server, whose open connections the sidebar shows
 * @returns a function that stops them all
 */
function startUpdates(context: ConsoleContext, server: ServerType): () => void {
  const redraw = (): void => context.tui.requestRender()
  const unsubscribeLogs = context.logs.onChange(redraw)
  const unsubscribeTotals = onRouteTotalsChange(redraw)
  const unsubscribeActive = onActiveRequestsChange(redraw)
  const unsubscribeHttp = onHttpRequestsChange(redraw)
  const timer = setInterval(
    () => inBackground(context.refresh(), 'Reading the status'),
    STATUS_REFRESH_MS
  )
  const ticker = setInterval(() => {
    server.getConnections((error, count) => {
      if (error === null) context.state.connections = count
      redraw()
    })
  }, TICK_MS)
  const restoreStderr = captureWrites(process.stderr, context.logs)
  return () => {
    clearInterval(timer)
    clearInterval(ticker)
    unsubscribeLogs()
    unsubscribeTotals()
    unsubscribeActive()
    unsubscribeHttp()
    restoreStderr()
  }
}

/**
 * Ends the console on `SIGTERM`, `SIGHUP` or an uncaught exception, until the returned function is
 * called.
 *
 * @param stop - ends the console on a signal
 * @param crashed - ends the console on an uncaught exception, which it reports
 * @returns a function that removes the handlers
 */
function listenForStops(stop: () => void, crashed: (error: unknown) => void): () => void {
  process.on('uncaughtException', crashed)
  process.once('SIGTERM', stop)
  process.once('SIGHUP', stop)
  return () => {
    process.off('uncaughtException', crashed)
    process.off('SIGTERM', stop)
    process.off('SIGHUP', stop)
  }
}

/**
 * Runs the console until the operator quits or the process is told to stop: starts the server,
 * draws the screen, and stops both on the way out.
 *
 * @remarks
 * The server listens before the console takes over the terminal, so a port in use fails with the
 * terminal untouched. Once the screen is up, any way out (quit, a signal, an error, or an
 * uncaught exception) stops the screen, restores stderr and closes the server before the error,
 * if any, is rethrown for the command to report.
 *
 * @param config - the resolved server config
 * @param logs - the buffer LogTape already writes to
 * @throws whatever stopped the console other than a quit or a signal
 */
export async function runConsole(config: ServerConfig, logs: LogBuffer): Promise<void> {
  installConsoleTheme()
  // pi's login dialog copies its sign-in URL on pi's own `app.message.copy` key, Ctrl+X in pi;
  // without a binding its hint names no key. The console has no other pi app keys. The screen's
  // own viewport scrolling takes PgUp and PgDn before any component; the console's view always
  // fits the screen, so they go to the raw log instead.
  setKeybindings(
    new KeybindingsManager({
      ...TUI_KEYBINDINGS,
      'tui.altScreen.pageUp': { defaultKeys: [] },
      'tui.altScreen.pageDown': { defaultKeys: [] },
      'app.message.copy': { defaultKeys: 'ctrl+x', description: 'Copy the sign-in URL' }
    })
  )
  await initRegistry()
  const proxyAuth = createProxyAuthSwitch(config.proxyAuth)
  const server = await listen(config, proxyAuth)
  const terminal = new ProcessTerminal()
  // `auto` moves further on a fast wheel spin, for terminals that send one event per notch.
  const tui = new TuiAltScreen(terminal, undefined, undefined, { wheelScrollLines: 'auto' })
  const stopped = settleable()
  let crash: unknown
  const crashed = (error: unknown): void => {
    crash ??= error
    stopped.settle()
  }
  const state: ConsoleState = {
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
    connections: undefined,
    sidebarHidden: false,
    statsWindow: 'today'
  }
  const context: ConsoleContext = {
    config,
    logs,
    tui,
    state,
    startedAt: Date.now(),
    proxyAuth,
    statsView: openStatsView(config.statsEnabled),
    refresh: createRefresh(state, { status: readStatus, accounts: getCredentialStatuses }, () =>
      tui.requestRender()
    ),
    quit: stopped.settle
  }
  const actions = keyActions(context)
  const root = createRootView(context, terminal, (data) => {
    actions.find(([key]) => matchesKey(data, key))?.[1]()
    tui.requestRender()
  })
  const stopUpdates = startUpdates(context, server)
  const stopListening = listenForStops(stopped.settle, crashed)

  try {
    tui.addChild(root)
    tui.setFocus(root)
    tui.start()
    await context.refresh()
    await stopped.promise
  } finally {
    tui.stop()
    stopUpdates()
    stopListening()
    server.close()
    context.statsView.close()
  }
  if (crash instanceof Error) throw crash
  if (crash !== undefined) {
    throw new Error('The console stopped on a thrown value', { cause: crash })
  }
}
