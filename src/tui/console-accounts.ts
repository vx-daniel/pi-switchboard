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
  } else if (action === 'label') inBackground(askForLabel(context, account.provider), 'Label')
  else inBackground(logoutOf(context, account.provider), 'Logout')
}
