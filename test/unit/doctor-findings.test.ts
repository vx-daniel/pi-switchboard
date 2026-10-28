import { isLoopbackHost } from '@proxy/config/schema'
import {
  type CacheInputs,
  cacheFindings,
  type CatalogModel,
  doctorExitCode,
  doctorReport,
  type Finding,
  type GeneralInputs,
  generalFindings,
  LIMITS,
  retentionBreakEven
} from '@proxy/doctor/findings'
import type { ModelStats } from '@proxy/stats/store'
import { describe, expect, test } from 'vite-plus/test'

/** The model the cache tests judge. */
const MODEL = 'anthropic/claude-test'

/** Claude's prices per million tokens: cache reads at 0.1× the input price. */
const CLAUDE: CatalogModel = {
  api: 'anthropic-messages',
  baseUrl: 'https://api.anthropic.com',
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }
}

/**
 * Builds a model's numbers that raise no finding (20 calls, every prompt token read from the
 * cache, every request keyed), with the given fields.
 *
 * @param fields - the numbers to set
 * @returns the numbers
 */
function modelStats(fields: Partial<ModelStats> = {}): ModelStats {
  return {
    model: MODEL,
    requests: 20,
    promptCacheKeyRequests: 20,
    failed: 0,
    left: 0,
    averageMs: undefined,
    slowestMs: 0,
    averageFirstEventMs: undefined,
    attempts: 20,
    fallbacks: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 1000,
    cacheWriteTokens: 0,
    coldCacheWriteTokens: 0,
    costUsd: 0,
    ...fields
  }
}

/** A too-few-calls recommendation, as a caller gives it. */
const WIDEN = 'Widen the window.'

/**
 * Judges one model's numbers.
 *
 * @param stats - the numbers to set on a model with no finding
 * @param options - its catalog entry and the retention setting
 * @param options.model - its catalog entry; Claude's by default
 * @param options.retentionLong - whether `PI_CACHE_RETENTION=long` is set
 * @returns the cache section's checks that fired
 */
function cacheChecks(
  stats: Partial<ModelStats>,
  options: { model?: CatalogModel; retentionLong?: boolean } = {}
): string[] {
  const inputs: CacheInputs = {
    stats: { kind: 'read', models: [modelStats(stats)] },
    catalog: new Map([[MODEL, options.model ?? CLAUDE]]),
    retentionLong: options.retentionLong === true,
    howToWiden: WIDEN
  }
  return cacheFindings(inputs).map((found) => found.check)
}

/**
 * Builds the general inputs of a healthy loopback proxy, with the given fields.
 *
 * @param fields - the inputs to set
 * @returns the inputs
 */
function generalInputs(fields: Partial<GeneralInputs> = {}): GeneralInputs {
  return {
    models: {
      availableModelCount: 2,
      exposedModelCount: 2,
      exposureError: null,
      scopeDiagnostics: [],
      aliasDiagnostics: [],
      loginDiagnostics: [],
      modelsJsonError: null
    },
    credentials: {
      verified: true,
      loginsRegistered: true,
      providers: [{ provider: 'alpha', verified: true }]
    },
    server: { host: '127.0.0.1', proxyAuth: false, docsUi: false, stats: true },
    configFileProblem: undefined,
    fallback: { aliases: [], logins: ['rate_limit'] },
    fallbacksByAlias: new Map(),
    ...fields
  }
}

/**
 * Judges the general inputs.
 *
 * @param fields - the inputs to set on a healthy proxy
 * @returns the findings
 */
function general(fields: Partial<GeneralInputs> = {}): Finding[] {
  return generalFindings(generalInputs(fields), isLoopbackHost)
}

