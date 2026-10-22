/**
 * Usage and cost by route (#70), end to end: each attempt of a request's chain counts on its
 * alias × provider × model row, with the tokens and cost pi reports for it, and the upstream log
 * lines name the alias and attempt. The proxy runs as deployed (its config file read per request)
 * through pi's OpenAI chat completions adapter against the mock provider, which scripts each
 * model's usage; the models' prices make the cost.
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { resetSync } from '@logtape/logtape'
import type { AliasTarget } from '@proxy/config/schema'
import { configureLogging } from '@proxy/logging'
import { clearAllCooldowns } from '@proxy/pi/cooldowns'
import { createApp } from '@proxy/server/app'
import {
  clearRouteTotals,
  onRouteTotalsChange,
  type RouteTotals,
  routeTotals,
  routeTotalsSince
} from '@proxy/server/route-totals'
import { fileConfigReader } from '@proxy/server/routes'
import { isRecord } from '@proxy/utils/guards'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'
import {
  chunk,
  cutOff,
  httpError,
  type MockProvider,
  type MockReply,
  sse,
  startMockProvider,
  textChunks
} from '../fixtures/mock-provider'
import { testConfig } from '../helpers'

const MOCK_KEY = 'notarealsecret-mock-provider-key'
/** Prices per million tokens, the same for every model: input, output, cache read, cache write. */
const PRICES = { input: 1000, output: 2000, cacheRead: 100, cacheWrite: 500 }

/**
 * Builds a streamed answer whose closing chunk reports this usage, as OpenAI sends it.
 *
 * @param usage - prompt tokens (cached and written ones included, as OpenAI counts them),
 *   completion tokens, and the cached and cache-written prompt tokens
 * @param usage.prompt - all prompt tokens
 * @param usage.completion - completion tokens
 * @param usage.cached - prompt tokens read from the cache
 * @param usage.written - prompt tokens written to the cache
 * @returns the reply
 */
function answerWithUsage(usage: {
  prompt: number
  completion: number
  cached: number
  written: number
}): MockReply {
  return sse([
    ...textChunks('ok'),
    chunk({}, 'stop', {
      usage: {
        prompt_tokens: usage.prompt,
        completion_tokens: usage.completion,
        total_tokens: usage.prompt + usage.completion,
        prompt_tokens_details: { cached_tokens: usage.cached, cache_write_tokens: usage.written }
      }
    })
  ])
}

/** What `priced-mock` reports: 60 uncached input, 20 output, 30 cache-read, 10 cache-write. */
const PRICED_USAGE = { prompt: 100, completion: 20, cached: 30, written: 10 }
/** What `answer-mock` reports: 7 uncached input, 5 output, 3 cache-read, none written. */
const ANSWER_USAGE = { prompt: 10, completion: 5, cached: 3, written: 0 }

/**
 * The tokens and cost a usage adds to a route, at {@link PRICES}.
 *
 * @param usage - the scripted usage
 * @param usage.prompt - all prompt tokens
 * @param usage.completion - completion tokens
 * @param usage.cached - prompt tokens read from the cache
 * @param usage.written - prompt tokens written to the cache
 * @param times - how many calls reported it
 * @returns the expected token and cost fields
 */
function expectedUsage(
  usage: { prompt: number; completion: number; cached: number; written: number },
  times: number
): Pick<
  RouteTotals,
  'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'costUsd'
> {
  const input = usage.prompt - usage.cached - usage.written
  const perMillion =
    input * PRICES.input +
    usage.completion * PRICES.output +
    usage.cached * PRICES.cacheRead +
    usage.written * PRICES.cacheWrite
  return {
    inputTokens: input * times,
    outputTokens: usage.completion * times,
    cacheReadTokens: usage.cached * times,
    cacheWriteTokens: usage.written * times,
    costUsd: expect.closeTo((perMillion / 1_000_000) * times, 12) as number
  }
}

/** A row with nothing counted yet, to spread the expected counts over. */
const EMPTY = {
  requests: 0,
  failures: 0,
  failuresByClass: {},
  fallbacks: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0
}

let mock: MockProvider
let agentDir: FixtureAgentDir
/** Every `pi.complete` log record a request causes, parsed. */
let upstreamRecords: Record<string, unknown>[] = []

