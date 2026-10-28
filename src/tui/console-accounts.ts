/**
 * The console's login and account actions (#61): pi's login and logout selectors, pi's login
 * dialog, the label a login gets (#227), and the action menu of a selected account.
 *
 * @packageDocumentation
 */

import type { AuthType } from '@earendil-works/pi-ai'
import {
  ExtensionSelectorComponent,
  LoginDialogComponent,
  OAuthSelectorComponent
} from '@earendil-works/pi-coding-agent'
import type { TuiAltScreen } from '@earendil-works/pi-tui'
import { proxyLogger } from '@proxy/logging'
import { DEFAULT_LOGIN_ROUTING } from '@proxy/openai/model-logins'
import {
  getLoginDeviceId,
  getRuntime,
  type ProviderCredentialStatus,
  summarizeAuthError
} from '@proxy/pi/registry'
import type { ConsoleContext } from '@proxy/tui/console'
import { askLine, pickLabel, showDialog } from '@proxy/tui/dialogs'
import {
  loginOptions,
  logoutOptions,
  providerName,
  runLogin,
  runLogout,
  saveLoginLabel
} from '@proxy/tui/login'
import {
  type LoginPlace,
  loginPlaces,
  saveLoginDisabled,
  saveLoginFirst
} from '@proxy/tui/login-routing'
import { type AccountAction, accountActions, clampSelection } from '@proxy/tui/navigation'
import { credentialChanged } from '@proxy/tui/status-refresh'
import { errorMessage } from '@proxy/utils/guards'

/** Logger for the console's own actions. */
const consoleLogger = proxyLogger('tui')

/** How long a logout may take. */
const LOGOUT_TIMEOUT_MS = 15_000

/**
 * Says why a login, a logout or a background task failed, in pi's first line only: pi's messages
 * can carry a provider's response after it.
 *
 * @param error - what was thrown
 * @returns the summary
 */
function failureReason(error: unknown): string {
  return summarizeAuthError(errorMessage(error))
}

/**
 * Runs a task the console does not wait for, logging a failure instead of dropping it.
 *
 * @param task - the running task
 * @param what - what it does, for the log line
 */
