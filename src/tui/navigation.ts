/**
 * Keyboard navigation in the console (#61): moving between views, choosing an account and an
 * action for it, and the tab bar and footer that show where you are and which keys work.
 *
 * @packageDocumentation
 */

import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import type { ProviderCredentialStatus } from '@proxy/pi/registry'
import { keycap, paint } from '@proxy/tui/theme'

/** The console's views, in tab order. */
export const VIEWS = ['logs', 'accounts', 'stats', 'models'] as const

/** One of the console's views. */
export type View = (typeof VIEWS)[number]

/** What can be done to one account from its action menu. */
export type AccountAction = 'verify' | 'login' | 'logout' | 'label'

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
    { action: 'label', label: 'Set a label' },
    { action: 'logout', label: `Log out of ${account.provider}` }
  ]
}

/** A key and what it does, for the footer. */
type KeyHint = readonly [key: string, action: string]

/** Each view's keys, the ones worth learning first at the front: a narrow footer cuts the end. */
const VIEW_KEYS: Readonly<Record<View, readonly KeyHint[]>> = {
  logs: [
    ['↑↓', 'scroll'],
    ['PgUp PgDn', 'page'],
    ['End', 'follow'],
    ['n', 'login']
  ],
  accounts: [
    ['↑↓', 'select'],
    ['↵', 'actions'],
    ['v', 'verify all'],
    ['n', 'login'],
    ['x', 'log out'],
    ['c', 'clear cooldowns']
  ],
  stats: [
    ['t', 'today'],
    ['w', 'week'],
    ['a', 'all 30 days']
  ],
  models: [
    ['↑↓', 'select'],
    ['↵', 'edit or add an alias'],
    ['c', 'clear cooldowns']
  ]
}
/** The keys that work on every view, besides quitting; a narrow footer drops them from the front. */
const GLOBAL_KEYS: readonly KeyHint[] = [
  ['1-4 ←→', 'views'],
  ['p', 'proxy auth']
]
/** Quitting stops the proxy: the one key the footer always shows, at its right end. */
const QUIT_KEY: KeyHint = ['q', 'quit (stops the proxy)']
/** The sidebar's key, offered only where the sidebar fits; after the view keys, before the rest. */
const SIDEBAR_KEY: KeyHint = ['s', 'sidebar']
/** Columns between two key hints. */
const HINT_GAP = '  '
/** Columns kept clear at the footer's edges and between its two groups. */
const FOOTER_MARGIN = 3

/**
 * Renders key hints as keycaps: each key on a chip, then what it does.
 *
 * @param hints - the keys
 * @param emphasised - whether the actions are the view's own (brighter) or the global ones
 * @returns the hints, joined
 */
function keycaps(hints: readonly KeyHint[], emphasised: boolean): string {
  return hints
    .map(([key, action]) => `${keycap(` ${key} `)} ${paint(emphasised ? 'muted' : 'dim', action)}`)
    .join(HINT_GAP)
}

/**
 * Renders the footer: the view's keys on the left, the keys that work everywhere on the right,
 * quitting last. When the row is too narrow the other global keys give way from their start,
 * then the view's keys from their end; quitting stays, since it stops the proxy.
 *
 * @param view - the current view
 * @param size - the footer's columns, and whether the sidebar fits the terminal (shown or hidden)
 * @param size.width - the columns
 * @param size.sidebarFits - whether the terminal is wide enough for the sidebar
 * @returns the footer row, `size.width` columns
 */
export function footerLine(
  view: View,
  size: { readonly width: number; readonly sidebarFits: boolean }
): string {
  const left = [...VIEW_KEYS[view]]
  const others = size.sidebarFits ? [SIDEBAR_KEY, ...GLOBAL_KEYS] : [...GLOBAL_KEYS]
  const rightText = (): string => `${keycaps([...others, QUIT_KEY], false)} `
  const overflow = (): number =>
    visibleWidth(keycaps(left, true)) + visibleWidth(rightText()) + FOOTER_MARGIN - size.width
  while (overflow() > 0 && others.length > 0) others.shift()
  while (overflow() > 0 && left.length > 0) left.pop()
  const leftText = ` ${keycaps(left, true)}`
  const right = rightText()
  const gap = Math.max(1, size.width - visibleWidth(leftText) - visibleWidth(right))
  return truncateToWidth(`${leftText}${' '.repeat(gap)}${right}`, size.width, '', true)
}