beforeAll(async () => {
  mock = await startMockProvider({
    'limited-mock': httpError(429, {
      error: { message: 'Rate limit reached', type: 'rate_limit_error' }
    }),
    'invalid-mock': httpError(400, {
      error: { message: 'Unsupported value', type: 'invalid_request_error' }
    }),
    'cut-mock': cutOff('par'),
    'priced-mock': answerWithUsage(PRICED_USAGE),
    'answer-mock': answerWithUsage(ANSWER_USAGE)
  })
  const provider = (models: string[]): Record<string, unknown> => ({
    baseUrl: `${mock.origin}/v1`,
    api: 'openai-completions',
    apiKey: MOCK_KEY,
    models: models.map((modelId) => ({ id: modelId, cost: PRICES }))
  })
  agentDir = await loadFixtureAgentDir({
    modelsJson: {
      providers: {
        alpha: provider(['limited-mock', 'invalid-mock', 'cut-mock', 'priced-mock']),
        beta: provider(['answer-mock'])
      }
    }
  })
  setAliases({
    coding: { targets: ['alpha/limited-mock', 'beta/answer-mock'], fallbackOn: ['rate_limit'] },
    fast: 'alpha/priced-mock',
    broken: 'alpha/cut-mock'
  })
})

beforeEach(() => {
  clearAllCooldowns()
  clearRouteTotals()
  upstreamRecords = []
  configureLogging({
    level: 'debug',
    format: 'json',
    write: (line) => {
      const parsed: unknown = JSON.parse(line)
      if (isRecord(parsed) && parsed['logger'] === 'pi-switchboard.pi.complete') {
        upstreamRecords.push(parsed)
      }
    }
  })
})

afterAll(async () => {
  resetSync()
  vi.unstubAllEnvs()
  await mock.close()
  agentDir.remove()
})

/**
 * Writes the proxy's config file with these aliases.
 *
 * @param aliases - alias -> target
 */
function setAliases(aliases: Record<string, AliasTarget>): void {
  writeFileSync(join(agentDir.path, 'proxy-config.json'), JSON.stringify({ aliases }))
}

/**
 * Sends one chat request and reads the whole answer.
 *
 * @param model - the request's `model`
 * @param options - stream or not, extra headers, and extra body fields
 * @returns the response status
 */
async function ask(
  model: string,
  options: {
    stream?: boolean
    headers?: Record<string, string>
    body?: Record<string, unknown>
  } = {}
): Promise<number> {
  const response = await createApp(testConfig(), fileConfigReader).request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...options.headers },
    body: JSON.stringify({
      model,
      stream: options.stream === true,
      messages: [{ role: 'user', content: 'Say ok' }],
      ...options.body
    })
  })
  await response.text()
  return response.status
}

/**
 * Returns one route's row.
 *
 * @param alias - the alias, or `null`
 * @param model - the canonical model ID
 * @returns the row, or `undefined` when nothing was counted on it
 */
function row(alias: string | null, model: string): RouteTotals | undefined {
  return routeTotals().find((totals) => totals.alias === alias && totals.model === model)
}

/**
 * Returns the upstream result lines: how each upstream call ended.
 *
 * @returns the records whose message says the call finished, failed, aborted or threw
 */
function resultRecords(): Record<string, unknown>[] {
  return upstreamRecords.filter((record) => {
    const message = record['message']
    return (
      typeof message === 'string' &&
      /finished in|failed after|aborted after|threw after/.test(message)
    )
  })
}

