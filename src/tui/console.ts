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
  TuiAltScreen
} from '@earendil-works/pi-tui'
import type { ServerConfig } from '@proxy/config/env'
import { computeModelExposure } from '@proxy/openai/model-exposure'
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
import { consoleEvents, onConsoleEventsChange } from '@proxy/server/console-events'
import { httpRequests, onHttpRequestsChange } from '@proxy/server/http-requests'
import { createProxyAuthSwitch, type ProxyAuthSwitch } from '@proxy/server/proxy-auth'
import { providerBelowReserve } from '@proxy/server/route-reserve'
import { onRouteTotalsChange, routeTotals } from '@proxy/server/route-totals'
import { fileConfigReader } from '@proxy/server/routes'
import { isLoopbackHost } from '@proxy/server/startup'
import type { StatsWindow } from '@proxy/stats/windows'
import { accountRows, accountsSnapshot, type AccountsView } from '@proxy/tui/accounts-view'
import { inBackground, openLogin, openLogout, openSelected } from '@proxy/tui/console-accounts'
import { openSelectedModelsItem } from '@proxy/tui/console-models'
import {
  currentSettingRows,
  openRestart,
  openSelectedSetting,
  settingsContext
} from '@proxy/tui/console-settings'
import {
  configFileStatus,
  type ConsoleState,
  initialState,
  type Status
} from '@proxy/tui/console-state'
import { consoleStop, listenForStops } from '@proxy/tui/console-stops'
import { openStatsView, type StatsView } from '@proxy/tui/dashboard'
import { exposedModelsLabel } from '@proxy/tui/frame'
import { consoleLayout, type ConsoleLayout } from '@proxy/tui/layout'
import type { LogBuffer } from '@proxy/tui/log-buffer'
import { logViewRows, scrollLogView, wheelLines } from '@proxy/tui/log-view'
import { modelsItems, modelsRows, modelsViewData } from '@proxy/tui/models-view'
import {
  installKeybindings,
  moveSelection,
  STATS_WINDOW_KEYS,
  stepView,
  type View
} from '@proxy/tui/navigation'
import { openAuthMenu, openAuthOffPrompt } from '@proxy/tui/proxy-auth-menu'
import {
  type ConsoleServer,
  type ConsoleStartup,
  createRestart,
  type RestartReport,
  startConsoleServer
} from '@proxy/tui/proxy-server'
import { chatsById, requestsRows, scrollRequestsView, tableEntries } from '@proxy/tui/requests-view'
import { consoleScreen } from '@proxy/tui/screen'
import { SETTING_KEYS, settingsViewRows } from '@proxy/tui/settings-view'
import { type SidebarInput, sidebarRows } from '@proxy/tui/sidebar'
import { createRefresh } from '@proxy/tui/status-refresh'
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
/** What the key handlers and the login flow need. */
export interface ConsoleContext {
  /** The config the server runs with now; a restart replaces it. */
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
  /** What the console was started with. */
  readonly startup: ConsoleStartup
  /**
   * Reads the status and accounts again, then redraws.
   *
   * @param verify - whether to resolve each credential now, which may refresh an OAuth token
   */
  refresh(verify?: boolean): Promise<void>
  /**
   * Restarts the server with the saved settings, without leaving the console (#288).
   *
   * @returns what the restart did
   */
  restart(): Promise<RestartReport>
  /** Stops the console and the proxy. */
  quit(): void
}

/**
 * Reads the status line's data: available and exposed models, cooldowns, the models.json error,
 * and the config file as the Settings view and the login labels need it.
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
    exposure: exposure.ok ? exposure : undefined,
    aliases: config.aliases,
    ...configFileStatus()
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
    beyondLoopback: !isLoopbackHost(config.host),
    uptimeMs: now - context.startedAt,
    connections: state.connections,
    perMinute: traffic.perMinute,
    saturated: traffic.saturated,
    todayCostUsd: context.statsView.todayCostUsd()
  }
}

/**
 * What the right end of the tab row says about each view: what is in flight on Requests, the logins
 * and cooldowns on Accounts, the window on Stats, the models and aliases on Models, and on Settings
 * whether a restart is due.
 */
const TAB_CONTEXT: Readonly<Record<View, (context: ConsoleContext) => string>> = {
  logs: () => {
    const inFlight = activeRequests().length
    return inFlight === 0 ? 'idle' : `${String(inFlight)} in flight`
  },
  accounts: ({ state }) =>
    `${String(state.accounts.length)} logins · ${String(state.status?.cooldowns ?? 0)} cooldowns`,
  stats: ({ state }) => STATS_WINDOW_KEYS[state.statsWindow][1],
  models: ({ state }) =>
    exposedModelsLabel(
      state.status?.exposed,
      Object.keys(modelsViewData(state.status).aliases).length
    ),
  settings: settingsContext
}

