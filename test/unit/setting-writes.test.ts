import { DEFAULT_CONFIG } from '@proxy/config/schema'
import { writeSetting } from '@proxy/config/setting-writes'
import { describe, expect, test } from 'vite-plus/test'

const FILE = { ...DEFAULT_CONFIG }
const AUTH_OFF = { authOn: false, confirmed: false }

describe('writeSetting', () => {
  // Catches a value written that the file's own schema would refuse on the next load, or a valid
  // one refused: each kind of setting, at and past its bounds.
  test.each([
    { key: 'port', value: 9090, ok: true },
    { key: 'port', value: 0, ok: false },
    { key: 'port', value: 1.5, ok: false },
    { key: 'maxBodySizeMb', value: 501, ok: false },
    { key: 'upstreamTimeoutSec', value: 5, ok: true },
    { key: 'logLevel', value: 'debug', ok: true },
    { key: 'logLevel', value: 'loud', ok: false },
    { key: 'stats', value: false, ok: true },
    { key: 'stats', value: 'off', ok: false },
    { key: 'modelExposureMode', value: 'custom', ok: true },
    { key: 'modelExposureMode', value: 'some', ok: false },
    { key: 'customModels', value: ['anthropic/claude-opus-5-5'], ok: true },
    { key: 'reserve', value: { anthropic: 0.2 }, ok: true },
    { key: 'reserve', value: { anthropic: 1.2 }, ok: false },
    { key: 'loginFallbackOn', value: ['rate_limit', 'auth'], ok: true },
    { key: 'loginFallbackOn', value: ['sometimes'], ok: false },
    { key: 'providerPrefixes', value: { openai: 'oai' }, ok: true }
  ] as const)('$key = $value is ok: $ok', ({ key, value, ok }) => {
    expect(writeSetting(FILE, key, value, AUTH_OFF).ok).toBe(ok)
  })

  // Catches a setting written somewhere else in the file than it is read from.
  test('writes each setting where the file keeps it', () => {
    const reserve = writeSetting(FILE, 'reserve', { anthropic: 0.2 }, AUTH_OFF)
    const fallback = writeSetting(FILE, 'loginFallbackOn', ['auth'], AUTH_OFF)

    expect(reserve.ok && reserve.file.routing.reserve).toEqual({ anthropic: 0.2 })
    expect(fallback.ok && fallback.file.routing.logins.fallbackOn).toEqual(['auth'])
    expect(fallback.ok && fallback.file.routing.logins.order).toEqual(FILE.routing.logins.order)
  })

  // Catches the proxy opened to the network with no token and no warning: beyond loopback with
  // auth off needs a confirmation; loopback, a token, or the confirmation itself don't.
  test.each([
    { host: '0.0.0.0', context: AUTH_OFF, result: { ok: false, code: 'confirm' } },
    { host: '0.0.0.0', context: { authOn: false, confirmed: true }, result: { ok: true } },
    { host: '0.0.0.0', context: { authOn: true, confirmed: false }, result: { ok: true } },
    { host: '127.0.0.1', context: AUTH_OFF, result: { ok: true } },
    { host: '', context: AUTH_OFF, result: { ok: false, code: 'invalid' } }
  ])('host $host with $context', ({ host, context, result }) => {
    expect(writeSetting(FILE, 'host', host, context)).toMatchObject(result)
  })
})
