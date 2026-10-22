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
 * The console's own text is colored by role ({@link paint}, {@link strong}, {@link highlight}). With
 * no theme installed (the tests, `NO_COLOR`) those return the text as it is.
 *
 * @packageDocumentation
 */

import { initTheme, Theme, type ThemeColor } from '@earendil-works/pi-coding-agent'
import { getTerminalColorMode, styleText } from '@earendil-works/pi-tui'
import { STORM_BACKGROUNDS, STORM_FOREGROUNDS } from '@proxy/tui/tokyonight-storm'

/** Where pi keeps its global theme. */
const PI_THEME_KEY = Symbol.for('@earendil-works/pi-coding-agent:theme')

/** The roles the console colors its own text with. */
export type ConsoleColor = Extract<
  ThemeColor,
  'accent' | 'success' | 'error' | 'warning' | 'muted' | 'dim' | 'border' | 'borderAccent'
>

/** The theme the console paints with, once installed. */
let active: Theme | undefined

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
    return
  }
  const theme = tokyoNightStorm()
  Reflect.set(globalThis, PI_THEME_KEY, theme)
  active = theme
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