describe('the doctor general section', () => {
  // Catches the doctor disagreeing with /healthz/models: an invalid exposure config or no exposed
  // model must be an error (exit 1), as the route answers 503.
  test('reports an invalid exposure config, or no exposed model, as an error', () => {
    const invalid = general({
      models: { ...generalInputs().models, exposedModelCount: 0, exposureError: 'bad pattern' }
    })
    const none = general({ models: { ...generalInputs().models, exposedModelCount: 0 } })

    expect(invalid).toEqual([expect.objectContaining({ check: 'exposure', severity: 'error' })])
    expect(none).toEqual([expect.objectContaining({ check: 'exposure', severity: 'error' })])
  })

  // Catches alias diagnostics judged unlike /healthz/models: a misconfigured alias fails the
  // check there, a target that is not exposed does not.
  test('makes a misconfigured alias an error, and a target not exposed a warning', () => {
    const findings = general({
      models: {
        ...generalInputs().models,
        aliasDiagnostics: [
          { code: 'shadows-model', alias: 'alpha/one', target: 'alpha/two', message: 'named like' },
          { code: 'target-not-exposed', alias: 'fast', target: 'beta/x', message: 'hidden' }
        ]
      }
    })

    expect(findings).toEqual([
      expect.objectContaining({ check: 'alias', severity: 'error', subject: 'alpha/one' }),
      expect.objectContaining({ check: 'alias', severity: 'warning', subject: 'fast' })
    ])
  })

  // Catches the login settings (#233) left out of the doctor, or judged unlike /healthz/models:
  // an unknown name and an all-disabled provider are warnings there, never a failure, and the
  // latter is why a provider's models are missing.
  test('warns about an unknown login name and a provider with every login disabled', () => {
    const findings = general({
      models: {
        ...generalInputs().models,
        loginDiagnostics: [
          {
            code: 'unknown-login',
            setting: 'routing.logins.order',
            provider: 'alpha',
            login: 'alpha-9',
            message: 'no such login'
          },
          {
            code: 'all-logins-disabled',
            setting: 'routing.logins.disabled',
            provider: 'beta',
            login: null,
            message: 'every login disabled'
          }
        ]
      }
    })

    expect(findings).toEqual([
      expect.objectContaining({ check: 'login-routing', severity: 'warning', subject: 'alpha-9' }),
      expect.objectContaining({
        check: 'login-routing',
        severity: 'warning',
        subject: 'beta',
        recommendation: expect.stringContaining('Enable one of its logins')
      })
    ])
  })

  // Catches the credential check disagreeing with /healthz/creds: no login, or one that failed
  // to verify, is an error; without --verify a present login is reported, never resolved.
  test('reports no login and a failed verification as errors, and asks for --verify', () => {
    const noLogin = general({
      credentials: { verified: false, loginsRegistered: true, providers: [] }
    })
    const failed = general({
      credentials: {
        verified: true,
        loginsRegistered: true,
        providers: [{ provider: 'alpha', verified: false, error: 'token expired' }]
      }
    })
    const unverified = general({
      credentials: { verified: false, loginsRegistered: true, providers: [{ provider: 'alpha' }] }
    })

    expect(noLogin).toEqual([expect.objectContaining({ check: 'credentials', severity: 'error' })])
    expect(failed).toEqual([
      expect.objectContaining({ check: 'credentials', severity: 'error', subject: 'alpha' })
    ])
    expect(unverified).toEqual([
      expect.objectContaining({
        check: 'credentials',
        severity: 'advice',
        recommendation: expect.stringContaining('--verify')
      })
    ])
  })

  // Catches the exposure checks firing on loopback, where only this machine reaches the proxy,
  // or missing auth off and the docs page on an address other machines reach.
  test('warns about auth off and the docs page only off loopback', () => {
    const exposed = { host: '0.0.0.0', proxyAuth: false, docsUi: true, stats: true }

    expect(general({ server: { ...exposed, host: '127.0.0.1' } })).toEqual([])
    expect(general({ server: exposed }).map((found) => [found.check, found.severity])).toEqual([
      ['proxy-auth', 'warning'],
      ['docs-ui', 'warning']
    ])
    expect(general({ server: { ...exposed, proxyAuth: true, docsUi: false } })).toEqual([])
  })

  // Catches proxy auth that stops the proxy from starting reported as anything but an error, or
  // stats off going unmentioned (the cache section then has nothing to read).
  test('reports unusable proxy auth as an error and stats off as advice', () => {
    expect(general({ server: { unusableAuth: 'empty-override' } })).toEqual([
      expect.objectContaining({ check: 'proxy-auth', severity: 'error' })
    ])
    expect(
      general({ server: { host: '127.0.0.1', proxyAuth: false, docsUi: false, stats: false } })
    ).toEqual([expect.objectContaining({ check: 'stats', severity: 'advice' })])
  })

  // Catches a broad fallbackOn going unreported, the default rate_limit flagged, an alias's
  // fallback count missing, or every alias's fallbacks passed off as login moves, which the stats
  // can't tell apart.
  test('advises on a fallbackOn with broad classes, with an alias its fallbacks', () => {
    const findings = general({
      fallback: {
        aliases: [
          { alias: 'coding', fallbackOn: ['rate_limit', 'upstream_error'] },
          { alias: 'quiet', fallbackOn: ['rate_limit'] }
        ],
        logins: ['rate_limit', 'timeout']
      },
      fallbacksByAlias: new Map([
        ['coding', 7],
        ['', 2]
      ])
    })

    expect(findings).toEqual([
      expect.objectContaining({
        check: 'fallback-on',
        subject: 'coding',
        message: expect.stringContaining('7 fallbacks')
      }),
      expect.objectContaining({
        check: 'fallback-on',
        subject: 'routing.logins',
        message: expect.not.stringMatching(/\d+ fallbacks/)
      })
    ])
  })
})

