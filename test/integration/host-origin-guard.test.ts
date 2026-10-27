/**
 * Tests the host/origin guard (#188): what it refuses and what it lets through, where it runs
 * relative to proxy auth, and that it stays out of the way while off. The guard covers every
 * path, so most cases use the open `/healthz`, which answers without pi's model runtime.
 *
 * @packageDocumentation
 */
import { resetSync } from '@logtape/logtape'
import type { ServerConfig } from '@proxy/config/env'
import { configureLogging } from '@proxy/logging'
import { isRecord } from '@proxy/utils/guards'
import { afterEach, describe, expect, test } from 'vite-plus/test'

import { jsonBody, testApp, testConfig } from '../helpers'

/** A token for the cases that turn proxy auth on. */
const TOKEN = 'notarealsecret-guard'
/** The longest refused value a log line quotes. */
const MAX_LOGGED_VALUE_LENGTH = 128

/**
 * Builds the test config with the guard on or off.
 *
 * @param guard - whether the host/origin guard is on
 * @param auth - the proxy auth to apply; off by default
 * @returns the config
 */
function configWith(
  guard: boolean,
  auth: ServerConfig['proxyAuth'] = { kind: 'off' }
): ServerConfig {
  return { ...testConfig(), hostOriginGuardEnabled: guard, proxyAuth: auth }
}

/**
 * Reads the error code of an OpenAI error body.
 *
 * @param body - the parsed body
 * @returns `error.code`, or `undefined` when the body is not an error
 */
function errorCodeOf(body: unknown): unknown {
  return isRecord(body) && isRecord(body['error']) ? body['error']['code'] : undefined
}

/**
 * Sends `GET /healthz` with the given headers to an app with the guard on.
 *
 * @param headers - the request headers
 * @returns the status and the error code, if any
 */
async function healthWith(
  headers: Record<string, string>
): Promise<{ status: number; code: unknown }> {
  const response = await testApp(configWith(true)).request('/healthz', { headers })
  return { status: response.status, code: errorCodeOf(await jsonBody(response)) }
}

afterEach(() => {
  resetSync()
})

describe('the host/origin guard (#188)', () => {
  // Catches the guard refusing a name a legitimate client uses: loopback names and addresses, a
  // LAN address, a Docker service name, Docker Desktop's name for the host, or no Host at all.
  test.each([
    '127.0.0.1:4141',
    'localhost:4141',
    'LOCALHOST',
    '[::1]:4141',
    '127.0.0.2',
    '192.168.50.116:4141',
    'proxy:4141',
    'j5-worker-proxy:4141',
    'host.docker.internal:4141',
    '2130706433'
  ])('lets Host %s through', async (host) => {
    expect((await healthWith({ host })).status).toBe(200)
  })

  // Catches DNS rebinding getting through: a page's requests carry the attacker's own dotted
  // name, also one dressed up as loopback, or a local name the guard cannot vouch for.
  test.each([
    'attacker.example',
    '127.0.0.1.nip.io:4141',
    'localhost.attacker.example',
    '127.0.0.1.attacker.example',
    'mybox.local'
  ])('refuses Host %s with invalid_host', async (host) => {
    expect(await healthWith({ host })).toEqual({ status: 403, code: 'invalid_host' })
  })

  // Catches a web page's request getting through, or the proxy's own pages (/docs) refused: a
  // browser sends Origin on cross-origin requests; the proxy's own origin must match the Host,
  // brackets and all for IPv6, and with no Host there is no own origin to match.
  test.each([
    [{ host: '127.0.0.1:4141' }, 200, undefined],
    [{ host: '127.0.0.1:4141', origin: 'http://127.0.0.1:4141' }, 200, undefined],
    [{ host: 'localhost:4141', origin: 'https://localhost:4141' }, 200, undefined],
    [{ host: '[::1]:4141', origin: 'http://[::1]:4141' }, 200, undefined],
    [{}, 200, undefined],
    [{ origin: 'http://127.0.0.1:4141' }, 403, 'invalid_origin'],
    [{ host: '127.0.0.1:4141', origin: 'https://evil.example' }, 403, 'invalid_origin'],
    [{ host: '127.0.0.1:4141', origin: 'null' }, 403, 'invalid_origin'],
    [{ host: '127.0.0.1:4141', origin: 'http://localhost:4141' }, 403, 'invalid_origin'],
    [{ host: '127.0.0.1:4141', origin: 'http://127.0.0.1:3000' }, 403, 'invalid_origin']
  ])('%j answers %i', async (headers, status, code) => {
    expect(await healthWith(headers)).toEqual({ status, code })
  })

  // Catches a refused chat request reaching the route (and so a provider), whatever its content
  // type: the guard answers before the body is read.
  test('refuses a cross-origin text/plain chat POST before the route', async () => {
    const response = await testApp(configWith(true)).request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'host': '127.0.0.1:4141',
        'origin': 'https://evil.example',
        'content-type': 'text/plain'
      },
      body: '{"model":"any/model","messages":[{"role":"user","content":"hi"}]}'
    })
    expect(response.status).toBe(403)
    expect(errorCodeOf(await jsonBody(response))).toBe('invalid_origin')
  })

  // Catches the guard running after proxy auth, which would make its answer depend on the token:
  // with auth on and no token, a refused origin is 403, not 401.
  test('answers before proxy auth', async () => {
    const app = testApp(configWith(true, { kind: 'token', token: TOKEN }))
    const response = await app.request('/v1/models', {
      headers: { host: '127.0.0.1:4141', origin: 'https://evil.example' }
    })
    expect(response.status).toBe(403)
  })

  // Catches the guard acting while off: the default leaves every request as it was.
  test('off, it refuses nothing', async () => {
    const response = await testApp(configWith(false)).request('/healthz', {
      headers: { host: 'attacker.example', origin: 'https://evil.example' }
    })
    expect(response.status).toBe(200)
  })

  // Catches a scanner flooding the log: the same refused value warns once, then goes to debug,
  // and the logged value, text the client chose, is cut short.
  test('warns once per refused value, with the value cut short', async () => {
    const lines: string[] = []
    configureLogging({ level: 'debug', format: 'json', write: (line) => lines.push(line) })
    const app = testApp(configWith(true))
    const host = `${'a'.repeat(200)}.example`
    await app.request('/healthz', { headers: { host } })
    await app.request('/healthz', { headers: { host } })
    const refusals = lines
      .map((line): unknown => JSON.parse(line))
      .filter(isRecord)
      .filter((record) => String(record['message']).includes('host/origin guard'))
    expect(refusals.map((record) => record['level'])).toEqual(['WARN', 'DEBUG'])
    const properties = refusals[0]?.['properties']
    expect(isRecord(properties) ? properties['value'] : undefined).toHaveLength(
      MAX_LOGGED_VALUE_LENGTH
    )
  })
})