describe('route totals', () => {
  // Catches the core of #70 going wrong: attempts, failures and fallbacks on the wrong route or
  // not at all, a cooldown skip counted as a request, or tokens and cost not matching what the
  // provider reported, after requests through two aliases, one of which falls back.
  test('count each alias × model: attempts, failures, fallbacks, tokens and cost', async () => {
    expect(await ask('coding')).toBe(200)
    // The 429 cooled limited-mock: this one skips it, which is not an attempt on it.
    expect(await ask('coding')).toBe(200)
    expect(await ask('fast')).toBe(200)

    expect(routeTotals()).toEqual([
      {
        ...EMPTY,
        alias: 'coding',
        provider: 'alpha',
        model: 'alpha/limited-mock',
        requests: 1,
        failures: 1,
        failuresByClass: { rate_limit: 1 },
        fallbacks: 1
      },
      {
        ...EMPTY,
        alias: 'coding',
        provider: 'beta',
        model: 'beta/answer-mock',
        requests: 2,
        ...expectedUsage(ANSWER_USAGE, 2)
      },
      {
        ...EMPTY,
        alias: 'fast',
        provider: 'alpha',
        model: 'alpha/priced-mock',
        requests: 1,
        ...expectedUsage(PRICED_USAGE, 1)
      }
    ])
  })

  // Catches a request that named a model directly folded into an alias's row, or dropped.
  test('count a request without an alias under its provider and model, with no alias', async () => {
    await ask('fast')
    await ask('priced-mock')

    expect(row(null, 'alpha/priced-mock')).toEqual({
      ...EMPTY,
      alias: null,
      provider: 'alpha',
      model: 'alpha/priced-mock',
      requests: 1,
      ...expectedUsage(PRICED_USAGE, 1)
    })
    expect(row('fast', 'alpha/priced-mock')?.requests).toBe(1)
  })

  // Catches a streamed answer's usage missed: it is known only once the stream ends, after the
  // response has started.
  test('count a streamed request with its usage', async () => {
    expect(await ask('fast', { stream: true })).toBe(200)

    await vi.waitFor(() => {
      expect(row('fast', 'alpha/priced-mock')).toMatchObject({
        requests: 1,
        failures: 0,
        ...expectedUsage(PRICED_USAGE, 1)
      })
    })
  })

  // Catches a stream that broke off after it started counted as a success: the client got an
  // error event, so the route failed although no other model was tried.
  test('count a stream that fails after it started as a failure', async () => {
    expect(await ask('broken', { stream: true })).toBe(200)

    await vi.waitFor(() => {
      expect(row('broken', 'alpha/cut-mock')).toMatchObject({
        requests: 1,
        failures: 1,
        fallbacks: 0
      })
    })
  })

  // Catches a failure with no class (a 400, the request's own fault) dropped from `failures`, or
  // given a class it doesn't have.
  test('count a 400 in failures but under no class', async () => {
    expect(await ask('invalid-mock')).toBe(400)

    expect(row(null, 'alpha/invalid-mock')).toMatchObject({
      requests: 1,
      failures: 1,
      failuresByClass: {},
      fallbacks: 0
    })
  })

  // Catches the totals holding what a client sent: message content, the request's `user`, or the
  // per-request upstream key, which still counts (it is usage through the route).
  test('hold no content, user or credential, and count a request with its own upstream key', async () => {
    const clientKey = 'notarealsecret-client-upstream-key'
    await ask('fast', {
      headers: { 'X-Switchboard-Upstream-Api-Key': clientKey },
      body: {
        user: 'person-7f3a@example.com',
        messages: [{ role: 'user', content: 'the secret plan is lemons' }]
      }
    })

    expect(row('fast', 'alpha/priced-mock')?.requests).toBe(1)
    const snapshot = JSON.stringify(routeTotals())
    for (const leaked of [clientKey, MOCK_KEY, 'person-7f3a', 'lemons']) {
      expect(snapshot).not.toContain(leaked)
    }
  })

  // Catches a subscriber (the console, #61) never told of an update, or told after it left.
  test('tell a listener of every update until it unsubscribes', async () => {
    const before = routeTotalsSince()
    const listener = vi.fn()
    const unsubscribe = onRouteTotalsChange(listener)
    try {
      await ask('fast')
      expect(listener).toHaveBeenCalled()
      const seen = listener.mock.calls.length
      unsubscribe()
      await ask('fast')
      expect(listener).toHaveBeenCalledTimes(seen)
    } finally {
      unsubscribe()
    }
    expect(routeTotalsSince()).toBeGreaterThanOrEqual(before)
  })

  // Catches a listener that throws failing the request that updated the totals: the console's
  // bug must not become the client's error.
  test('answer the request when a listener throws', async () => {
    const unsubscribe = onRouteTotalsChange(() => {
      throw new Error('listener bug')
    })
    try {
      expect(await ask('fast')).toBe(200)
    } finally {
      unsubscribe()
    }
    expect(row('fast', 'alpha/priced-mock')?.requests).toBe(1)
  })
})

describe('the upstream result line', () => {
  // Catches the result line missing its route (#70): without the alias and attempt, a log tool
  // cannot group calls by route or tell a fallback from a first try.
  test('names the alias and the attempt of each call along a chain', async () => {
    await ask('coding')

    expect(resultRecords().map((record) => record['properties'])).toEqual([
      expect.objectContaining({ modelId: 'limited-mock', alias: 'coding', attempt: 1 }),
      expect.objectContaining({ modelId: 'answer-mock', alias: 'coding', attempt: 2 })
    ])
  })

  // Catches a request that named a model logged with a stale or missing alias.
  test('names no alias for a request that named a model', async () => {
    await ask('priced-mock')

    expect(resultRecords().map((record) => record['properties'])).toEqual([
      expect.objectContaining({ modelId: 'priced-mock', alias: null, attempt: 1 })
    ])
  })
})
