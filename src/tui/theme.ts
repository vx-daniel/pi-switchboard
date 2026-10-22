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
 * {@link activeTab}), and its header and sidebar sit on a background of their own
 * ({@link chrome}). With no theme installed (the tests, `NO_COLOR`) those return the text as it is.
 *
 * @packageDocumentation
 */

import { initTheme, Theme, type ThemeColor } from '@earendil-works/pi-coding-agent'
import {
  backgroundAnsi,
  getTerminalColorMode,
  parseColor,
  styleText,
  visibleWidth
} from '@earendil-works/pi-tui'
import { STORM, STORM_BACKGROUNDS, STORM_FOREGROUNDS } from '@proxy/tui/tokyonight-storm'

/** Where pi keeps its global theme. */
const PI_THEME_KEY = Symbol.for('@earendil-works/pi-coding-agent:theme')
/** The background of the console's chrome: its header and its sidebar. */
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
    return
  }
  const theme = tokyoNightStorm()
  Reflect.set(globalThis, PI_THEME_KEY, theme)
  active = theme
  chromeBackground = backgroundAnsi(parseColor(CHROME_BG), theme.getColorMode())
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
 * Marks the selected item of a list or the current tab: bold accent on the selection background.
 *
 * @param text - the item
 * @returns the item, marked when a theme is installed
 */
export function highlight(text: string): string {
  return active === undefined ? text : active.bg('selectedBg', strong(active.fg('accent', text)))
}

/**
 * Marks the current tab: bold accent, inverted, so it reads as a pill on the header's background.
 * pi-tui's `styleText` for the inversion, as in {@link strong}: the theme's `inverse` goes through
 * chalk, which emits nothing in the console.
 *
 * @param text - the tab's label
 * @returns the label, marked when a theme is installed
 */
export function activeTab(text: string): string {
  if (active === undefined) return text
  return styleText(strong(active.fg('accent', text)), { inverse: true }, active.getColorMode())
}

/**
 * Puts a row of the console's chrome (its header, its tab bar, a row of its sidebar) on the
 * chrome's background, padded to the row's width.
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
  if (chromeBackground === undefined) return row
  const background = chromeBackground
  let painted = `${row}${' '.repeat(Math.max(0, width - visibleWidth(row)))}`
  for (const end of BACKGROUND_ENDS) painted = painted.replaceAll(end, `${end}${background}`)
  return `${background}${painted}\u001b[49m`
}
