/**
 * Unit tests for config/schema.ts: normalization and the config file's path.
 *
 * Checks that normalizeConfig repairs rather than refuses: missing fields take their defaults,
 * values of the wrong type fall back, numbers are rounded and clamped, list and map entries are
 * filtered, and each set of repaired fields is warned about once, by path. And that the config
 * file lives in pi's agent dir, whatever HOME holds.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import { resetSync } from '@logtape/logtape'
import { DEFAULT_CONFIG, getConfigPath, normalizeConfig } from '@proxy/config/schema'
import { configureLogging } from '@proxy/logging'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

describe('normalizeConfig', () => {
  // Catches `null` (the one non-object input with `typeof === 'object'`) slipping past the object
  // check and crashing or yielding a partial config instead of the full defaults. This is about the
  // fallback, not the default values themselves.
  test('returns defaults for null input', () => {
    expect(normalizeConfig(null)).toEqual(DEFAULT_CONFIG)
  })

  test('returns defaults for undefined input', () => {
    const result = normalizeConfig(undefined)
    expect(result).toEqual(DEFAULT_CONFIG)
  })

  test('returns defaults for non-object input', () => {
    expect(normalizeConfig('string')).toEqual(DEFAULT_CONFIG)
    expect(normalizeConfig(42)).toEqual(DEFAULT_CONFIG)
    expect(normalizeConfig(true)).toEqual(DEFAULT_CONFIG)
    expect(normalizeConfig([])).toEqual(DEFAULT_CONFIG)
  })

  test('returns defaults for empty object', () => {
    const result = normalizeConfig({})
    expect(result).toEqual(DEFAULT_CONFIG)
  })

  test('preserves valid host', () => {
    const result = normalizeConfig({ host: '0.0.0.0' })
    expect(result.host).toBe('0.0.0.0')
  })

  test('falls back to default for non-string host', () => {
    const result = normalizeConfig({ host: 123 })
    expect(result.host).toBe(DEFAULT_CONFIG.host)
  })

  test('preserves valid port', () => {
    const result = normalizeConfig({ port: 8080 })
    expect(result.port).toBe(8080)
  })

  test('falls back to default for non-number port', () => {
    const result = normalizeConfig({ port: 'not-a-number' })
    expect(result.port).toBe(DEFAULT_CONFIG.port)
  })

  test('clamps negative port to minimum (1)', () => {
    const result = normalizeConfig({ port: -1 })
    expect(result.port).toBe(1)
  })

  test('clamps excessive port to maximum (65535)', () => {
    const result = normalizeConfig({ port: 99999 })
    expect(result.port).toBe(65535)
  })

  test('preserves valid lifetime values', () => {
    expect(normalizeConfig({ lifetime: 'detached' }).lifetime).toBe('detached')
    expect(normalizeConfig({ lifetime: 'session' }).lifetime).toBe('session')
  })

  test('falls back to default for invalid lifetime', () => {
    const result = normalizeConfig({ lifetime: 'unknown' })
    expect(result.lifetime).toBe(DEFAULT_CONFIG.lifetime)
  })

  test('preserves valid authToken', () => {
    const result = normalizeConfig({ authToken: 'my-secret' })
    expect(result.authToken).toBe('my-secret')
  })

  test('falls back to empty string for non-string authToken', () => {
    const result = normalizeConfig({ authToken: 123 })
    expect(result.authToken).toBe('')
  })

  test('preserves valid remoteImages boolean', () => {
    expect(normalizeConfig({ remoteImages: true }).remoteImages).toBe(true)
    expect(normalizeConfig({ remoteImages: false }).remoteImages).toBe(false)
  })

  test('falls back to default for non-boolean remoteImages', () => {
    const result = normalizeConfig({ remoteImages: 'yes' })
    expect(result.remoteImages).toBe(DEFAULT_CONFIG.remoteImages)
  })

  // --- Model exposure fields ---

  test('preserves valid publicModelIdMode', () => {
    expect(normalizeConfig({ publicModelIdMode: 'collision-prefixed' }).publicModelIdMode).toBe(
      'collision-prefixed'
    )
    expect(normalizeConfig({ publicModelIdMode: 'universal' }).publicModelIdMode).toBe('universal')
    expect(normalizeConfig({ publicModelIdMode: 'always-prefixed' }).publicModelIdMode).toBe(
      'always-prefixed'
    )
  })

  test('falls back to default for invalid publicModelIdMode', () => {
    const result = normalizeConfig({ publicModelIdMode: 'invalid' })
    expect(result.publicModelIdMode).toBe(DEFAULT_CONFIG.publicModelIdMode)
  })

  test('preserves valid modelExposureMode', () => {
    expect(normalizeConfig({ modelExposureMode: 'all' }).modelExposureMode).toBe('all')
    expect(normalizeConfig({ modelExposureMode: 'scoped' }).modelExposureMode).toBe('scoped')
    expect(normalizeConfig({ modelExposureMode: 'custom' }).modelExposureMode).toBe('custom')
  })

  test('falls back to default for invalid modelExposureMode', () => {
    const result = normalizeConfig({ modelExposureMode: 'invalid' })
    expect(result.modelExposureMode).toBe(DEFAULT_CONFIG.modelExposureMode)
  })

  test('normalizes customModels from array', () => {
    const result = normalizeConfig({ customModels: ['openai/gpt-4o', 'anthropic/claude'] })
    expect(result.customModels).toEqual(['openai/gpt-4o', 'anthropic/claude'])
  })

  test('normalizes providerPrefixes from record', () => {
    const result = normalizeConfig({ providerPrefixes: { openai: 'oai', anthropic: 'ant' } })
    expect(result.providerPrefixes).toEqual({ openai: 'oai', anthropic: 'ant' })
  })

  test('filters non-string values from providerPrefixes', () => {
    const result = normalizeConfig({ providerPrefixes: { openai: 'oai', bad: 123, also: null } })
    expect(result.providerPrefixes).toEqual({ openai: 'oai' })
  })

  test('returns empty record for non-object providerPrefixes', () => {
    expect(normalizeConfig({ providerPrefixes: 'not-object' }).providerPrefixes).toEqual({})
  })

  // Catches one bad alias costing the others (a map keeps its valid entries), an empty name or
  // target kept, or a name or target trimmed: exposure follows the config as written (#66).
  test('keeps the valid aliases, verbatim', () => {
    const result = normalizeConfig({
      aliases: {
        'coding': 'anthropic/opus',
        ' padded ': 'openai/gpt ',
        '': 'openai/gpt',
        'empty': '',
        'number': 5
      }
    })

    expect(result.aliases).toEqual({ 'coding': 'anthropic/opus', ' padded ': 'openai/gpt ' })
  })

  // Catches a fallback chain kept with a failure class nobody defined, no fallbackOn at all, or
  // no targets: each would fall back on what the configuration doesn't name (principle VI). The
  // valid chain beside them is kept as written (#67).
  test('keeps a valid fallback chain and drops the invalid ones', () => {
    const chain = {
      targets: ['anthropic/opus', 'openai/gpt'],
      fallbackOn: ['rate_limit', 'timeout']
    }
    const result = normalizeConfig({
      aliases: {
        chain,
        'typo-class': { targets: ['anthropic/opus'], fallbackOn: ['rate-limit'] },
        'no-classes': { targets: ['anthropic/opus', 'openai/gpt'] },
        'no-targets': { targets: [], fallbackOn: ['timeout'] },
        'plain-list': ['anthropic/opus', 'openai/gpt']
      }
    })

    expect(result.aliases).toEqual({ chain })
  })

  // Catches one bad reserve costing the others, or a share outside 0–1 kept: a reserve above 1
  // would skip a provider whenever it reports quota, and a negative one never would (#69).
  test('keeps the valid quota reserves and drops the invalid ones', () => {
    const result = normalizeConfig({
      routing: {
        reserve: {
          'anthropic': 0.2,
          'openai-codex': 0,
          'google': 1.5,
          'xai': -0.1,
          'mistral': '0.3',
          '': 0.5
        }
      }
    })

    expect(result.routing.reserve).toEqual({ 'anthropic': 0.2, 'openai-codex': 0 })
    expect(normalizeConfig({}).routing).toEqual({
      reserve: {},
      logins: { fallbackOn: ['rate_limit'] }
    })
  })

  // Catches an invalid class list kept (a typo would turn login fallback off silently) or the
  // default lost when the section is left out: the default is the reason to log in twice (#227).
  test('repairs routing.logins.fallbackOn to its default and keeps a valid list', () => {
    expect(
      normalizeConfig({ routing: { logins: { fallbackOn: ['rate-limit'] } } }).routing.logins
    ).toEqual({ fallbackOn: ['rate_limit'] })
    expect(normalizeConfig({ routing: { logins: { fallbackOn: [] } } }).routing.logins).toEqual({
      fallbackOn: []
    })
    expect(
      normalizeConfig({ routing: { logins: { fallbackOn: ['auth', 'unavailable'] } } }).routing
        .logins
    ).toEqual({ fallbackOn: ['auth', 'unavailable'] })
  })

  // Catches one bad label costing the others, an empty or padded label kept (the console shows it
  // beside the login), or a label that is not text.
  test('keeps the valid login labels, trimmed, and drops the invalid ones', () => {
    const result = normalizeConfig({
      labels: {
        'anthropic-2': '  work  ',
        'openai-codex': 'personal',
        'google': '',
        'xai': '   ',
        'groq': 7,
        'mistral': 'x'.repeat(41),
        '': 'nobody'
      }
    })

    expect(result.labels).toEqual({ 'anthropic-2': 'work', 'openai-codex': 'personal' })
    expect(normalizeConfig({}).labels).toEqual({})
  })

  // Catches a valid field being dropped or replaced by its default during normalization.
  test('preserves all fields from a complete valid config', () => {
    const full = {
      host: '0.0.0.0',
      port: 9090,
      lifetime: 'session',
      authToken: 'tok',
      remoteImages: true,
      docsUi: true,
      stats: false,
      maxBodySizeMb: 100,
      upstreamTimeoutSec: 300,
      publicModelIdMode: 'always-prefixed',
      modelExposureMode: 'custom',
      customModels: ['openai/gpt-4o'],
      providerPrefixes: { openai: 'oai' },
      aliases: { coding: 'openai/gpt-4o' },
      labels: { 'anthropic-2': 'work' },
      logLevel: 'debug',
      routing: { reserve: { anthropic: 0.2 }, logins: { fallbackOn: ['rate_limit', 'auth'] } },
      zed: { providerName: 'My Proxy', autoSync: true }
    }
    expect(normalizeConfig(full)).toEqual(full)
  })

  test('normalizes zed config with defaults when missing', () => {
    const result = normalizeConfig({})
    expect(result.zed.providerName).toBe('Pi Proxy')
    expect(result.zed.autoSync).toBe(false)
  })

  test('normalizes zed config from valid input', () => {
    const result = normalizeConfig({
      zed: { providerName: 'My Proxy', autoSync: true }
    })
    expect(result.zed.providerName).toBe('My Proxy')
    expect(result.zed.autoSync).toBe(true)
  })

  test('normalizes zed config with invalid types to defaults', () => {
    const result = normalizeConfig({
      zed: { providerName: 42, autoSync: 'yes' }
    })
    expect(result.zed.providerName).toBe('Pi Proxy')
    expect(result.zed.autoSync).toBe(false)
  })

  test('trims whitespace from zed providerName', () => {
    const result = normalizeConfig({
      zed: { providerName: '  My Proxy  ' }
    })
    expect(result.zed.providerName).toBe('My Proxy')
  })

  test('falls back to default when zed providerName is empty after trim', () => {
    const result = normalizeConfig({
      zed: { providerName: '   ' }
    })
    expect(result.zed.providerName).toBe('Pi Proxy')
  })

  test('preserves zed config through full roundtrip', () => {
    const full = {
      host: '0.0.0.0',
      port: 9090,
      lifetime: 'session',
      authToken: 'tok',
      remoteImages: true,
      maxBodySizeMb: 100,
      upstreamTimeoutSec: 300,
      publicModelIdMode: 'always-prefixed',
      modelExposureMode: 'custom',
      customModels: ['openai/gpt-4o'],
      providerPrefixes: { openai: 'oai' },
      zed: { providerName: 'Custom Name', autoSync: true }
    }
    const result = normalizeConfig(full)
    expect(result.zed.providerName).toBe('Custom Name')
    expect(result.zed.autoSync).toBe(true)
  })
})

describe('normalizeConfig: numeric limits', () => {
  // Catches a clamp dropped or loosened: a timeout of 1 s would cut off every call that thinks
  // before answering, and an unbounded one would never abort a stalled call (#15); a body limit of
  // 0 refuses every request, and an unbounded one accepts any payload into memory. A value that is
  // not a finite number falls back to the default rather than to a bound.
  test.each([
    ['upstreamTimeoutSec', 1, 5],
    ['upstreamTimeoutSec', 9999, 600],
    ['upstreamTimeoutSec', 299.6, 300],
    ['upstreamTimeoutSec', '300', 120],
    ['upstreamTimeoutSec', Number.NaN, 120],
    ['maxBodySizeMb', 0, 1],
    ['maxBodySizeMb', 100_000, 500],
    ['maxBodySizeMb', '100', 50],
    ['maxBodySizeMb', Number.POSITIVE_INFINITY, 50]
  ] as const)('%s = %s becomes %s', (field, value, expected) => {
    expect(normalizeConfig({ [field]: value })[field]).toBe(expected)
  })
})

describe('normalizeConfig: repairs', () => {
  let lines: string[] = []

  afterEach(() => {
    resetSync()
    lines = []
  })

  /**
   * Starts capturing config warnings into `lines`, from a clean deduplication state.
   *
   * @remarks
   * The warning is deduplicated in module state, so this normalizes a valid config first:
   * otherwise an earlier test ending on the same invalid fields would swallow this one's warning.
   */
  function captureWarnings(): void {
    normalizeConfig({})
    configureLogging({ level: 'warning', format: 'json', write: (line) => lines.push(line) })
  }

  // Catches a typo being silently ignored, the warning leaking a value (one field is the auth
  // token), and the warning repeating: the exposure config is read from the file on every request.
  test('warns once per set of invalid fields, by path and never by value', () => {
    captureWarnings()
    const config = { port: 'x4141', authToken: 404_404, zed: { autoSync: 'yes' } }
    normalizeConfig(config)
    normalizeConfig(config)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('"fields":["port","authToken","zed.autoSync"]')
    expect(lines[0]).not.toContain('404404')
    expect(lines[0]).not.toContain('x4141')

    normalizeConfig({ port: 'x4141' })
    expect(lines).toHaveLength(2)
    normalizeConfig({})
    normalizeConfig({ port: 'x4141' })
    expect(lines).toHaveLength(3)
  })

  // Catches a shape error being repaired silently, and a rounded number going unreported: each is a
  // value the operator wrote that the proxy does not use as written.
  test.each([
    ['a config that is not an object', null, 'config'],
    ['a zed block that is not an object', { zed: null }, 'zed'],
    ['a fractional number', { port: 4141.5 }, 'port']
  ])('%s is reported by its path', (_case, raw, path) => {
    captureWarnings()
    normalizeConfig(raw)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(`"fields":["${path}"]`)
  })

  test('a fractional number is rounded, not reset', () => {
    expect(normalizeConfig({ port: 4141.5 }).port).toBe(4142)
  })

  // Catches one bad zed field resetting the whole block and discarding a valid provider name with
  // it.
  test('an invalid zed field keeps its valid sibling', () => {
    expect(normalizeConfig({ zed: { providerName: 'Work', autoSync: 'yes' } }).zed).toEqual({
      providerName: 'Work',
      autoSync: false
    })
  })

  // Catches exposure following anything but the config as written (constitution IV): a padded model
  // ID or prefix label must stay padded, so it matches nothing rather than exposing a model, and a
  // bad sibling entry must not change how a valid one comes out.
  test('model IDs and prefix labels are kept verbatim, with or without a bad sibling', () => {
    expect(normalizeConfig({ customModels: [' openai/gpt-4o ', 7, ''] }).customModels).toEqual([
      ' openai/gpt-4o '
    ])
    expect(normalizeConfig({ customModels: [' openai/gpt-4o '] }).customModels).toEqual([
      ' openai/gpt-4o '
    ])
    expect(
      normalizeConfig({ providerPrefixes: { openai: ' oai ', bad: 7 } }).providerPrefixes
    ).toEqual({ openai: ' oai ' })
  })

  // Catches a padded or blank host reaching the listener: padding is trimmed, blank is unset.
  test('host is trimmed, and a blank host takes the default', () => {
    expect(normalizeConfig({ host: ' 0.0.0.0 ' }).host).toBe('0.0.0.0')
    expect(normalizeConfig({ host: '   ' }).host).toBe(DEFAULT_CONFIG.host)
  })
})

describe('getConfigPath', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  // Catches the path built from HOME's text, which made a relative `./~/.pi/agent` with HOME unset
  // and the working directory with an empty PI_CODING_AGENT_DIR (#111): pi's own agent dir is
  // used, which falls back to the user's home directory and expands a leading `~`.
  test.each([
    { case: 'HOME unset', agentDir: undefined, under: ['.pi', 'agent'] },
    { case: 'PI_CODING_AGENT_DIR empty', agentDir: '', under: ['.pi', 'agent'] },
    { case: 'PI_CODING_AGENT_DIR with ~', agentDir: '~/custom-agent', under: ['custom-agent'] }
  ])('$case: in the home directory', ({ agentDir, under }) => {
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir)
    vi.stubEnv('HOME', undefined)

    expect(getConfigPath()).toBe(join(homedir(), ...under, 'proxy-config.json'))
  })
})
