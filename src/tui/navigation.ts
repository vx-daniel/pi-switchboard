/**
 * Keyboard navigation in the console (#61): moving between views, choosing an account and an
 * action for it, and the tab bar and footer that show where you are and which keys work.
 *
 * @packageDocumentation
 */

import { styleText } from 'node:util'

import type { ProviderCredentialStatus } from '@proxy/pi/registry'

/** The console's views, in tab order. */
export const VIEWS = ['logs', 'accounts', 'stats'] as const

/** One of the console's views. */
export type View = (typeof VIEWS)[number]

/** What can be done to one account from its action menu. */
export type AccountAction = 'verify' | 'login' | 'logout'

/** An action on an account, with the label its menu shows. */
export interface AccountActionChoice {
  readonly action: AccountAction
  readonly label: string
}

/** The label of the row after the accounts, which opens pi's login selector. */
export const LOGIN_ROW = '+ Log in to a provider…'

/**
 * Moves to the next or the previous view, wrapping around.
 *
 * @param view - the current view
 * @param step - `1` for the next view, `-1` for the previous one
 * @returns the view moved to
 */
export function stepView(view: View, step: 1 | -1): View {
  const index = (VIEWS.indexOf(view) + step + VIEWS.length) % VIEWS.length
  return VIEWS[index] ?? view
}

/**
 * Keeps a selection in the accounts list: each account, then the login row after them.
 *
 * @param selected - the selected row
 * @param accounts - how many accounts there are
 * @returns the row, moved onto the list when the list shrank
 */
export function clampSelection(selected: number, accounts: number): number {
  return Math.min(Math.max(selected, 0), accounts)
}

/**
 * Moves the selection in the accounts list, stopping at its ends.
 *
 * @param selected - the selected row
 * @param accounts - how many accounts there are
 * @param step - rows to move: negative moves up
 * @returns the row moved to
 */
export function moveSelection(selected: number, accounts: number, step: number): number {
  return clampSelection(selected + step, accounts)
}

/**
 * Lists what can be done to an account, for its action menu.
 *
 * @param account - the account
 * @returns the actions, in menu order
 */
export function accountActions(account: ProviderCredentialStatus): readonly AccountActionChoice[] {
  const login = account.type === 'oauth' ? 'Log in again' : 'Enter a new API key'
  return [
    { action: 'verify', label: 'Verify all logins' },
    { action: 'login', label: login },
    { action: 'logout', label: `Log out of ${account.provider}` }
  ]
}

/**
 * Renders the tab bar, marking the current view.
 *
 * @param view - the current view
 * @returns the tab bar line
 */
export function tabsLine(view: View): string {
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

/**
 * The footer's key hints for each view, quitting first: a narrow terminal cuts the end of the line.
 */
const FOOTER: Readonly<Record<View, readonly string[]>> = {
  logs: ['q quit (stops the proxy)', '←→ views', '↑↓ PgUp PgDn scroll', 'End follow', 'n login'],
  accounts: [
    'q quit (stops the proxy)',
    '←→ views',
    '↑↓ select',
    'Enter actions',
    'v verify all',
    'n login',
    'x logout'
  ],
  stats: [
    'q quit (stops the proxy)',
    '←→ views',
    'per alias and served model, since the proxy started'
  ]
}
/** The hints before the sidebar's: quitting and moving between views. */
const HINTS_BEFORE_SIDEBAR = 2

/**
 * Renders the footer: the view's key hints, with the sidebar's key after quitting and moving
 * between views on a terminal wide enough to show the sidebar.
 *
 * @param view - the current view
 * @param sidebarFits - whether the terminal is wide enough for the sidebar, shown or hidden
 * @returns the footer line
 */
export function footerLine(view: View, sidebarFits: boolean): string {
  const hints = FOOTER[view]
  const shown = sidebarFits
    ? [...hints.slice(0, HINTS_BEFORE_SIDEBAR), 's sidebar', ...hints.slice(HINTS_BEFORE_SIDEBAR)]
    : hints
  return styleText('dim', ` ${shown.join(' · ')}`)
}
