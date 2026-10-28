/**
 * Proxy auth that cannot be applied: `authToken` in proxy-config.json is not a string (#82),
 * `--auth-token` / `PI_SWITCHBOARD_AUTH_TOKEN` is set but empty (#99), or proxy-config.json exists
 * but cannot be read or parsed while nothing else sets a token. Repairing any of these to "auth
 * off" would turn a requested token into an open proxy, and starting to refuse every request hides
 * the mistake behind a running process. So loading the config refuses, and the proxy does not
 * start. Only '' in the file (or no authToken, or no file) turns auth off.
 */

import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { type CliOverrides, loadConfig, UnusableProxyAuthError } from '@proxy/config/env'
import {
  DEFAULT_CONFIG,
  describeConfigFileProblem,
  loadConfigFromFile,
  saveConfigToFile
} from '@proxy/config/schema'
import { createApp } from '@proxy/server/app'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

import {
  type FixtureAgentDir,
  loadFixtureAgentDir,
  offlineProvider,
  writeProxyConfig
} from '../fixtures/agent-dir'
import { jsonBody } from '../helpers'

const HTTP_OK = 200
const HTTP_UNAUTHORIZED = 401
const ENV_TOKEN = 'notarealsecret-env-token'

let agentDir: FixtureAgentDir

