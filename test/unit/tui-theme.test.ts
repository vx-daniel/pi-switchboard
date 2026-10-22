import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { activeTab, chrome, highlight, installConsoleTheme, paint, strong } from '@proxy/tui/theme'
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
    for (const painted of [paint('success', 'ok'), strong('ok'), highlight('ok')]) {
      expect(painted).not.toBe('ok')
      expect(stripTerminalSequences(painted)).toBe('ok')
    }
  })

  // Catches NO_COLOR ignored: the console must print plain text, and leave pi on its own theme.
  test('colors nothing when NO_COLOR is set', () => {
    installConsoleTheme('1')

    expect(piThemeName()).not.toBe('tokyonight-storm')
    expect([paint('error', 'x'), strong('x'), highlight('x'), activeTab('x')]).toEqual([
      'x',
      'x',
      'x',
      'x'
    ])
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
    // The chrome's own background sequence opens the row: an escape ending at the first `m`.
    const background = painted.slice(0, painted.indexOf('m') + 1)
    expect(background.startsWith('\u001b[')).toBe(true)
    // Every end of a background inside the row is followed by the chrome's background again;
    // only the row's own final reset is not.
    const body = painted.slice(0, -'\u001b[49m'.length)
    for (const end of ['\u001b[0m', '\u001b[49m']) {
      for (const part of body.split(end).slice(1)) expect(part.startsWith(background)).toBe(true)
    }
  })
})