/**
 * What the right end of the frame's bottom border notes about each view: how many log lines,
 * logins or exposed models it holds, on Stats how long the stats file keeps its history (nothing
 * while the view shows the totals instead), and on Settings the file they are saved to.
 */
const FRAME_NOTE: Readonly<Record<View, (context: ConsoleContext) => string>> = {
  logs: ({ logs, state }) =>
    state.logRaw
      ? `raw log · ${String(logs.dropped() + logs.lines().length)} lines`
      : `${String(httpRequests().length)} requests`,
  accounts: ({ state }) => `${String(state.accounts.length)} logins`,
  stats: ({ statsView }) => statsView.frameNote(),
  models: ({ state }) => exposedModelsLabel(state.status?.exposed),
  settings: () => 'proxy-config.json'
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
    events: consoleEvents(),
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
  else {
    const entries = tableEntries(httpRequests(), consoleEvents())
    state.requestsView = scrollRequestsView(state.requestsView, entries, lines)
  }
}

/** The space a view's body has: rows and columns. */
interface ViewSize {
  readonly height: number
  readonly width: number
}

/** How each view renders its body, from the console and the space it has. */
const VIEW_ROWS: Readonly<Record<View, (context: ConsoleContext, size: ViewSize) => string[]>> = {
  logs: ({ state, logs }, size) => logsRows(state, logs, size),
  accounts: ({ state }, size) => accountRows(accountsView(state, Date.now()), size),
  stats: ({ state, statsView }, size) => statsView.rows(state.statsWindow, size),
  models: ({ state }, size) => modelsViewRows(state, size),
  settings: (context, size) =>
    settingsViewRows(
      currentSettingRows(context),
      context.state.settingsSelected,
      size,
      context.state.status?.fileProblem
    )
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
 * Names where the proxy listens while proxy auth is off and it listens beyond loopback, for the
 * alert row (#287). Read on every render, so `p` and a restart change it at once.
 *
 * @param context - the console: the auth applied now and the config running
 * @returns `host:port`, or `undefined` while there is nothing to alert
 */
function authOffAt(context: ConsoleContext): string | undefined {
  const { host, port } = context.config
  if (context.proxyAuth.current().kind !== 'off' || isLoopbackHost(host)) return undefined
  return `${host}:${String(port)}`
}

/**
 * Renders the screen for a layout: the strip, the alert row, the framed view with the sidebar
 * beside it, and the footer.
 *
 * @param context - the console
 * @param layout - where everything goes
 * @param alertAt - the address for the alert row, or `undefined` for none
 * @returns the rows
 */
function screenRows(
  context: ConsoleContext,
  layout: ConsoleLayout,
  alertAt: string | undefined
): string[] {
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
    context: TAB_CONTEXT[context.state.view](context),
    note: FRAME_NOTE[context.state.view](context),
    body: VIEW_ROWS[context.state.view](context, {
      height: layout.viewHeight,
      width: layout.viewWidth
    }),
    sidebar,
    authOffAt: alertAt
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
      const alertAt = authOffAt(context)
      const layout = consoleLayout(
        { columns: width, rows: terminal.rows },
        context.state.sidebarHidden,
        alertAt !== undefined
      )
      return screenRows(context, layout, alertAt).map((row) => truncateToWidth(row, width))
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
 * How `↑` `↓` and the page keys move within each view: scroll the logs, or move the selection in
 * the accounts, the models or the settings; nothing on Stats.
 */
const MOVES: Readonly<Record<View, (context: ConsoleContext, step: number) => void>> = {
  logs: (context, step) => scrollLogs(context, -step),
  accounts: ({ state }, step) => {
    state.selected = moveSelection(state.selected, state.accounts.length, step)
  },
  stats: () => undefined,
  models: ({ state }, step) => {
    state.modelsSelected = moveModelsSelection(state, step)
  },
  settings: ({ state }, step) => {
    state.settingsSelected = moveSelection(state.settingsSelected, SETTING_KEYS.length - 1, step)
  }
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
    ['5', () => (state.view = 'settings')],
    [Key.tab, () => (state.view = stepView(state.view, 1))],
    [Key.right, () => (state.view = stepView(state.view, 1))],
    [Key.shift('tab'), () => (state.view = stepView(state.view, -1))],
    [Key.left, () => (state.view = stepView(state.view, -1))],
    [
      Key.enter,
      () => {
        if (state.view === 'accounts') openSelected(context)
        else if (state.view === 'models') openSelectedModelsItem(context)
        else if (state.view === 'settings') openSelectedSetting(context)
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
    [Key.up, () => MOVES[state.view](context, -1)],
    [Key.down, () => MOVES[state.view](context, 1)],
    [Key.pageUp, () => MOVES[state.view](context, -PAGE_LINES)],
    [Key.pageDown, () => MOVES[state.view](context, PAGE_LINES)],
    [
      Key.end,
      () => {
        state.logView = undefined
        state.requestsView = undefined
      }
    ],
    // The Requests table or the raw log on the first view; a server restart on Settings (#288).
    [
      'r',
      () => {
        if (state.view === 'logs') state.logRaw = !state.logRaw
        else if (state.view === 'settings') openRestart(context)
      }
    ]
  ]
}

/**
 * Starts what keeps the screen current: a redraw on every log line and every change to the route
 * totals, the chat requests in flight or the HTTP requests, the open connections counted and the
 * sidebar's clocks moved on every second, the status read every few seconds, and stray stderr
 * writes sent to the raw log.
 *
 * @param context - the console
 * @param server - the proxy's server, whose open connections the sidebar shows; read each tick,
 *   since a restart replaces it
 * @returns a function that stops them all
 */
function startUpdates(context: ConsoleContext, server: ConsoleServer): () => void {
  const redraw = (): void => context.tui.requestRender()
  const unsubscribeLogs = context.logs.onChange(redraw)
  const unsubscribeTotals = onRouteTotalsChange(redraw)
  const unsubscribeActive = onActiveRequestsChange(redraw)
  const unsubscribeHttp = onHttpRequestsChange(redraw)
  const unsubscribeEvents = onConsoleEventsChange(redraw)
  const timer = setInterval(
    () => inBackground(context.refresh(), 'Reading the status'),
    STATUS_REFRESH_MS
  )
  const ticker = setInterval(() => {
    server.server().getConnections((error, count) => {
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
    unsubscribeEvents()
    restoreStderr()
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
 * @param startup - the overrides, and how to reload the config and set the log level, for restarts
 * @throws whatever stopped the console other than a quit or a signal
 */
export async function runConsole(
  config: ServerConfig,
  logs: LogBuffer,
  startup: ConsoleStartup
): Promise<void> {
  installConsoleTheme()
  installKeybindings()
  await initRegistry()
  const proxyAuth = createProxyAuthSwitch(config.proxyAuth)
  const server = await startConsoleServer(config, proxyAuth)
  const terminal = new ProcessTerminal()
  // `auto` moves further on a fast wheel spin, for terminals that send one event per notch.
  const tui = new TuiAltScreen(terminal, undefined, undefined, { wheelScrollLines: 'auto' })
  const end = consoleStop()
  const state = initialState()
  const stats = { view: openStatsView(config.statsEnabled) }
  const refresh = createRefresh(
    state,
    { status: readStatus, accounts: getCredentialStatuses },
    () => tui.requestRender()
  )
  const context: ConsoleContext = {
    get config() {
      return server.config()
    },
    logs,
    tui,
    state,
    startedAt: Date.now(),
    proxyAuth,
    get statsView() {
      return stats.view
    },
    startup,
    refresh,
    restart: createRestart({
      server,
      startup,
      stats,
      openStats: openStatsView,
      crashed: end.crashed,
      refresh: () => refresh()
    }),
    quit: end.stop
  }
  const actions = keyActions(context)
  const root = createRootView(context, terminal, (data) => {
    actions.find(([key]) => matchesKey(data, key))?.[1]()
    tui.requestRender()
  })
  const stopUpdates = startUpdates(context, server)
  const stopListening = listenForStops(end)

  try {
    tui.addChild(root)
    tui.setFocus(root)
    tui.start()
    // Started with proxy auth off: say so in a popup that offers to set a token (#287). Shown in
    // this same turn, before any key is read, so `p` can't open its menu underneath it.
    inBackground(openAuthOffPrompt(tui, context.config, proxyAuth), 'Auth')
    await context.refresh()
    await end.stopped
  } finally {
    tui.stop()
    stopUpdates()
    stopListening()
    server.close()
    stats.view.close()
  }
  end.rethrow()
}