export function inBackground(task: Promise<void>, what: string): void {
  task.catch((error: unknown) => {
    consoleLogger.error('{what} failed: {reason}', { what, reason: failureReason(error) })
  })
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
async function selectOption(
  tui: TuiAltScreen,
  prompt: { readonly message: string; readonly options: readonly { id: string; label: string }[] }
): Promise<string> {
  const labels = prompt.options.map((option) => option.label)
  const label = await pickLabel(tui, prompt.message, labels)
  const option = prompt.options.find((candidate) => candidate.label === label)
  if (option === undefined) throw new Error('Login cancelled')
  return option.id
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
  let loggedIn = false
  try {
    await runLogin(
      runtime,
      { providerId, type, deviceId: getLoginDeviceId },
      { dialog, select: (prompt) => selectOption(context.tui, prompt) }
    )
    loggedIn = true
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
  if (loggedIn) await askForLabel(context, providerId)
}

/**
 * Asks what to call a login and saves the answer; an empty answer removes the label, and
 * cancelling keeps it.
 *
 * @param context - the console
 * @param providerId - the login
 */
async function askForLabel(context: ConsoleContext, providerId: string): Promise<void> {
  const current = context.state.status?.labels[providerId]
  const title =
    current === undefined
      ? `Label for ${providerId} (which account this is; Enter to skip)`
      : `Label for ${providerId} (now "${current}"; Enter to remove)`
  const label = await askLine(context.tui, title)
  if (label === undefined) return
  saveLoginLabel(providerId, label)
  await context.refresh()
}

/**
 * Opens pi's provider selector and logs in to the chosen provider.
 *
 * @param context - the console
 */
export function openLogin(context: ConsoleContext): void {
  const selector = new OAuthSelectorComponent(
    'login',
    loginOptions(getRuntime(), context.state.status?.labels),
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
    await runLogout(getRuntime(), providerId, AbortSignal.timeout(LOGOUT_TIMEOUT_MS))
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
export async function openLogout(context: ConsoleContext): Promise<void> {
  const options = await logoutOptions(getRuntime(), context.state.status?.labels)
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
export function openSelected(context: ConsoleContext): void {
  const { state } = context
  const account = state.accounts[clampSelection(state.selected, state.accounts.length)]
  if (account === undefined) {
    openLogin(context)
    return
  }
  const logins = state.accounts.map((each) => each.provider)
  const routing = state.status?.file.routing.logins ?? DEFAULT_LOGIN_ROUTING
  const place = loginPlaces(logins, routing).get(account.provider)
  const choices = accountActions(account, place)
  const selector = new ExtensionSelectorComponent(
    account.provider,
    choices.map((choice) => choice.label),
    (label) => {
      handle.hide()
      const chosen = choices.find((choice) => choice.label === label)
      if (chosen !== undefined) runAccountAction(context, { account, place }, chosen.action)
    },
    () => handle.hide()
  )
  const handle = showDialog(context.tui, selector)
}

/**
 * Writes a login's routing change (#233) and redraws: the next request uses it.
 *
 * @param context - the console
 * @param write - the config write; returns whether the file was written
 */
async function changeRouting(context: ConsoleContext, write: () => boolean): Promise<void> {
  if (!write()) consoleLogger.warn('The login routing change was not saved')
  await context.refresh()
}

/**
 * Disables a login. When it is its provider's only enabled login, asks first: the provider's
 * models leave `/v1/models` (#233).
 *
 * @param context - the console
 * @param login - the login
 * @param lastEnabled - whether it is its provider's only enabled login
 */
async function disableLogin(
  context: ConsoleContext,
  login: string,
  lastEnabled: boolean
): Promise<void> {
  if (lastEnabled) {
    const sure = await pickLabel(
      context.tui,
      `Disable ${login}? It is the provider's only enabled login: its models leave /v1/models.`,
      ['Disable it', 'Keep it']
    )
    if (sure !== 'Disable it') return
  }
  await changeRouting(context, () => saveLoginDisabled(login, true))
}

/** The account an action acts on, and its place in its provider's routing order. */
interface SelectedAccount {
  readonly account: ProviderCredentialStatus
  readonly place: LoginPlace | undefined
}

/** Each account action: what it runs, and what a failure of it is called in the log. */
const ACCOUNT_ACTIONS: Readonly<
  Record<
    AccountAction,
    {
      readonly what: string
      readonly run: (context: ConsoleContext, selected: SelectedAccount) => Promise<void>
    }
  >
> = {
  verify: { what: 'Verifying the logins', run: (context) => context.refresh(true) },
  login: {
    what: 'Login',
    run: (context, { account }) => loginTo(context, account.provider, account.type)
  },
  label: { what: 'Label', run: (context, { account }) => askForLabel(context, account.provider) },
  first: {
    what: 'Use first',
    run: (context, { account }) =>
      changeRouting(context, () =>
        saveLoginFirst(
          account.provider,
          context.state.accounts.map((each) => each.provider)
        )
      )
  },
  disable: {
    what: 'Disable',
    run: (context, { account, place }) =>
      disableLogin(context, account.provider, place?.lastEnabled !== false)
  },
  enable: {
    what: 'Enable',
    run: (context, { account }) =>
      changeRouting(context, () => saveLoginDisabled(account.provider, false))
  },
  logout: { what: 'Logout', run: (context, { account }) => logoutOf(context, account.provider) }
}

/**
 * Runs an action chosen from an account's menu.
 *
 * @param context - the console
 * @param selected - the account it acts on, and its place in its provider's routing order
 * @param action - what to do
 */
function runAccountAction(
  context: ConsoleContext,
  selected: SelectedAccount,
  action: AccountAction
): void {
  const { what, run } = ACCOUNT_ACTIONS[action]
  inBackground(run(context, selected), what)
}