beforeEach(async () => {
  agentDir = await loadFixtureAgentDir({
    modelsJson: { providers: { 'auth-mock': offlineProvider('auth-model') } }
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
  agentDir.remove()
})

/**
 * Reads proxy-config.json as it is on disk now.
 *
 * @returns the parsed file contents
 */
function proxyConfigOnDisk(): unknown {
  return JSON.parse(readFileSync(join(agentDir.path, 'proxy-config.json'), 'utf-8'))
}

/**
 * Sends a GET to an app built from the current files, the way the proxy builds it at start-up.
 *
 * @param path - the request path
 * @param bearer - the bearer token to send; `undefined` sends no `Authorization` header
 * @returns the response status and parsed JSON body
 */
async function ask(path: string, bearer?: string): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> =
    bearer === undefined ? {} : { Authorization: `Bearer ${bearer}` }
  const response = await createApp(loadConfig()).request(path, { headers })
  return { status: response.status, body: await jsonBody(response) }
}

/**
 * Loads the config from the current files and reports why proxy auth refused it.
 *
 * @param cli - the CLI overrides to load with
 * @returns the refusal's cause; `undefined` when the config loaded; anything else thrown, as is
 */
function refusal(cli: CliOverrides = {}): unknown {
  try {
    loadConfig(cli)
    return undefined
  } catch (error) {
    return error instanceof UnusableProxyAuthError ? error.invalid : error
  }
}

describe('a non-string authToken refuses to start', () => {
  // Catches the #82 bug: a token the proxy cannot read turning auth off, so any client reaches
  // the provider logins; or the proxy starting at all with it.
  test.each([12345, true, null, { token: 'notarealsecret-in-an-object' }])(
    '%j: loading the config refuses',
    (authToken) => {
      writeProxyConfig(agentDir.path, { authToken })

      expect(refusal()).toEqual({ cause: 'file-token-not-string' })
    }
  )

  // Catches a flag or env token not winning over the broken file, which would leave an operator
  // with no way to run the proxy short of editing the file.
  test('a token from the environment wins, and works', async () => {
    writeProxyConfig(agentDir.path, { authToken: 12345 })
    vi.stubEnv('PI_SWITCHBOARD_AUTH_TOKEN', ENV_TOKEN)

    expect((await ask('/v1/models', ENV_TOKEN)).status).toBe(HTTP_OK)
    expect((await ask('/v1/models')).status).toBe(HTTP_UNAUTHORIZED)
  })

  // Catches the fix spreading to the documented way to turn auth off.
  test("'' is still auth off", async () => {
    writeProxyConfig(agentDir.path, { authToken: '' })

    expect((await ask('/v1/models')).status).toBe(HTTP_OK)
  })

  // Catches a missing authToken (the default) being read as invalid.
  test('no authToken at all is auth off', async () => {
    writeProxyConfig(agentDir.path, { port: 4141 })

    expect((await ask('/v1/models')).status).toBe(HTTP_OK)
  })
})

describe('a config file that cannot be used refuses to start', () => {
  // Catches the fail-open path a corrupt or unreadable file opened: the defaults took its place,
  // and the defaults' '' turned a token the file may hold into auth off, at `warn`.
  test('a file that is not valid JSON refuses', () => {
    writeFileSync(join(agentDir.path, 'proxy-config.json'), '{"authToken": "notarealsecret-fi')

    expect(refusal()).toEqual({ cause: 'file-unusable', file: { problem: 'not-json' } })
  })

  // Catches an unreadable file (here a directory in its place, which fails the same way as a
  // permission error without needing one) being treated as "no file".
  test('a file that cannot be read refuses, naming the error code', () => {
    rmSync(join(agentDir.path, 'proxy-config.json'), { force: true })
    mkdirSync(join(agentDir.path, 'proxy-config.json'))

    expect(refusal()).toEqual({
      cause: 'file-unusable',
      file: { problem: 'unreadable', code: 'EISDIR' }
    })
  })

  // Catches the refusal leaving an operator with a corrupt file no way to run the proxy short of
  // fixing it: a flag or env token stands in for whatever the file holds.
  test('a token from the environment wins, and works', async () => {
    writeFileSync(join(agentDir.path, 'proxy-config.json'), '{not json')
    vi.stubEnv('PI_SWITCHBOARD_AUTH_TOKEN', ENV_TOKEN)

    expect((await ask('/v1/models', ENV_TOKEN)).status).toBe(HTTP_OK)
    expect((await ask('/v1/models')).status).toBe(HTTP_UNAUTHORIZED)
  })

  // Catches the refusal spreading to a missing file, which holds no token and is the fresh-install
  // state.
  test('no file at all is auth off', async () => {
    rmSync(join(agentDir.path, 'proxy-config.json'), { force: true })

    expect((await ask('/v1/models')).status).toBe(HTTP_OK)
  })
})

describe('describeConfigFileProblem', () => {
  // Catches the fatal line and the extension's notification wording drifting apart, or the
  // unreadable case losing the fs error code that says what to fix.
  test.each([
    ['unreadable', { problem: 'unreadable', code: 'EACCES' } as const, 'cannot be read (EACCES)'],
    ['not JSON', { problem: 'not-json' } as const, 'is not valid JSON']
  ])('%s: the words that follow "the file"', (_label, problem, expected) => {
    expect(describeConfigFileProblem(problem)).toBe(expected)
  })
})

describe('an empty token override refuses to start (#99)', () => {
  // Catches an empty override becoming a token nothing can match, falling back to the file's token
  // (which would ignore what was set), or turning auth off: loading the config refuses, naming
  // which override was empty.
  test.each([
    {
      label: 'PI_SWITCHBOARD_AUTH_TOKEN=""',
      env: '',
      cli: {},
      source: 'PI_SWITCHBOARD_AUTH_TOKEN'
    },
    { label: "--auth-token ''", env: undefined, cli: { authToken: '' }, source: '--auth-token' }
  ])('$label refuses, the file token unused', ({ env, cli, source }) => {
    writeProxyConfig(agentDir.path, { authToken: 'notarealsecret-file-token' })
    vi.stubEnv('PI_SWITCHBOARD_AUTH_TOKEN', env)

    expect(refusal(cli)).toEqual({ cause: 'empty-override', source })
  })

  // Catches the flag not winning over an empty env var, which would refuse a proxy the operator
  // gave a usable token on the command line.
  test('--auth-token wins over an empty PI_SWITCHBOARD_AUTH_TOKEN', () => {
    vi.stubEnv('PI_SWITCHBOARD_AUTH_TOKEN', '')

    expect(loadConfig({ authToken: ENV_TOKEN }).proxyAuth).toEqual({
      kind: 'token',
      token: ENV_TOKEN
    })
  })
})

describe('the pre-rename PI_PROXY_AUTH_TOKEN (#65)', () => {
  // Catches the old variable ignored silently: a proxy its operator meant to protect would start
  // with auth off, open to anyone who reaches the port.
  test.each([
    { label: 'set alone', old: ENV_TOKEN, file: {} },
    { label: 'set but empty', old: '', file: {} },
    {
      label: 'set beside a token in the config file',
      old: ENV_TOKEN,
      file: { authToken: 'notarealsecret-file-token' }
    }
  ])('$label, it refuses to start', ({ old, file }) => {
    writeProxyConfig(agentDir.path, file)
    vi.stubEnv('PI_PROXY_AUTH_TOKEN', old)

    expect(refusal()).toEqual({ cause: 'renamed-env-var' })
  })

  // Catches the old variable still read: it would win over, or stand in for, the new one.
  test('with PI_SWITCHBOARD_AUTH_TOKEN or --auth-token set, only the new token counts', () => {
    vi.stubEnv('PI_PROXY_AUTH_TOKEN', 'notarealsecret-old-token')
    vi.stubEnv('PI_SWITCHBOARD_AUTH_TOKEN', ENV_TOKEN)

    expect(loadConfig().proxyAuth).toEqual({ kind: 'token', token: ENV_TOKEN })
    expect(loadConfig({ authToken: 'notarealsecret-flag-token' }).proxyAuth).toEqual({
      kind: 'token',
      token: 'notarealsecret-flag-token'
    })
  })
})

describe('saving the config keeps an invalid authToken', () => {
  // Catches the second fail-open path: a config loaded from the broken file carries the repaired
  // '', so saving any other setting (the settings panel, the model selector) would write '' and
  // turn auth off for good. `null` is the case a check of "set" by `undefined` alone lets through.
  test.each([
    ['a number', 12345],
    ['null', null]
  ])('saving another setting writes the invalid value back: %s', (_label, authToken) => {
    writeProxyConfig(agentDir.path, { authToken, port: 4141 })

    saveConfigToFile({ ...loadConfigFromFile(), port: 5151 })

    expect(proxyConfigOnDisk()).toEqual({ ...DEFAULT_CONFIG, port: 5151, authToken })
  })

  // Catches the explicit choices (disabling auth, a reset) being unable to clear it.
  test('an explicit replace writes the new value', () => {
    writeProxyConfig(agentDir.path, { authToken: 12345 })

    saveConfigToFile(loadConfigFromFile(), { replaceInvalidAuthToken: true })

    expect(proxyConfigOnDisk()).toEqual(DEFAULT_CONFIG)
  })

  // Catches the guard keeping a value over a real new token.
  test('a new token replaces it', () => {
    writeProxyConfig(agentDir.path, { authToken: 12345 })

    saveConfigToFile({ ...loadConfigFromFile(), authToken: 'notarealsecret-new-token' })

    expect(proxyConfigOnDisk()).toEqual({
      ...DEFAULT_CONFIG,
      authToken: 'notarealsecret-new-token'
    })
  })

  // Catches the guard reaching a file without the problem.
  test('a missing file is written as given', () => {
    rmSync(join(agentDir.path, 'proxy-config.json'), { force: true })

    saveConfigToFile({ ...DEFAULT_CONFIG, port: 5151 })

    expect(proxyConfigOnDisk()).toEqual({ ...DEFAULT_CONFIG, port: 5151 })
  })
})

describe('saving the config never writes over a file that cannot be used (#288)', () => {
  const BROKEN = '{"authToken": "notarealsecret-file-token", "port": 51'

  // Catches a save (the console's settings, aliases or labels, the settings panel) writing the
  // defaults the broken file loads as over it: the token it holds would be lost, and the next
  // start or console restart would run with auth off.
  test('a save leaves a file that is not valid JSON as it is', () => {
    const path = join(agentDir.path, 'proxy-config.json')
    writeFileSync(path, BROKEN)

    const written = saveConfigToFile({ ...loadConfigFromFile(), port: 5151 })

    expect(written).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe(BROKEN)
  })

  // Catches `/proxy reset`, the explicit way out, unable to replace the broken file.
  test('a reset writes over it', () => {
    writeFileSync(join(agentDir.path, 'proxy-config.json'), BROKEN)

    const written = saveConfigToFile(DEFAULT_CONFIG, {
      replaceInvalidAuthToken: true,
      replaceUnusableFile: true
    })

    expect(written).toBe(true)
    expect(proxyConfigOnDisk()).toEqual(DEFAULT_CONFIG)
  })
})

describe('where the token came from', () => {
  // Catches the console misjudging a flag or env token as the file's: turning it off would then be
  // saved, yet come back at the next start, or the file's token treated as the flag's.
  test('a flag or env token is recorded as such, the file’s is not', () => {
    writeProxyConfig(agentDir.path, { authToken: 'notarealsecret-file-token' })
    expect(loadConfig().proxyAuthOverride).toBeUndefined()

    vi.stubEnv('PI_SWITCHBOARD_AUTH_TOKEN', ENV_TOKEN)
    expect(loadConfig().proxyAuthOverride).toBe('PI_SWITCHBOARD_AUTH_TOKEN')
    expect(loadConfig({ authToken: 'notarealsecret-flag-token' }).proxyAuthOverride).toBe(
      '--auth-token'
    )
  })
})
