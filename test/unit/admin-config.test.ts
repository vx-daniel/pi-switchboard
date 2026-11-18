import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type AdminUiSettings, adminUiProblems, resolveAdminUi } from '@proxy/config/admin'
import { ADMIN_UI_DEFAULTS, type AdminUiConfig } from '@proxy/config/admin-schema'
import { afterAll, describe, expect, test } from 'vite-plus/test'

const SESSION_KEY = 'notarealsecret-session-key-0123456789abcdef'
const SECRETS = {
  PI_SWITCHBOARD_GITHUB_CLIENT_ID: 'Iv1.notarealclient',
  PI_SWITCHBOARD_GITHUB_CLIENT_SECRET: 'notarealsecret-client-secret',
  PI_SWITCHBOARD_ADMIN_SESSION_KEY: SESSION_KEY
}
const secretsDir = mkdtempSync(join(tmpdir(), 'admin-config-'))

afterAll(() => {
  rmSync(secretsDir, { recursive: true, force: true })
})

/**
 * Resolves the admin UI from a file section on top of the defaults and an environment.
 *
 * @param file - the fields of the file's `adminUi` to set
 * @param env - the environment
 * @returns the resolved settings
 */
function resolved(
  file: Partial<AdminUiConfig>,
  env: Record<string, string | undefined>
): AdminUiSettings {
  return resolveAdminUi({ ...ADMIN_UI_DEFAULTS, ...file }, env)
}

describe('resolveAdminUi', () => {
  // Catches env vars not overriding the file, which a Docker operator sets them to do.
  test('env vars win over the file', () => {
    const settings = resolved(
      { host: '127.0.0.1', port: 4142, editors: ['alice'] },
      {
        PI_SWITCHBOARD_ADMIN_UI: 'true',
        PI_SWITCHBOARD_ADMIN_HOST: '0.0.0.0',
        PI_SWITCHBOARD_ADMIN_PORT: '9443',
        PI_SWITCHBOARD_ADMIN_URL: 'https://admin.example.com',
        PI_SWITCHBOARD_ADMIN_EDITORS: 'my-org/ops, carol',
        PI_SWITCHBOARD_ADMIN_VIEWERS: 'bob'
      }
    )

    expect(settings).toMatchObject({
      enabled: true,
      host: '0.0.0.0',
      port: 9443,
      publicUrl: 'https://admin.example.com',
      editors: ['my-org/ops', 'carol'],
      viewers: ['bob']
    })
  })

  // Catches a callback address GitHub would not match: the listener's own, IPv6 in brackets.
  test.each([
    ['127.0.0.1', 4142, 'http://127.0.0.1:4142'],
    ['::1', 4142, 'http://[::1]:4142']
  ])('without a publicUrl, %s:%s is %s', (host, port, expected) => {
    expect(resolved({ host, port }, {}).publicUrl).toBe(expected)
  })

  // Catches GitHub Enterprise Server sent to api.github.com, or github.com sent to /api/v3.
  test.each([
    ['https://github.com', 'https://api.github.com'],
    ['https://github.example.com', 'https://github.example.com/api/v3']
  ])('GitHub at %s has its API at %s', (githubUrl, apiUrl) => {
    expect(resolved({ githubUrl }, {}).apiUrl).toBe(apiUrl)
  })

  // Catches a Docker secret file not read, or read with its trailing newline.
  test('reads a secret from the file its _FILE variable names', () => {
    const path = join(secretsDir, 'client-secret')
    writeFileSync(path, 'notarealsecret-from-file\n')
    const settings = resolved(
      {},
      {
        ...SECRETS,
        PI_SWITCHBOARD_GITHUB_CLIENT_SECRET: undefined,
        PI_SWITCHBOARD_GITHUB_CLIENT_SECRET_FILE: path
      }
    )

    expect(settings.signIn?.clientSecret).toBe('notarealsecret-from-file')
  })
})

describe('adminUiProblems', () => {
  /**
   * Resolves an enabled admin UI that may start, with fields changed.
   *
   * @param file - the fields of the file's `adminUi` to change
   * @param env - env vars to add or unset
   * @returns the problems
   */
  function problemsOf(
    file: Partial<AdminUiConfig>,
    env: Record<string, string | undefined> = {}
  ): string[] {
    return adminUiProblems(
      resolved({ enabled: true, editors: ['alice'], ...file }, { ...SECRETS, ...env })
    )
  }

  // Catches a refusal where the admin UI is safe: on loopback, with sign-in and someone listed.
  test('none on loopback with sign-in and an editor', () => {
    expect(problemsOf({})).toEqual([])
  })

  // Catches the admin UI off being refused for settings it never uses.
  test('none while it is off, whatever else is missing', () => {
    expect(adminUiProblems(resolved({ enabled: false }, {}))).toEqual([])
  })

  // Catches an unsafe or unusable admin UI started (constitution principle III): each case is
  // refused, and the reason names what to fix, never a secret's value.
  test.each([
    [
      'no sign-in secrets',
      {},
      {
        PI_SWITCHBOARD_GITHUB_CLIENT_ID: undefined,
        PI_SWITCHBOARD_GITHUB_CLIENT_SECRET: undefined,
        PI_SWITCHBOARD_ADMIN_SESSION_KEY: undefined
      },
      'PI_SWITCHBOARD_GITHUB_CLIENT_ID'
    ],
    [
      'a short session key',
      {},
      { PI_SWITCHBOARD_ADMIN_SESSION_KEY: 'notarealsecret' },
      'shorter than 32'
    ],
    [
      'a secret set twice',
      {},
      { PI_SWITCHBOARD_ADMIN_SESSION_KEY_FILE: '/run/secrets/key' },
      'both set'
    ],
    ['nobody listed', { editors: [], viewers: [] }, {}, 'nobody may sign in'],
    [
      'a LAN bind without https',
      { host: '0.0.0.0', publicUrl: 'http://192.168.1.5:4142' },
      {},
      'not https'
    ],
    ['a LAN bind with no address', { host: '0.0.0.0' }, {}, 'without an https address']
  ])('refuses %s', (_case, file, env, reason) => {
    const problems = problemsOf(file, env)

    expect(problems.join('\n')).toContain(reason)
    expect(problems.join('\n')).not.toContain('notarealsecret')
  })

  // Catches https beyond loopback refused, which is the supported way to reach it remotely.
  test('none on a LAN bind behind https', () => {
    expect(problemsOf({ host: '0.0.0.0', publicUrl: 'https://admin.example.com' })).toEqual([])
  })
})
