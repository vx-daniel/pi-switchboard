/**
 * The console's theme (#61): Tokyo Night Storm (`tokyonight-storm.ts`), for the console's own views
 * and for pi's dialogs inside it.
 *
 * @remarks
 * pi's dialogs (its login dialog and selectors) draw with pi's global theme. pi loads a named theme
 * only from its own theme directory (`~/.pi/agent/themes`), which the console must not write to, so
 * the console builds pi's `Theme` itself and installs it under the key pi keeps it on
 * (`Symbol.for('@earendil-works/pi-coding-agent:theme')`, shared by every copy of pi in a process).
 * That key is pi's own, not public API: {@link installConsoleTheme} calls `initTheme()` first, so a
 * pi that moves it still works, with its system theme in the dialogs.
 *
 * The console's own text is colored by role ({@link paint}, {@link strong}, {@link highlight},
 * {@link activeTab}), and its status strip sits on a background of its own ({@link chrome}). With
 * no theme installed (the tests, `NO_COLOR`) those return the text as it is.
 *
 * @packageDocumentation
 */

import { initTheme, Theme, type ThemeColor } from '@earendil-works/pi-coding-agent'
import {
  backgroundAnsi,
  getTerminalColorMode,
  parseColor,
  styleText,
  truncateToWidth,
  visibleWidth
} from '@earendil-works/pi-tui'
import { STORM, STORM_BACKGROUNDS, STORM_FOREGROUNDS } from '@proxy/tui/tokyonight-storm'

/** Where pi keeps its global theme. */
const PI_THEME_KEY = Symbol.for('@earendil-works/pi-coding-agent:theme')
/** The background of the console's chrome: its status strip. */
const CHROME_BG = STORM.bgHighlight
/**
 * The escape sequences that end a background: a full reset, its short form, and a background's
 * own reset. Each one inside a chrome row is followed by the chrome's background again.
 */
const BACKGROUND_ENDS = ['\u001b[0m', '\u001b[m', '\u001b[49m'] as const

/** The roles the console colors its own text with. */
export type ConsoleColor = Extract<
  ThemeColor,
  'accent' | 'success' | 'error' | 'warning' | 'muted' | 'dim' | 'border' | 'borderAccent'
>

/** The theme the console paints with, once installed. */
let active: Theme | undefined
/** The chrome's background escape sequence, at the theme's color mode, once installed. */
let chromeBackground: string | undefined
/** The alert panel's background escape sequence (the error background), once installed. */
let alertBackground: string | undefined

/**
 * Builds the Tokyo Night Storm theme for this terminal: true color where it has it, else the
 * nearest of 256 colors.
 *
 * @returns the theme
 */
function tokyoNightStorm(): Theme {
  return new Theme(STORM_FOREGROUNDS, STORM_BACKGROUNDS, getTerminalColorMode(), {
    name: 'tokyonight-storm',
    appearance: 'dark'
  })
}

/**
 * Installs the console's theme for pi's dialogs and for the console's own text, unless `NO_COLOR`
 * is set, in which case the console's text stays uncolored and pi keeps its system theme.
 *
 * @param noColor - the `NO_COLOR` environment variable; any non-empty value turns colors off
 */
export function installConsoleTheme(noColor: string | undefined = process.env.NO_COLOR): void {
  initTheme()
  if (noColor !== undefined && noColor !== '') {
    active = undefined
    chromeBackground = undefined
    alertBackground = undefined
    return
  }
  const theme = tokyoNightStorm()
  Reflect.set(globalThis, PI_THEME_KEY, theme)
  active = theme
  chromeBackground = backgroundAnsi(parseColor(CHROME_BG), theme.getColorMode())
  alertBackground = backgroundAnsi(parseColor(STORM.bgError), theme.getColorMode())
}

/**
 * Colors text by its role.
 *
 * @param color - the role
 * @param text - the text
 * @returns the text, colored when a theme is installed
 */
export function paint(color: ConsoleColor, text: string): string {
  return active === undefined ? text : active.fg(color, text)
}

/**
 * Makes text bold. pi-tui's `styleText` rather than the theme's `bold`, which emits nothing on a
 * terminal that calls itself `dumb` while its colors still work.
 *
 * @param text - the text
 * @returns the text, bold when a theme is installed
 */
export function strong(text: string): string {
  return active === undefined ? text : styleText(text, { bold: true }, active.getColorMode())
}

/**
 * Marks the selected item of a list: bold accent on the selection background.
 *
 * @param text - the item
 * @returns the item, marked when a theme is installed
 */
export function highlight(text: string): string {
  return active === undefined ? text : active.bg('selectedBg', strong(active.fg('accent', text)))
}

