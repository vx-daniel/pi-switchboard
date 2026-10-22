import type { OverrideSource, ProxyAuth } from '@proxy/config/env'
import { createProxyAuthSwitch } from '@proxy/server/proxy-auth'
import { type AuthScreens, type AuthTarget, runAuthMenu } from '@proxy/tui/proxy-auth-menu'
import { describe, expect, test } from 'vite-plus/test'

/** What scripted dialogs saw and did. */
interface Script {
  readonly screens: AuthScreens
  /** Each dialog's title, in order. */
  readonly titles: string[]
  /** Each selector's options, in order. */
  readonly options: (readonly string[])[]
  /** What was copied. */
  readonly copied: string[]
}

/**
 * Builds dialogs that answer from scripts: each selector picks the next label (or cancels on
 * `undefined`), each input answers the next text.
 *
 * @param picks - the selectors' answers, in order
 * @param typed - the inputs' answers, in order
 * @returns the dialogs and what they saw
 */
function scripted(picks: (string | undefined)[], typed: (string | undefined)[] = []): Script {
  const titles: string[] = []
  const options: (readonly string[])[] = []
  const copied: string[] = []
  const screens: AuthScreens = {
    select: (title, labels) => {
      titles.push(title)
      options.push(labels)
      return Promise.resolve(picks.shift())
    },
    input: (title) => {
      titles.push(title)
      return Promise.resolve(typed.shift())
    },
    copy: (text) => {
      copied.push(text)
      return Promise.resolve()
    }
  }
  return { screens, titles, options, copied }
}

/**
 * Builds the proxy the menu changes, on loopback.
 *
 * @param initial - the auth it starts with
 * @param override - the flag or env var that set the starting token, if one did
 * @returns the proxy
 */
function proxyWith(initial: ProxyAuth, override?: OverrideSource): AuthTarget {
  return {
    proxyAuth: createProxyAuthSwitch(initial),
    override,
    overrideToken: override !== undefined && initial.kind === 'token' ? initial.token : undefined,
    host: '127.0.0.1',
    address: '127.0.0.1:4141'
  }
}

/**
 * Builds a save that records the tokens it was given.
 *
 * @param succeeds - whether the write succeeds
 * @returns the save and its record
 */
function recordingSave(succeeds = true): { save: (token: string) => boolean; saved: string[] } {
  const saved: string[] = []
  return {
    saved,
    save: (token) => {
      saved.push(token)
      return succeeds
    }
  }
}

describe('the proxy auth menu', () => {
  // Catches a generated token that is applied but not saved (lost at restart), not shown (no way to
  // give it to clients), or weak.
  test('a generated token is applied, saved, shown and copied', async () => {
    const proxy = proxyWith({ kind: 'off' })
    const script = scripted(['Generate a token', 'Copy it'])
    const { save, saved } = recordingSave()

    await runAuthMenu(proxy, script.screens, save)

    const applied = proxy.proxyAuth.current()
    expect(applied.kind).toBe('token')
    const token = applied.kind === 'token' ? applied.token : ''
    expect(token).toMatch(/^[\w-]{43}$/)
    expect(saved).toEqual([token])
    expect(script.titles[1]).toContain(token)
    expect(script.copied).toEqual([token])
  })

  // Catches turning off a saved token for this session only: it would come back at the restart.
  test('turning off a token from the config file saves auth off', async () => {
    const proxy = proxyWith({ kind: 'token', token: 'file-token' })
    const { save, saved } = recordingSave()

    await runAuthMenu(proxy, scripted(['Turn auth off']).screens, save)

    expect(proxy.proxyAuth.current()).toEqual({ kind: 'off' })
    expect(saved).toEqual([''])
  })

  // Catches the console writing over the config file for a token it did not set, or offering an
  // "off" that silently comes back at the next start without saying so.
  test('turning off a token from --auth-token lasts until the restart and saves nothing', async () => {
    const proxy = proxyWith({ kind: 'token', token: 'flag-token' }, '--auth-token')
    const script = scripted(['Turn auth off until the proxy restarts'])
    const { save, saved } = recordingSave()

    await runAuthMenu(proxy, script.screens, save)

    expect(script.options[0]).not.toContain('Turn auth off')
    expect(proxy.proxyAuth.current()).toEqual({ kind: 'off' })
    expect(saved).toEqual([])
  })

  // Catches a token set from the console still treated as the flag's, so turning it off would not
  // be saved.
  test('a token that replaced the flag’s is turned off for good', async () => {
    const proxy = proxyWith({ kind: 'token', token: 'flag-token' }, 'PI_SWITCHBOARD_AUTH_TOKEN')
    const { save, saved } = recordingSave()

    await runAuthMenu(proxy, scripted(['Enter a new token'], ['console-token']).screens, save)
    const script = scripted(['Turn auth off'])
    await runAuthMenu(proxy, script.screens, save)

    expect(script.options[0]).toContain('Turn auth off')
    expect(saved).toEqual(['console-token', ''])
  })

  // Catches a typed token that no client could ever match (a header value loses its surrounding
  // spaces) being applied, which would lock every client out.
  test('a typed token with surrounding spaces is asked for again', async () => {
    const proxy = proxyWith({ kind: 'off' })
    const script = scripted(['Enter a token'], [' padded ', '', 'good token'])
    const { save, saved } = recordingSave()

    await runAuthMenu(proxy, script.screens, save)

    expect(script.titles[2]).toContain('starts or ends with a space')
    expect(script.titles[3]).toContain('empty')
    expect(proxy.proxyAuth.current()).toEqual({ kind: 'token', token: 'good token' })
    expect(saved).toEqual(['good token'])
  })

  // Catches a failed save undoing the change: the operator asked for auth now, and it applies
  // until the proxy stops (the log says it was not saved).
  test('a token that could not be saved still applies', async () => {
    const proxy = proxyWith({ kind: 'off' })
    const { save } = recordingSave(false)

    await runAuthMenu(proxy, scripted(['Enter a token'], ['token']).screens, save)

    expect(proxy.proxyAuth.current()).toEqual({ kind: 'token', token: 'token' })
  })

  // Catches Esc in a dialog changing auth anyway.
  test('cancelling changes nothing', async () => {
    const proxy = proxyWith({ kind: 'token', token: 'file-token' })
    const { save, saved } = recordingSave()

    await runAuthMenu(proxy, scripted([undefined]).screens, save)
    await runAuthMenu(proxy, scripted(['Enter a new token'], [undefined]).screens, save)

    expect(proxy.proxyAuth.current()).toEqual({ kind: 'token', token: 'file-token' })
    expect(saved).toEqual([])
  })
})
