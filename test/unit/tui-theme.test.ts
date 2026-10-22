import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { highlight, installConsoleTheme, paint, strong } from '@proxy/tui/theme'
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
    expect([paint('error', 'x'), strong('x'), highlight('x')]).toEqual(['x', 'x', 'x'])
  })
})
