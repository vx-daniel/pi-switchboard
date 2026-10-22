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

import { styleText } from 'node:util'

import type { AuthType } from '@earendil-works/pi-ai'
import {
  ExtensionSelectorComponent,
  initTheme,
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
import type { ServerConfig } from '@proxy/config/env'
import { proxyLogger } from '@proxy/logging'
import { computeModelExposure } from '@proxy/openai/model-exposure'
import { activeCooldowns } from '@proxy/pi/cooldowns'
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
import { onRouteTotalsChange, routeTotals, routeTotalsSince } from '@proxy/server/route-totals'
import { fileConfigReader } from '@proxy/server/routes'
import { listen } from '@proxy/server/startup'
import type { LogBuffer } from '@proxy/tui/log-buffer'
import { loginOptions, logoutOptions, providerName, runLogin } from '@proxy/tui/login'
import { statsRows } from '@proxy/tui/stats-view'

import packageJson from '../../package.json' with { type: 'json' }

/** Logger for the console's own actions. */
const consoleLogger = proxyLogger('tui')

/** How often the status line and the accounts list are read again. */
const STATUS_REFRESH_MS = 5000
/** How long a logout may take. */
const LOGOUT_TIMEOUT_MS = 15_000
/** Lines a page key scrolls the log view by. */
const PAGE_LINES = 10
/** Rows the header, the tab bar and the footer take. */
const CHROME_ROWS = 3
/** Widths of the accounts view's columns: provider, auth type, source, model count. */
const COLUMNS = { provider: 28, login: 8, source: 16, models: 4 } as const

/** The console's views. */
type View = 'logs' | 'accounts' | 'stats'

/** What the status line shows; read every few seconds, never the credentials themselves. */
interface Status {
  readonly available: number
  /** Exposed model count, or the exposure config's error. */
  readonly exposed: number | string
  readonly cooldowns: number
  readonly modelsJsonError: string | undefined
}

/** The console's state, which every render reads. */
interface ConsoleState {
  view: View
  /** Lines scrolled up from the newest log line; 0 follows new lines. */
  scrolledBack: number
  status: Status | undefined
  accounts: readonly ProviderCredentialStatus[]
  /** The last verification of each provider (`v`), kept until its next login or logout. */
  verification: Map<string, Verification>
}

/** A provider's last verification result. */
type Verification = Pick<ProviderCredentialStatus, 'verified' | 'error'>

/**
 * Keeps a status's verification result, with only the fields it has.
 *
 * @param account - a status read with `verify`
 * @returns its verification
 */
function verificationOf({ verified, error }: ProviderCredentialStatus): Verification {
  return {
    ...(verified === undefined ? {} : { verified }),
    ...(error === undefined ? {} : { error })
  }
}

/** What the key handlers and the login flow need. */
interface ConsoleContext {
  readonly config: ServerConfig
  readonly logs: LogBuffer
  readonly tui: TuiAltScreen
  readonly state: ConsoleState
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
  const exposure = computeModelExposure(available, await fileConfigReader())
  return {
    available: available.length,
    exposed: exposure.ok ? exposure.models.length : exposure.message,
    cooldowns: activeCooldowns().length,
    modelsJsonError: getModelsJsonError()
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
      ? `${String(status.exposed)}/${String(status.available)} models exposed`
      : styleText('red', `exposure config: ${status.exposed}`)
  const parts = [exposed, `${String(status.cooldowns)} cooldowns`]
  if (status.modelsJsonError !== undefined) parts.push(styleText('red', 'models.json error'))
  return parts
}

/**
 * Renders the header: version, address, auth and the status line.
 *
 * @param config - the server config
 * @param status - the last status read, or `undefined` before the first
 * @returns the header line, untruncated
 */
function headerLine(config: ServerConfig, status: Status | undefined): string {
  const title = styleText('bold', ` pi-switchboard ${packageJson.version}`)
  const address = `http://${config.host}:${String(config.port)}`
  const parts = [title, address, `auth ${config.proxyAuth.kind}`]
  if (status !== undefined) parts.push(...statusParts(status))
  return parts.join(' · ')
}

/**
 * Renders the tab bar, marking the current view.
 *
 * @param view - the current view
 * @returns the tab bar line
 */
function tabsLine(view: View): string {
  const tabs: readonly (readonly [View, string])[] = [
    ['logs', ' 1 Logs '],
    ['accounts', ' 2 Accounts '],
    ['stats', ' 3 Stats ']
  ]
  const shown = tabs.map(([tab, label]) =>
    tab === view ? styleText(['bold', 'inverse'], label) : label
  )
  return ` ${shown.join(' ')}`
}

/** The footer's key hints for each view. */
const FOOTER: Readonly<Record<View, string>> = {
  logs: ' ↑↓ PgUp PgDn scroll · End follow · n login · x logout · q quit (stops the proxy)',
  accounts: ' v verify · n login · x logout · q quit (stops the proxy)',
  stats: ' per alias and served model, since the proxy started · q quit (stops the proxy)'
}

/**
 * Renders the newest log lines that fit, or older ones when scrolled back.
 *
 * @param lines - every buffered log line, oldest first
 * @param scrolledBack - lines scrolled up from the newest
 * @param height - rows available
 * @returns the rows, padded at the top when there are fewer lines
 */
function logRows(lines: readonly string[], scrolledBack: number, height: number): string[] {
  const end = lines.length - scrolledBack
  const rows = lines.slice(Math.max(0, end - height), end)
  return [...Array.from({ length: height - rows.length }, () => ''), ...rows]
}

/**
 * Renders whether a provider's credential was verified, when it was.
 *
 * @param account - the provider's status
 * @returns `''` when not verified, else a mark and, on failure, why
 */
function verification(account: ProviderCredentialStatus): string {
  if (account.verified === undefined) return ''
  if (account.verified) return styleText('green', ' ✓ verified')
  return styleText('red', ` ✗ ${account.error ?? 'failed'}`)
}

/**
 * Renders one provider's credential status: provider, auth type, source, models, verification.
 *
 * @param account - the provider's status; never the credential itself
 * @returns the row
 */
function accountRow(account: ProviderCredentialStatus): string {
  const login = account.type === 'oauth' ? 'account' : 'API key'
  const cells = [
    account.provider.padEnd(COLUMNS.provider),
    login.padEnd(COLUMNS.login),
    (account.source ?? '').padEnd(COLUMNS.source),
    String(account.availableModelCount).padStart(COLUMNS.models)
  ]
  return `  ${cells.join(' ')} models${verification(account)}`
}

/**
 * Renders the accounts view: pi's configured providers, as the proxy sees them.
 *
 * @param accounts - the providers pi has a credential for
 * @param height - rows available
 * @returns the rows
 */
function accountRows(accounts: readonly ProviderCredentialStatus[], height: number): string[] {
  const titles = [
    'provider'.padEnd(COLUMNS.provider),
    'login'.padEnd(COLUMNS.login),
    'source'.padEnd(COLUMNS.source),
    'models'
  ]
  const body =
    accounts.length === 0
      ? ['  No logins yet: press n to log in with pi.']
      : accounts.map((account) => accountRow(account))
  return [styleText('dim', `  ${titles.join(' ')}`), ...body].slice(0, height)
}

/**
 * Renders the current view's body.
 *
 * @param context - the console
 * @param height - rows available
 * @returns the body's rows
 */
function viewRows(context: ConsoleContext, height: number): string[] {
  const { state, logs } = context
  if (state.view === 'logs') return logRows(logs.lines(), state.scrolledBack, height)
  if (state.view === 'accounts') return accountRows(state.accounts, height)
  return statsRows(routeTotals(), routeTotalsSince(), height)
}

/**
 * Creates the console's root component: header, tab bar, the current view, footer.
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
      const rows = [
        headerLine(config, state.status),
        tabsLine(state.view),
        ...viewRows(context, height),
        FOOTER[state.view]
      ]
      return rows.map((row) => truncateToWidth(row, width))
    },
    handleInput,
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
    context.state.verification.delete(providerId)
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
  context.state.verification.delete(providerId)
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
 * Scrolls the log view, staying within the buffered lines.
 *
 * @param context - the console
 * @param lines - lines to scroll up (positive) or down (negative)
 */
function scrollLogs(context: ConsoleContext, lines: number): void {
  const most = Math.max(0, context.logs.lines().length - 1)
  context.state.scrolledBack = Math.min(most, Math.max(0, context.state.scrolledBack + lines))
}

/**
 * Lists the console's keys and what each does. Keys go to pi's dialogs instead while one is open.
 *
 * @param context - the console the actions act on
 * @returns each key with its action
 */
function keyActions(context: ConsoleContext): readonly (readonly [KeyId, () => void])[] {
  const { state } = context
  return [
    ['q', () => context.quit()],
    [Key.ctrl('c'), () => context.quit()],
    ['1', () => (state.view = 'logs')],
    ['2', () => (state.view = 'accounts')],
    ['3', () => (state.view = 'stats')],
    ['n', () => openLogin(context)],
    ['x', () => inBackground(openLogout(context), 'Logout')],
    ['v', () => inBackground(context.refresh(true), 'Verifying the logins')],
    [Key.up, () => scrollLogs(context, 1)],
    [Key.down, () => scrollLogs(context, -1)],
    [Key.pageUp, () => scrollLogs(context, PAGE_LINES)],
    [Key.pageDown, () => scrollLogs(context, -PAGE_LINES)],
    [Key.end, () => (state.scrolledBack = 0)]
  ]
}

/**
 * Sends stray stderr writes to the log view while the console owns the terminal.
 *
 * @param logs - the log buffer
 * @returns a function that restores stderr
 */
function captureStderr(logs: LogBuffer): () => void {
  const original = process.stderr.write.bind(process.stderr)
  /**
   * Appends a stray write to the log view, marked as such.
   *
   * @param chunk - what was written
   * @returns `true`: nothing is queued
   */
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    logs.append(`[stderr] ${typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()}`)
    return true
  }
  return () => {
    process.stderr.write = original
  }
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
 * Runs the console until the operator quits or the process is told to stop: starts the server,
 * draws the screen, and stops both on the way out.
 *
 * @param config - the resolved server config
 * @param logs - the buffer LogTape already writes to
 */
export async function runConsole(config: ServerConfig, logs: LogBuffer): Promise<void> {
  initTheme()
  // pi's login dialog copies its sign-in URL on pi's own `app.message.copy` key, Ctrl+X in pi;
  // without a binding its hint names no key. The console has no other pi app keys.
  setKeybindings(
    new KeybindingsManager({
      ...TUI_KEYBINDINGS,
      'app.message.copy': { defaultKeys: 'ctrl+x', description: 'Copy the sign-in URL' }
    })
  )
  await initRegistry()
  const server = listen(config)
  const terminal = new ProcessTerminal()
  const tui = new TuiAltScreen(terminal)
  const restoreStderr = captureStderr(logs)
  const stopped = settleable()
  const state: ConsoleState = {
    view: 'logs',
    scrolledBack: 0,
    status: undefined,
    accounts: [],
    verification: new Map()
  }
  const context: ConsoleContext = {
    config,
    logs,
    tui,
    state,
    async refresh(verify = false) {
      const [status, accounts] = await Promise.all([readStatus(), getCredentialStatuses(verify)])
      state.status = status
      if (verify) {
        state.verification = new Map(
          accounts.map((account) => [account.provider, verificationOf(account)])
        )
      }
      state.accounts = accounts.map((account) => ({
        ...account,
        ...state.verification.get(account.provider)
      }))
      tui.requestRender()
    },
    quit: stopped.settle
  }
  const actions = keyActions(context)
  const root = createRootView(context, terminal, (data) => {
    actions.find(([key]) => matchesKey(data, key))?.[1]()
    tui.requestRender()
  })
  const unsubscribeLogs = logs.onChange(() => tui.requestRender())
  const unsubscribeTotals = onRouteTotalsChange(() => tui.requestRender())
  const timer = setInterval(
    () => inBackground(context.refresh(), 'Reading the status'),
    STATUS_REFRESH_MS
  )
  process.once('SIGTERM', stopped.settle)
  process.once('SIGHUP', stopped.settle)

  tui.addChild(root)
  tui.setFocus(root)
  tui.start()
  await context.refresh()
  await stopped.promise

  clearInterval(timer)
  unsubscribeLogs()
  unsubscribeTotals()
  tui.stop()
  restoreStderr()
  server.close()
}
