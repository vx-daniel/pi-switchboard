/**
 * The console (`pi-switchboard tui`, #61): one process holds the HTTP server, a full-screen pi-tui
 * view and the proxy's model runtime. It shows the live logs, the proxy's status and pi's logins,
 * and runs logins and logouts on pi's own screens.
 *
 * @remarks
 * Quitting the console stops the proxy. Logins go through `src/tui/login.ts`, so a new login is
 * served at once, by the same runtime. While the console runs, a stray write to stderr (one that
 * bypasses LogTape) goes to the log view instead of corrupting the screen.
 *
 * @packageDocumentation
 */

import type { AuthType } from '@earendil-works/pi-ai'
import {
  ExtensionSelectorComponent,
  LoginDialogComponent,
  OAuthSelectorComponent
} from '@earendil-works/pi-coding-agent'
import {
  type Component,
  Key,
  type KeyId,
  matchesKey,
  type OverlayHandle,
  ProcessTerminal,
  truncateToWidth,
  TuiAltScreen,
  KeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS
} from '@earendil-works/pi-tui'
import type { ServerType } from '@hono/node-server'
import type { ServerConfig } from '@proxy/config/env'
import type { Reserve } from '@proxy/config/schema'
import { proxyLogger } from '@proxy/logging'
import { computeModelExposure } from '@proxy/openai/model-exposure'
import { activeCooldowns } from '@proxy/pi/cooldowns'
import { providerQuota } from '@proxy/pi/quota'
import {
  getAvailableModels,
  getCredentialStatuses,
  getLoginDeviceId,
  getModelsJsonError,
  getRuntime,
  initRegistry,
  type ProviderCredentialStatus,
  summarizeAuthError
} from '@proxy/pi/registry'
import {
  activeRequests,
  finishedRequests,
  onActiveRequestsChange
} from '@proxy/server/active-requests'
import { providerBelowReserve } from '@proxy/server/route-reserve'
import { onRouteTotalsChange, routeTotals } from '@proxy/server/route-totals'
import { fileConfigReader } from '@proxy/server/routes'
import { listen } from '@proxy/server/startup'
import { accountRows } from '@proxy/tui/accounts-view'
import { openStatsView, type StatsView, type StatsWindow } from '@proxy/tui/dashboard'
import type { LogBuffer } from '@proxy/tui/log-buffer'
import { type LogViewport, logViewRows, scrollLogView, wheelLogView } from '@proxy/tui/log-view'
import { loginOptions, logoutOptions, providerName, runLogin } from '@proxy/tui/login'
import {
  type AccountAction,
  accountActions,
  clampSelection,
  footerLine,
  moveSelection,
  stepView,
  tabsLine,
  type View
} from '@proxy/tui/navigation'
import { besideSidebar, type SidebarInput, sidebarRows, sidebarWidth } from '@proxy/tui/sidebar'
import { createRefresh, credentialChanged, type RefreshState } from '@proxy/tui/status-refresh'
import { captureWrites } from '@proxy/tui/stderr-capture'
import { chrome, installConsoleTheme, paint, strong } from '@proxy/tui/theme'

import packageJson from '../../package.json' with { type: 'json' }

/** Logger for the console's own actions. */
const consoleLogger = proxyLogger('tui')

/** How often the status line and the accounts list are read again. */
const STATUS_REFRESH_MS = 5000
/** How often the sidebar's clocks (uptime, elapsed, time left) and connection count move on. */
const TICK_MS = 1000
/** How long a logout may take. */
const LOGOUT_TIMEOUT_MS = 15_000
/** Lines a page key scrolls the log view by. */
const PAGE_LINES = 10
/** Rows the header, the tab bar and the footer take. */
const CHROME_ROWS = 3

/** What the status line shows; read every few seconds, never the credentials themselves. */
interface Status {
  readonly available: number
  /** Exposed model count, or the exposure config's error. */
  readonly exposed: number | string
  readonly cooldowns: number
  readonly modelsJsonError: string | undefined
  /** The quota reserve per provider (`routing.reserve`), to mark a provider below it. */
  readonly reserve: Reserve
}

/** The console's state, which every render reads. */
interface ConsoleState extends RefreshState<Status> {
  view: View
  /** Where the log view is: following new lines, or pinned to the lines on screen. */
  logView: LogViewport
  /** The selected row of the accounts view; the row after the accounts opens the login. */
  selected: number
  /** Open client connections, counted every tick; `undefined` before the first count. */
  connections: number | undefined
  /** Whether the operator hid the sidebar (`s`). */
  sidebarHidden: boolean
  /** The window the Stats dashboard shows. */
  statsWindow: StatsWindow
}