/**
 * Marks the current tab where the tabs sit in the frame's border, and the Stats view's current
 * window: bold in the chrome's amber, inverted, so it reads as a pill. pi-tui's `styleText` for
 * the inversion, as in {@link strong}: the theme's `inverse` goes through chalk, which emits
 * nothing in the console.
 *
 * @param text - the tab's label
 * @returns the label, marked when a theme is installed
 */
export function activeTab(text: string): string {
  if (active === undefined) return text
  return styleText(strong(tabAccent(text)), { inverse: true }, active.getColorMode())
}

/**
 * Colors the chrome's accent: the current tab's outline and each tab's key digit, the headline
 * numbers of the status strip and the sidebar, and the pointers and `↵` hints of the views. The
 * instrument panel's amber is the theme's yellow, named here once so no chrome module paints a tab
 * with `warning`.
 *
 * @param text - the text
 * @returns the text, amber when a theme is installed
 */
export function tabAccent(text: string): string {
  return paint('warning', text)
}

/**
 * Marks a badge in the status strip (`● SERVING`): bold success text on the success background.
 *
 * @param text - the badge's text, with its own padding
 * @returns the badge, marked when a theme is installed
 */
export function badge(text: string): string {
  if (active === undefined) return text
  return active.bg('toolSuccessBg', strong(active.fg('success', text)))
}

/**
 * Marks a badge that warns (#287): a solid block of the warning or error color with the text
 * knocked out of it, bold, so it stands out of the strip's amber accents rather than among them.
 * Inverted with pi-tui's `styleText`, as {@link activeTab} is. The text must say what is wrong by
 * itself, since `NO_COLOR` leaves it plain.
 *
 * @param level - how serious: `warning` or `error`
 * @param text - the badge's text, with its own padding
 * @returns the badge, marked when a theme is installed
 */
export function alertBadge(level: 'warning' | 'error', text: string): string {
  if (active === undefined) return text
  return styleText(strong(active.fg(level, text)), { inverse: true }, active.getColorMode())
}

/**
 * Draws a key as a raised chip in the footer: bold on the selection background, as
 * {@link highlight} does, in the plain text color so it reads as a key, not a selected item.
 *
 * @param text - the key's text, with its own padding
 * @returns the chip, marked when a theme is installed
 */
export function keycap(text: string): string {
  if (active === undefined) return text
  return active.bg('selectedBg', strong(text))
}

/**
 * Puts a row of the console's chrome (its status strip) on the chrome's background, padded to the
 * row's width.
 *
 * @remarks
 * The row may already be styled: a reset inside it would end the background there, so the
 * background is set again after each one ({@link BACKGROUND_ENDS}).
 *
 * @param row - the row
 * @param width - the columns the background covers; a wider row is not cut
 * @returns the row on the chrome's background, or as it is when no theme is installed
 */
export function chrome(row: string, width: number): string {
  return chromeBackground === undefined ? row : onBackground(row, chromeBackground, width)
}

/**
 * Puts a row on a background, padded to the row's width, setting the background again after each
 * reset inside it ({@link BACKGROUND_ENDS}).
 *
 * @param row - the row, styled or not
 * @param background - the background's escape sequence
 * @param width - the columns the background covers; a wider row is not cut
 * @returns the row on the background
 */
function onBackground(row: string, background: string, width: number): string {
  let painted = `${row}${' '.repeat(Math.max(0, width - visibleWidth(row)))}`
  for (const end of BACKGROUND_ENDS) painted = painted.replaceAll(end, `${end}${background}`)
  return `${background}${painted}\u001b[49m`
}

/** Columns the alert panel's side borders take: `│ ` before the content and ` │` after. */
export const ALERT_FRAME_COLUMNS = 4
/** Columns the alert panel's corners take on its top and bottom borders. */
const ALERT_CORNER_COLUMNS = 2

/**
 * Frames lines as a red alert panel (#287): an error-colored border around them, all of it on the
 * error background. Without a theme (`NO_COLOR`) the border is drawn plain.
 *
 * @param lines - the panel's content, each at most `width - ALERT_FRAME_COLUMNS` columns
 * @param width - the panel's columns, border included
 * @returns the panel's rows, each `width` columns
 */
export function alertPanel(lines: readonly string[], width: number): string[] {
  const inner = Math.max(0, width - ALERT_FRAME_COLUMNS)
  const rule = '─'.repeat(Math.max(0, width - ALERT_CORNER_COLUMNS))
  const edge = (text: string): string => strong(paint('error', text))
  const rows = [
    edge(`╭${rule}╮`),
    ...lines.map((line) => `${edge('│')} ${truncateToWidth(line, inner, '', true)} ${edge('│')}`),
    edge(`╰${rule}╯`)
  ]
  const background = alertBackground
  return background === undefined ? rows : rows.map((row) => onBackground(row, background, width))
}