describe('the doctor cache section', () => {
  // Catches a model judged on too few calls (noise), or one with enough calls skipped.
  test('judges a model from 20 calls, not 19', () => {
    const lowHits = { inputTokens: 1000, cacheReadTokens: 0 }

    expect(cacheChecks({ ...lowHits, attempts: 19 })).toEqual(['window'])
    expect(cacheChecks({ ...lowHits, attempts: 20 })).toEqual(['hit-rate'])
  })

  // Catches the hit-rate threshold off by a boundary: 50% is not low, 49.9% is.
  test('reports a hit rate under 50%, not at it', () => {
    expect(cacheChecks({ inputTokens: 500, cacheReadTokens: 500 })).toEqual([])
    expect(cacheChecks({ inputTokens: 501, cacheReadTokens: 499 })).toEqual(['hit-rate'])
  })

  // Catches the write-cost threshold off by a boundary: writes at 40% of the cost are not a
  // finding, over 40% are. Prices of 1 make tokens the cost.
  test('reports cache writes over 40% of the cost, at catalog prices', () => {
    const flat: CatalogModel = {
      api: 'openai-completions',
      baseUrl: 'https://example.test/v1',
      cost: { input: 1, output: 0, cacheRead: 1, cacheWrite: 1 }
    }
    const at40 = { inputTokens: 0, cacheReadTokens: 600, cacheWriteTokens: 400 }
    const over40 = { inputTokens: 0, cacheReadTokens: 599, cacheWriteTokens: 401 }

    expect(cacheChecks(at40, { model: flat })).toEqual([])
    expect(cacheChecks(over40, { model: flat })).toEqual(['cache-write-cost'])
  })

  // Catches the break-even formula wrong: docs/caching.md gives 38.5% at a 0.05× cache-read price
  // and 39.5% at 0.1×.
  test('works out the retention break-even from the prices', () => {
    expect(retentionBreakEven({ input: 1, output: 0, cacheRead: 0.05, cacheWrite: 0 })).toBeCloseTo(
      0.3846,
      4
    )
    expect(retentionBreakEven(CLAUDE.cost)).toBeCloseTo(0.3947, 4)
    expect(retentionBreakEven({ ...CLAUDE.cost, input: 0 })).toBeUndefined()
  })

  // Catches the retention advice pointing the wrong way: over the break-even with retention
  // short recommends long, under it with long set recommends removing it; otherwise nothing.
  test('recommends long retention over the break-even, and removing it under', () => {
    // Writes as a small share of the cost, so only the retention check can fire.
    const writes = { cacheReadTokens: 100_000, cacheWriteTokens: 1000 }
    const over = { ...writes, coldCacheWriteTokens: 400 }
    const under = { ...writes, coldCacheWriteTokens: 390 }

    expect(cacheChecks(over)).toEqual(['retention'])
    expect(cacheChecks(under)).toEqual([])
    expect(cacheChecks(under, { retentionLong: true })).toEqual(['retention'])
    expect(cacheChecks(over, { retentionLong: true })).toEqual([])
    const [advice] = cacheFindings({
      stats: { kind: 'read', models: [modelStats(under)] },
      catalog: new Map([[MODEL, CLAUDE]]),
      retentionLong: true,
      howToWiden: WIDEN
    })
    expect(advice?.recommendation).toMatch(/^Remove PI_CACHE_RETENTION=long/)
  })

  // Catches retention advice on an API where PI_CACHE_RETENTION=long costs nothing more per
  // write (it is a trade only on Anthropic and Bedrock).
  test('gives no retention advice off Anthropic and Bedrock', () => {
    const openai: CatalogModel = { ...CLAUDE, api: 'openai-completions' }
    const writes = { cacheReadTokens: 100_000, cacheWriteTokens: 1000, coldCacheWriteTokens: 900 }

    expect(cacheChecks(writes, { model: openai })).toEqual([])
  })

  // Catches the keyless share reported on an API that does not cache by key, or missed on one
  // that does: OpenAI only at api.openai.com, Codex and Mistral anywhere.
  test('reports requests without prompt_cache_key on APIs that cache by key', () => {
    const keyless = { promptCacheKeyRequests: 89, requests: 100 }
    const model = (api: string, baseUrl: string): CatalogModel => ({ ...CLAUDE, api, baseUrl })

    expect(
      cacheChecks(keyless, { model: model('openai-responses', 'https://api.openai.com/v1') })
    ).toEqual(['prompt-cache-key'])
    expect(
      cacheChecks(keyless, { model: model('openai-completions', 'https://example.test/v1') })
    ).toEqual([])
    expect(
      cacheChecks(keyless, {
        model: model('openai-codex-responses', 'https://chatgpt.com/backend-api')
      })
    ).toEqual(['prompt-cache-key'])
    expect(
      cacheChecks(
        { promptCacheKeyRequests: 90, requests: 100 },
        { model: model('mistral-conversations', 'https://api.mistral.ai') }
      )
    ).toEqual([])
  })

  // Catches fallbacks under 5% of a model's calls reported, or more missed.
  test('reports fallbacks over 5% of the calls', () => {
    expect(cacheChecks({ attempts: 100, fallbacks: 5 })).toEqual([])
    expect(cacheChecks({ attempts: 100, fallbacks: 6 })).toEqual(['fallbacks'])
  })

  // Catches stats that are off, absent or unreadable shown as an empty cache section, which reads
  // as "nothing wrong".
  test.each([
    { state: { kind: 'off' as const }, severity: 'advice' },
    { state: { kind: 'missing' as const, path: '/agent/stats.sqlite' }, severity: 'advice' },
    { state: { kind: 'unreadable' as const, reason: 'schema version 9' }, severity: 'warning' }
  ])('says so when the stats are $state.kind', ({ state, severity }) => {
    const report = doctorReport(
      generalInputs(),
      { stats: state, catalog: new Map(), retentionLong: false, howToWiden: WIDEN },
      { window: 'week', isLoopback: isLoopbackHost }
    )

    expect(report.statsAvailable).toBe(false)
    expect(report.cache).toEqual([expect.objectContaining({ check: 'stats', severity })])
  })
})

