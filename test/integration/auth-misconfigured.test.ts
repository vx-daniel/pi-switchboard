/**
 * Proxy auth that cannot be applied: `authToken` in proxy-config.json is not a string (#82), or
 * `--auth-token` / `PI_PROXY_AUTH_TOKEN` is set but empty (#99). Repairing either to "auth off"
 * would turn a requested token into an open proxy. So the proxy starts but fails closed: every
 * authenticated route refuses with a fixed message until it is fixed; `/healthz` stays up. Only
 * '' in the file (or no authToken) turns auth off.
 */

import { rmSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { loadConfig } from '@proxy/config/env'
import { DEFAULT_CONFIG, loadConfigFromFile, saveConfigToFile } from '@proxy/config/schema'
import { createApp } from '@proxy/server/app'
import { EMPTY_OVERRIDE_AUTH_MESSAGE, MISCONFIGURED_AUTH_MESSAGE } from '@proxy/server/middleware'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir, offlineProvider } from '../fixtures/agent-dir'
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
 * Writes proxy-config.json into the fixture agent dir.
 *
 * @param config - the raw file contents, serialized as JSON as given
 */
function writeProxyConfig(config: Record<string, unknown>): void {
  writeFileSync(join(agentDir.path, 'proxy-config.json'), JSON.stringify(config))
}

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

describe('a non-string authToken fails closed', () => {
  // Catches the #82 bug: a token the proxy cannot read turning auth off, so any client reaches
  // the provider logins. Also catches the refusal quoting the configured value.
  test.each([12345, true, null, { token: 'notarealsecret-in-an-object' }])(
    '%j: /v1 refuses with the fixed message, /healthz stays up',
    async (authToken) => {
      writeProxyConfig({ authToken })

      expect(await ask('/v1/models')).toEqual({
        status: HTTP_UNAUTHORIZED,
        body: {
          error: {
            message: MISCONFIGURED_AUTH_MESSAGE,
            type: 'authentication_error',
            param: null,
            code: null
          }
        }
      })
      expect((await ask('/healthz')).status).toBe(HTTP_OK)
      expect((await ask('/healthz/models')).status).toBe(HTTP_UNAUTHORIZED)
    }
  )

  // Catches a flag or env token not winning over the broken file, which would leave an operator
  // with no way to run the proxy short of editing the file.
  test('a token from the environment wins, and works', async () => {
    writeProxyConfig({ authToken: 12345 })
    vi.stubEnv('PI_PROXY_AUTH_TOKEN', ENV_TOKEN)

    expect((await ask('/v1/models', ENV_TOKEN)).status).toBe(HTTP_OK)
    expect((await ask('/v1/models')).status).toBe(HTTP_UNAUTHORIZED)
  })

  // Catches the fix spreading to the documented way to turn auth off.
  test("'' is still auth off", async () => {
    writeProxyConfig({ authToken: '' })

    expect((await ask('/v1/models')).status).toBe(HTTP_OK)
  })

  // Catches a missing authToken (the default) being read as invalid.
  test('no authToken at all is auth off', async () => {
    writeProxyConfig({ port: 4141 })

    expect((await ask('/v1/models')).status).toBe(HTTP_OK)
  })
})

describe('an empty token override fails closed (#99)', () => {
  // Catches an empty PI_PROXY_AUTH_TOKEN becoming a token nothing can match, refusing every request
  // without a word, or falling back to the file's token, which would ignore what was set: the
  // proxy refuses with a message that says the override is empty, and /healthz stays up.
  test('PI_PROXY_AUTH_TOKEN="": refused with the fixed message, the file token unused', async () => {
    writeProxyConfig({ authToken: 'notarealsecret-file-token' })
    vi.stubEnv('PI_PROXY_AUTH_TOKEN', '')

    expect({
      withoutToken: await ask('/v1/models'),
      withFileToken: (await ask('/v1/models', 'notarealsecret-file-token')).status,
      liveness: (await ask('/healthz')).status
    }).toEqual({
      withoutToken: {
        status: HTTP_UNAUTHORIZED,
        body: {
          error: {
            message: EMPTY_OVERRIDE_AUTH_MESSAGE,
            type: 'authentication_error',
            param: null,
            code: null
          }
        }
      },
      withFileToken: HTTP_UNAUTHORIZED,
      liveness: HTTP_OK
    })
  })
})

describe('saving the config keeps an invalid authToken', () => {
  // Catches the second fail-open path: a config loaded from the broken file carries the repaired
  // '', so saving any other setting (the settings panel, the model selector) would write '' and
  // turn auth off for good.
  test('saving another setting writes the invalid value back', () => {
    writeProxyConfig({ authToken: 12345, port: 4141 })

    saveConfigToFile({ ...loadConfigFromFile(), port: 5151 })

    expect(proxyConfigOnDisk()).toEqual({ ...DEFAULT_CONFIG, port: 5151, authToken: 12345 })
  })

  // Catches the explicit choices (disabling auth, a reset) being unable to clear it.
  test('an explicit replace writes the new value', () => {
    writeProxyConfig({ authToken: 12345 })

    saveConfigToFile(loadConfigFromFile(), { replaceInvalidAuthToken: true })

    expect(proxyConfigOnDisk()).toEqual(DEFAULT_CONFIG)
  })

  // Catches the guard keeping a value over a real new token.
  test('a new token replaces it', () => {
    writeProxyConfig({ authToken: 12345 })

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
