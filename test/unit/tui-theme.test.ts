import {
  backgroundAnsi,
  getTerminalColorMode,
  parseColor,
  stripTerminalSequences,
  visibleWidth
} from '@earendil-works/pi-tui'
import {
  activeTab,
  alertPanel,
  badge,
  chrome,
  highlight,
  installConsoleTheme,
  keycap,
  paint,
  strong,
  tabAccent
} from '@proxy/tui/theme'
import { STORM } from '@proxy/tui/tokyonight-storm'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

/** Where pi keeps its global theme. */
const PI_THEME_KEY = Symbol.for('@earendil-works/pi-coding-agent:theme')
/** pi's global theme before a test, put back after it: other test files share the process. */
const before: unknown = Reflect.get(globalThis, PI_THEME_KEY)

afterEach(() => {
  vi.unstubAllEnvs()
  // No console theme for the next test, and pi's theme as it was.
  installConsoleTheme('1')
  Reflect.set(globalThis, PI_THEME_KEY, before)
})

/**
 * Returns the name of pi's global theme.
 *
 * @returns its name, or `undefined` when none is set
 */
function piThemeName(): unknown {
  const theme: unknown = Reflect.get(globalThis, PI_THEME_KEY)
  return typeof theme === 'object' && theme !== null ? Reflect.get(theme, 'name') : undefined
}

describe('the console theme', () => {
  // Catches pi's dialogs (login, selectors) drawn in pi's system theme beside the console's own
  // colors, or the console's text left uncolored.
  test('colors the console and pi’s dialogs with Tokyo Night Storm', () => {
    // The test runner sets NO_COLOR=1, which pi's own color code honors too.
    vi.stubEnv('NO_COLOR', '')
    installConsoleTheme()

    expect(piThemeName()).toBe('tokyonight-storm')
    for (const painted of [
      paint('success', 'ok'),
      strong('ok'),
      highlight('ok'),
      activeTab('ok'),
      tabAccent('ok'),
      badge('ok'),
      keycap('ok')
    ]) {
      expect(painted).not.toBe('ok')
      expect(stripTerminalSequences(painted)).toBe('ok')
    }
  })

  // Catches NO_COLOR ignored: the console must print plain text, and leave pi on its own theme.
  test('colors nothing when NO_COLOR is set', () => {
    installConsoleTheme('1')

    expect(piThemeName()).not.toBe('tokyonight-storm')
    expect([
      paint('error', 'x'),
      strong('x'),
      highlight('x'),
      activeTab('x'),
      tabAccent('x'),
      badge('x'),
      keycap('x')
    ]).toEqual(Array.from({ length: 7 }, () => 'x'))
    expect(chrome('x', 20)).toBe('x')
  })

  // Catches the header or sidebar background ending part-way along a row: a reset inside the row
  // (from a highlighted item, a bold title or a cut line) must not leave the rest uncolored.
  test('the chrome background covers the whole row, through resets inside it', () => {
    vi.stubEnv('NO_COLOR', '')
    installConsoleTheme()
    const row = `${highlight('tab')} plain \u001b[0mafter`
    const painted = chrome(row, 30)

    expect(visibleWidth(painted)).toBe(30)
    expect(stripTerminalSequences(painted).trimEnd()).toBe('tab plain after')
    // The chrome is Tokyo Night's highlight background, at the terminal's color mode.
    const background = backgroundAnsi(parseColor(STORM.bgHighlight), getTerminalColorMode())
    expect(painted.startsWith(background)).toBe(true)
    // Every end of a background inside the row is followed by the chrome's background again;
    // only the row's own final reset is not.
    const body = painted.slice(0, -'\u001b[49m'.length)
    for (const end of ['\u001b[0m', '\u001b[49m']) {
      for (const part of body.split(end).slice(1)) expect(part.startsWith(background)).toBe(true)
    }
  })

  // Catches the red alert panel (#287) drawing rows wider or narrower than the dialog, which
  // breaks the overlay, or content lost for a styled line, with colors on or off.
  test.each(['', '1'])('the alert panel is exactly as wide as asked (NO_COLOR=%j)', (noColor) => {
    vi.stubEnv('NO_COLOR', noColor)
    installConsoleTheme()
    const lines = [strong('⚠ Proxy auth is off'), `${paint('accent', '→')} Generate a token`, '']

    for (const width of [20, 60, 96]) {
      const rows = alertPanel(lines, width)

      expect(rows).toHaveLength(lines.length + 2)
      for (const row of rows) expect(visibleWidth(row)).toBe(width)
      expect(stripTerminalSequences(rows[1] ?? '')).toMatch(/^│ ⚠ Proxy auth is .*│$/)
    }
  })
})