describe('the doctor report', () => {
  // Catches the documented --json shape changing: scripts read these keys, and a finding without
  // a subject must leave the key out rather than send null.
  test('has the documented shape', () => {
    const report = doctorReport(
      generalInputs({ credentials: { verified: false, loginsRegistered: true, providers: [] } }),
      {
        stats: { kind: 'read', models: [modelStats({ inputTokens: 1000, cacheReadTokens: 0 })] },
        catalog: new Map([[MODEL, CLAUDE]]),
        retentionLong: false,
        howToWiden: WIDEN
      },
      { window: 'today', isLoopback: isLoopbackHost }
    )

    expect(JSON.parse(JSON.stringify(report))).toEqual({
      general: [
        {
          check: 'credentials',
          severity: 'error',
          message: expect.any(String),
          recommendation: expect.any(String)
        }
      ],
      cache: [
        {
          check: 'hit-rate',
          severity: 'warning',
          subject: MODEL,
          message: expect.any(String),
          recommendation: expect.any(String)
        }
      ],
      window: 'today',
      statsAvailable: true,
      limits: [...LIMITS]
    })
  })

  // Catches the exit status failing on cache findings or warnings (it fails only on a general
  // error, as /healthz/models answers 503), or passing with one.
  test('exits 1 only for a general error', () => {
    const error: Finding = { check: 'exposure', severity: 'error', message: '', recommendation: '' }
    const warning: Finding = { ...error, severity: 'warning' }

    expect(doctorExitCode({ general: [error, warning] })).toBe(1)
    expect(doctorExitCode({ general: [warning] })).toBe(0)
    expect(
      doctorExitCode(
        doctorReport(
          generalInputs(),
          {
            stats: {
              kind: 'read',
              models: [modelStats({ inputTokens: 1000, cacheReadTokens: 0 })]
            },
            catalog: new Map(),
            retentionLong: false,
            howToWiden: WIDEN
          },
          { window: 'week', isLoopback: isLoopbackHost }
        )
      )
    ).toBe(0)
  })
})