/** What the key handlers and the login flow need. */
interface ConsoleContext {
  readonly config: ServerConfig
  readonly logs: LogBuffer
  readonly tui: TuiAltScreen
  readonly state: ConsoleState
  /** When the console started the proxy, in milliseconds since the epoch. */
  readonly startedAt: number
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
 * Says why a login, a logout or a background task failed, in pi's first line only: pi's messages
 * can carry a provider's response after it.
 *
 * @param error - what was thrown
 * @returns the summary
 */
function failureReason(error: unknown): string {
  return summarizeAuthError(error instanceof Error ? error.message : String(error))
}

/**
 * Runs a task the console does not wait for, logging a failure instead of dropping it.
 *
 * @param task - the running task
 * @param what - what it does, for the log line
 */
function inBackground(task: Promise<void>, what: string): void {
  task.catch((error: unknown) => {
    consoleLogger.error('{what} failed: {reason}', { what, reason: failureReason(error) })
  })
}

/**
 * Reads the status line's data: available and exposed models, cooldowns, the models.json error.
 *
 * @returns the status
 */
async function readStatus(): Promise<Status> {
  const available = getAvailableModels()
  const config = await fileConfigReader()
  const exposure = computeModelExposure(available, config)
  return {
    available: available.length,
    exposed: exposure.ok ? exposure.models.length : exposure.message,
    cooldowns: activeCooldowns().length,
    modelsJsonError: getModelsJsonError(),
    reserve: config.reserve ?? {}
  }
}

/**
 * Renders the status part of the header: exposed models, cooldowns, a models.json error.
 *
 * @param status - the last status read
 * @returns the parts, in order
 */
function statusParts(status: Status): string[] {
  const exposed =
    typeof status.exposed === 'number'
      ? `${String(status.exposed)}/${String(status.available)} exposed`
      : paint('error', `exposure config: ${status.exposed}`)
  const parts = [exposed, `${String(status.cooldowns)} cooldowns`]
  if (status.modelsJsonError !== undefined) parts.push(paint('error', 'models.json error'))
  return parts
}

/**
 * Renders the header: version and address, then auth and the status line unless the sidebar shows
 * them.
 *
 * @param config - the server config
 * @param status - the last status read, or `undefined` before the first
 * @param withSidebar - whether the sidebar is shown, with the status in its PROXY panel
 * @returns the header line, untruncated
 */
function headerLine(
  config: ServerConfig,
  status: Status | undefined,
  withSidebar: boolean
): string {
  const title = strong(paint('accent', ` pi-switchboard ${packageJson.version}`))
  const address = `${config.host}:${String(config.port)}`
  if (withSidebar) return [title, address].join(' · ')
  const parts = [title, address, `auth ${config.proxyAuth.kind}`]
  if (status !== undefined) parts.push(...statusParts(status))
  return parts.join(' · ')
}

/**
 * Renders the Accounts view from the console's state.
 *
 * @param state - the console's state: the accounts, the selected row, and the status with the
 *   reserve per provider
 * @param height - rows available
 * @returns the rows
 */
function accountsViewRows(state: ConsoleState, height: number): string[] {
  const view = {
    accounts: state.accounts,
    selected: state.selected,
    reserve: state.status?.reserve ?? {}
  }
  return accountRows(view, height)
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
  if (state.view === 'logs') return logViewRows(state.logView, logs, size)
  if (state.view === 'accounts') return accountsViewRows(state, size.height)
  return context.statsView.rows(state.statsWindow, size)
}

/**
 * Gathers what the sidebar shows, now: the proxy's status, each login with its quota, the
 * cooldowns, the requests in flight and the route totals.
 *
 * @param context - the console
 * @returns the snapshot
 */
function sidebarInput(context: ConsoleContext): SidebarInput {
  const { config, state } = context
  const now = Date.now()
  const status: Partial<Status> = state.status ?? {}
  const reserve = status.reserve ?? {}
  return {
    now,
    proxy: {
      address: `${config.host}:${String(config.port)}`,
      proxyAuth: config.proxyAuth.kind,
      startedAt: context.startedAt,
      connections: state.connections,
      exposed: status.exposed,
      available: status.available,
      modelsJsonError: status.modelsJsonError !== undefined
    },
    accounts: state.accounts.map((account) => ({
      provider: account.provider,
      type: account.type,
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
 * Renders the sidebar on the chrome's background, down to the bottom of the screen: the rows
 * below its last panel are background too.
 *
 * @param context - the console
 * @param height - the rows the sidebar covers, from the tab bar to the footer
 * @param width - the sidebar's columns
 * @returns the rows
 */
function sidebarChrome(context: ConsoleContext, height: number, width: number): string[] {
  const rows = sidebarRows(sidebarInput(context), { height, width })
  return Array.from({ length: height }, (_, row) => chrome(rows[row] ?? '', width))
}

/**
 * Creates the console's root component: the header, then the tab bar over the current view with
 * the sidebar beside them on a wide enough terminal, and the footer on the screen's last row.
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
      const height = Math.max(1, terminal.rows - CHROME_ROWS)
      const { state, config } = context
      const side = state.sidebarHidden ? undefined : sidebarWidth(width)
      const mainWidth = side === undefined ? width : width - side - 1
      const body = viewRows(context, { height, width: mainWidth })
      const main = [
        chrome(tabsLine(state.view), mainWidth),
        ...body,
        ...Array.from({ length: Math.max(0, height - body.length) }, () => '')
      ]
      const middle =
        side === undefined
          ? main
          : besideSidebar(main, sidebarChrome(context, main.length, side), mainWidth)
      const rows = [
        chrome(headerLine(config, state.status, side !== undefined), width),
        ...middle,
        footerLine(state.view, sidebarWidth(width) !== undefined)
      ]
      return rows.map((row) => truncateToWidth(row, width))
    },
    handleInput,
    handleMouse(event) {
      // The wheel scrolls the log view; elsewhere it does nothing.
      const { state } = context
      if (event.type !== 'wheel' || state.view !== 'logs') return undefined
      state.logView = wheelLogView(state.logView, context.logs, event)
      return { handled: true }
    },
    invalidate() {
      // Nothing is cached between renders.
    }
  }
}

/**
 * Shows a component in the middle of the screen, with keyboard focus.
 *
 * @param tui - the screen
 * @param component - the component, one of pi's selectors or its login dialog
 * @returns the overlay's handle
 */
function showDialog(tui: TuiAltScreen, component: Component): OverlayHandle {
  return tui.showOverlay(component, { width: '80%', maxHeight: '80%', anchor: 'center' })
}

/**
 * Shows pi's selector for a choice a login asks for, such as the login method.
 *
 * @param tui - the screen
 * @param prompt - the choice
 * @param prompt.message - the question
 * @param prompt.options - the options, each with its ID and label
 * @returns the chosen option's ID; rejects with `Login cancelled` when cancelled
 */
function selectOption(
  tui: TuiAltScreen,
  prompt: { readonly message: string; readonly options: readonly { id: string; label: string }[] }
): Promise<string> {
  return new Promise((resolve, reject) => {
    const labels = prompt.options.map((option) => option.label)
    const selector = new ExtensionSelectorComponent(
      prompt.message,
      labels,
      (label) => {
        handle.hide()
        const option = prompt.options.find((candidate) => candidate.label === label)
        if (option === undefined) reject(new Error('Login cancelled'))
        else resolve(option.id)
      },
      () => {
        handle.hide()
        reject(new Error('Login cancelled'))
      }
    )
    const handle = showDialog(tui, selector)
  })
}

/**
 * Runs pi's login for one provider on pi's login dialog, and logs how it ended.
 *
 * @param context - the console
 * @param providerId - the provider to log in to
 * @param type - `oauth` (an account) or `api_key`
 */
async function loginTo(context: ConsoleContext, providerId: string, type: AuthType): Promise<void> {
  const runtime = getRuntime()
  const name = providerName(runtime, providerId)
  const dialog = new LoginDialogComponent(context.tui, providerId, () => undefined, name)
  const handle = showDialog(context.tui, dialog)
  try {
    await runLogin(
      runtime,
      { providerId, type, deviceId: getLoginDeviceId },
      { dialog, select: (prompt) => selectOption(context.tui, prompt) }
    )
  } catch (error) {
    consoleLogger.warn('Login to {provider} ended: {reason}', {
      provider: providerId,
      reason: failureReason(error)
    })
  } finally {
    handle.hide()
    credentialChanged(context.state, providerId)
    await context.refresh()
  }
}

/**
 * Opens pi's provider selector and logs in to the chosen provider.
 *
 * @param context - the console
 */
function openLogin(context: ConsoleContext): void {
  const selector = new OAuthSelectorComponent(
    'login',
    loginOptions(getRuntime()),
    (providerId, type) => {
      handle.hide()
      inBackground(loginTo(context, providerId, type), 'Login')
    },
    () => handle.hide()
  )
  const handle = showDialog(context.tui, selector)
}

/**
 * Logs out of one provider: pi removes its stored credential.
 *
 * @param context - the console
 * @param providerId - the provider to log out of
 */
async function logoutOf(context: ConsoleContext, providerId: string): Promise<void> {
  try {
    await getRuntime().logout(providerId, { signal: AbortSignal.timeout(LOGOUT_TIMEOUT_MS) })
    consoleLogger.info('Logged out of {provider}', { provider: providerId })
  } catch (error) {
    consoleLogger.warn('Logout of {provider} failed: {reason}', {
      provider: providerId,
      reason: failureReason(error)
    })
  }
  credentialChanged(context.state, providerId)
  await context.refresh()
}

/**
 * Opens pi's selector of stored credentials and logs out of the chosen provider.
 *
 * @param context - the console
 */
async function openLogout(context: ConsoleContext): Promise<void> {
  const options = await logoutOptions(getRuntime())
  const selector = new OAuthSelectorComponent(
    'logout',
    options,
    (providerId) => {
      handle.hide()
      inBackground(logoutOf(context, providerId), 'Logout')
    },
    () => handle.hide()
  )
  const handle = showDialog(context.tui, selector)
}

/**
 * Opens the action menu for the selected account, or pi's login selector on the login row.
 *
 * @param context - the console
 */
function openSelected(context: ConsoleContext): void {
  const { state } = context
  const account = state.accounts[clampSelection(state.selected, state.accounts.length)]
  if (account === undefined) {
    openLogin(context)
    return
  }
  const choices = accountActions(account)
  const selector = new ExtensionSelectorComponent(
    account.provider,
    choices.map((choice) => choice.label),
    (label) => {
      handle.hide()
      const chosen = choices.find((choice) => choice.label === label)
      if (chosen !== undefined) runAccountAction(context, account, chosen.action)
    },
    () => handle.hide()
  )
  const handle = showDialog(context.tui, selector)
}

/**
 * Runs an action chosen from an account's menu.
 *
 * @param context - the console
 * @param account - the account it acts on
 * @param action - what to do
 */
function runAccountAction(
  context: ConsoleContext,
  account: ProviderCredentialStatus,
  action: AccountAction
): void {
  if (action === 'verify') inBackground(context.refresh(true), 'Verifying the logins')
  else if (action === 'login') {
    inBackground(loginTo(context, account.provider, account.type), 'Login')
  } else inBackground(logoutOf(context, account.provider), 'Logout')
}

/**
 * Moves within the current view: scrolls the logs, or moves the selection in the accounts.
 *
 * @param context - the console
 * @param step - lines or rows to move: positive moves down
 */
function moveWithin(context: ConsoleContext, step: number): void {
  const { state } = context
  if (state.view === 'logs') state.logView = scrollLogView(state.logView, context.logs, -step)
  else if (state.view === 'accounts') {
    state.selected = moveSelection(state.selected, state.accounts.length, step)
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
  return [
    ['q', () => context.quit()],
    [Key.ctrl('c'), () => context.quit()],
    ['1', () => (state.view = 'logs')],
    ['2', () => (state.view = 'accounts')],
    ['3', () => (state.view = 'stats')],
    [Key.tab, () => (state.view = stepView(state.view, 1))],
    [Key.right, () => (state.view = stepView(state.view, 1))],
    [Key.shift('tab'), () => (state.view = stepView(state.view, -1))],
    [Key.left, () => (state.view = stepView(state.view, -1))],
    [
      Key.enter,
      () => {
        if (state.view === 'accounts') openSelected(context)
      }
    ],
    ['n', () => openLogin(context)],
    ['x', () => inBackground(openLogout(context), 'Logout')],
    ['v', () => inBackground(context.refresh(true), 'Verifying the logins')],
    ['s', () => (state.sidebarHidden = !state.sidebarHidden)],
    ['t', pickWindow('today')],
    ['w', pickWindow('week')],
    ['a', pickWindow('all')],
    [Key.up, () => moveWithin(context, -1)],
    [Key.down, () => moveWithin(context, 1)],
    [Key.pageUp, () => moveWithin(context, -PAGE_LINES)],
    [Key.pageDown, () => moveWithin(context, PAGE_LINES)],
    [Key.end, () => (state.logView = undefined)]
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
 * totals or the requests in flight, the open connections counted and the sidebar's clocks moved on
 * every second, the status read every few seconds, and stray stderr writes sent to the log view.
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
  // fits the screen, so they go to the log view instead.
  setKeybindings(
    new KeybindingsManager({
      ...TUI_KEYBINDINGS,
      'tui.altScreen.pageUp': { defaultKeys: [] },
      'tui.altScreen.pageDown': { defaultKeys: [] },
      'app.message.copy': { defaultKeys: 'ctrl+x', description: 'Copy the sign-in URL' }
    })
  )
  await initRegistry()
  const server = await listen(config)
  const statsView = openStatsView(config.statsEnabled)
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
    logView: undefined,
    status: undefined,
    accounts: [],
    verification: new Map(),
    credentialChanges: new Map(),
    selected: 0,
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
    statsView,
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
    statsView.close()
  }
  if (crash instanceof Error) throw crash
  if (crash !== undefined) {
    throw new Error('The console stopped on a thrown value', { cause: crash })
  }
}
