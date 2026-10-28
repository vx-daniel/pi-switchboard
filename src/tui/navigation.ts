/**
 * Keyboard navigation in the console (#61): moving between views, choosing an account and an
 * action for it, and the tab bar and footer that show where you are and which keys work.
 *
 * @packageDocumentation
 */

import {
  type KeyId,
  KeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
  truncateToWidth,
  visibleWidth
} from '@earendil-works/pi-tui'
import type { ProviderCredentialStatus } from '@proxy/pi/registry'
import { STATS_KEPT_DAYS, STATS_WINDOWS, type StatsWindow } from '@proxy/stats/windows'
import type { LoginPlace } from '@proxy/tui/login-routing'
import { keycap, paint } from '@proxy/tui/theme'

/** The console's views, in tab order. */
export const VIEWS = ['logs', 'accounts', 'stats', 'models', 'settings', 'doctor'] as const

/** One of the console's views. */
export type View = (typeof VIEWS)[number]

/** What can be done to one account from its action menu. */
export type AccountAction = 'verify' | 'login' | 'logout' | 'label' | 'first' | 'disable' | 'enable'

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

/** The digit that jumps to each view: its place in {@link VIEWS}, as its tab shows it. */
export const VIEW_DIGIT: Readonly<Record<View, KeyId>> = {
  logs: '1',
  accounts: '2',
  stats: '3',
  models: '4',
  settings: '5',
  doctor: '6'
}

/** The views whose footer lists the window keys: both read the one window those keys set (#325). */
const WINDOW_VIEWS: ReadonlySet<View> = new Set(['stats', 'doctor'])

/**
 * Works out the stats window after a window key: the key sets it on the Stats and Doctor views,
 * the one window both show, and does nothing elsewhere.
 *
 * @param view - the view shown
 * @param current - the window now
 * @param picked - the window the key names
 * @returns the window from now on
 */
export function pickedWindow(view: View, current: StatsWindow, picked: StatsWindow): StatsWindow {
  return WINDOW_VIEWS.has(view) ? picked : current
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
 * Lists what can be done to an account, for its action menu: **Use first** while another login
 * of its provider is called first, and **Disable** or **Enable** (#233).
 *
 * @param account - the account
 * @param place - where it stands in its provider's routing order
 * @returns the actions, in menu order
 */
export function accountActions(
  account: ProviderCredentialStatus,
  place: LoginPlace | undefined
): readonly AccountActionChoice[] {
  const login = account.type === 'oauth' ? 'Log in again' : 'Enter a new API key'
  const routing: AccountActionChoice[] = []
  if (place !== undefined && place.count > 1 && !place.first && !place.disabled) {
    routing.push({ action: 'first', label: 'Use first' })
  }
  routing.push(
    place?.disabled === true
      ? { action: 'enable', label: 'Enable' }
      : { action: 'disable', label: 'Disable' }
  )
  return [
    { action: 'verify', label: 'Verify all logins' },
    { action: 'login', label: login },
    { action: 'label', label: 'Set a label' },
    ...routing,
    { action: 'logout', label: `Log out of ${account.provider}` }
  ]
}

/** A key and what it does, for the footer. */
export type KeyHint = readonly [key: string, action: string]

/**
 * The window keys and what each window is called: in the Stats and Doctor views' footers, on the
 * Stats view's window pills and in both tabs' context.
 */
export const STATS_WINDOW_KEYS: Readonly<Record<StatsWindow, KeyHint>> = {
  today: ['t', 'today'],
  week: ['w', 'week'],
  all: ['a', `all ${String(STATS_KEPT_DAYS)} days`]
}

/**
 * Lists the first view's keys: `r` names the view it switches to, the raw log from the Requests
 * table and the table from the raw log.
 *
 * @param raw - whether the raw log is shown
 * @returns the keys
 */
export function logsKeys(raw: boolean): readonly KeyHint[] {
  return [
    ['↑↓', 'scroll'],
    ['PgUp PgDn', 'page'],
    ['End', 'follow'],
    ['r', raw ? 'requests' : 'raw log'],
    ['n', 'login']
  ]
}

/** The window keys, in the Stats and Doctor views' footers. */
const WINDOW_KEYS: readonly KeyHint[] = STATS_WINDOWS.map((window) => STATS_WINDOW_KEYS[window])

/** Each view's keys, the ones worth learning first at the front: a narrow footer cuts the end. */
const VIEW_KEYS: Readonly<Record<View, readonly KeyHint[]>> = {
  logs: logsKeys(false),
  accounts: [
    ['↑↓', 'select'],
    ['↵', 'actions'],
    ['v', 'verify all'],
    ['n', 'login'],
    ['x', 'log out'],
    ['c', 'clear cooldowns']
  ],
  stats: WINDOW_KEYS,
  models: [
    ['↑↓', 'select'],
    ['↵', 'edit or add an alias'],
    ['c', 'clear cooldowns']
  ],
  settings: [
    ['↑↓', 'select'],
    ['↵', 'change'],
    ['r', 'restart the server']
  ],
  doctor: [['↑↓', 'select'], ...WINDOW_KEYS]
}
/** The keys that work on every view, besides quitting; a narrow footer drops them from the front. */
const GLOBAL_KEYS: readonly KeyHint[] = [
  [`1-${String(VIEWS.length)} ←→`, 'views'],
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
 * @param keys - the view's keys, when its state changes them; the view's usual keys otherwise
 * @returns the footer row, `size.width` columns
 */
export function footerLine(
  view: View,
  size: { readonly width: number; readonly sidebarFits: boolean },
  keys: readonly KeyHint[] = VIEW_KEYS[view]
): string {
  const left = [...keys]
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

/**
 * Sets the console's keys in pi's keybindings.
 *
 * @remarks
 * pi's login dialog copies its sign-in URL on pi's own `app.message.copy` key, Ctrl+X in pi;
 * without a binding its hint names no key. The console has no other pi app keys. The screen's own
 * viewport scrolling takes PgUp and PgDn before any component; the console's view always fits the
 * screen, so they go to the raw log instead.
 */
export function installKeybindings(): void {
  setKeybindings(
    new KeybindingsManager({
      ...TUI_KEYBINDINGS,
      'tui.altScreen.pageUp': { defaultKeys: [] },
      'tui.altScreen.pageDown': { defaultKeys: [] },
      'app.message.copy': { defaultKeys: 'ctrl+x', description: 'Copy the sign-in URL' }
    })
  )
}
