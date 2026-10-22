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
import type { AliasTarget, FailureClass } from '@proxy/config/schema'
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
  silent,
  startMockProvider,
  textChunks
} from '../fixtures/mock-provider'
import { testConfig } from '../helpers'

const MOCK_KEY = 'notarealsecret-mock-provider-key'
/** Prices per million tokens, the same for every model: input, output, cache read, cache write. */
const PRICES = { input: 1000, output: 2000, cacheRead: 100, cacheWrite: 500 }
/** OpenAI's own API, the one host the proxy sends `prompt_cache_breakpoint` to (#163). */
const OPENAI_ORIGIN = 'https://api.openai.com'
/** Long enough for a request to reach the provider before the client leaves, in milliseconds. */
const LEAVE_AFTER_MS = 200

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
 * Answers as a ChatGPT model that refuses `prompt_cache_breakpoint` (#163): a 400 naming the
 * field when the request carries it, else an answer reporting {@link PRICED_USAGE}.
 *
 * @returns the reply
 */
function refusingBreakpoints(): MockReply {
  const refusal = httpError(400, {
    error: {
      message: 'prompt_cache_breakpoint is not supported on this model',
      type: 'invalid_request_error',
      param: 'prompt_cache_breakpoint',
      code: 'invalid_parameter'
    }
  })
  const answer = answerWithUsage(PRICED_USAGE)
  return (response, request) =>
    JSON.stringify(request.body).includes('prompt_cache_breakpoint')
      ? refusal(response, request)
      : answer(response, request)
}

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
    'silent-mock': silent(),
    'priced-mock': answerWithUsage(PRICED_USAGE),
    'answer-mock': answerWithUsage(ANSWER_USAGE),
    'refuses-plain': refusingBreakpoints(),
    'refuses-stream': refusingBreakpoints()
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
        alpha: provider(['limited-mock', 'invalid-mock', 'cut-mock', 'silent-mock', 'priced-mock']),
        beta: provider(['answer-mock']),
        // A key command that prints nothing (the command does not exist): pi resolves no
        // credential, so the proxy refuses the model before calling it.
        keyless: { ...provider(['locked-mock']), apiKey: '!notarealsecret-missing-command' },
        // Breakpoints are sent to OpenAI's own API only; `fetch` sends it to the mock below.
        openai: { ...provider(['refuses-plain', 'refuses-stream']), baseUrl: `${OPENAI_ORIGIN}/v1` }
      }
    }
  })
  const realFetch = globalThis.fetch
  vi.stubGlobal('fetch', (input: Request | URL | string, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    return realFetch(
      url.startsWith(OPENAI_ORIGIN) ? `${mock.origin}${url.slice(OPENAI_ORIGIN.length)}` : input,
      init
    )
  })
  setAliases({
    'coding': { targets: ['alpha/limited-mock', 'beta/answer-mock'], fallbackOn: ['rate_limit'] },
    'fast': 'alpha/priced-mock',
    'broken': 'alpha/cut-mock',
    'guarded': { targets: ['keyless/locked-mock', 'beta/answer-mock'], fallbackOn: ['auth'] },
    'guarded-later': {
      targets: ['alpha/limited-mock', 'keyless/locked-mock', 'beta/answer-mock'],
      fallbackOn: ['rate_limit', 'auth']
    }
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
  vi.unstubAllGlobals()
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
 * @param options - stream or not, extra headers, extra body fields, and a signal to leave early
 * @returns the response status
 */
async function ask(
  model: string,
  options: {
    stream?: boolean
    headers?: Record<string, string>
    body?: Record<string, unknown>
    signal?: AbortSignal
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
    }),
    ...(options.signal === undefined ? {} : { signal: options.signal })
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

  // Catches a stream that broke off after it started counted as a success, or counted twice: the
  // client got one error event, so the attempt failed once (by the `error` event, and not again
  // by the relay's `catch`), although no other model was tried.
  test('count a stream that fails after it started as one failure', async () => {
    expect(await ask('broken', { stream: true })).toBe(200)

    // The whole stream has been read, so the attempt has ended and every count is in.
    expect(row('broken', 'alpha/cut-mock')).toEqual({
      ...EMPTY,
      alias: 'broken',
      provider: 'alpha',
      model: 'alpha/cut-mock',
      requests: 1,
      failures: 1,
      failuresByClass: { upstream_error: 1 }
    })
  })

  // Catches a credential refusal left out of the totals: no call is made, but it is an attempt
  // that failed `auth` (`x_pi.attempts` lists it), whether it ends the request with a 401 or the
  // chain moves on, before the first call or between two.
  test.each([
    ['before the first call', 'guarded'],
    ['between two calls', 'guarded-later']
  ])(
    'count a credential refusal as an auth failure, and the fallback past it: %s',
    async (_when, alias) => {
      expect(await ask('locked-mock')).toBe(401)
      expect(await ask(alias)).toBe(200)

      const locked = { ...EMPTY, provider: 'keyless', model: 'keyless/locked-mock', requests: 1 }
      // The class's name is `auth` (FailureClassSchema); the naming rule reads a literal `auth`
      // key as an abbreviation, so the key is computed from a typed value.
      const credentialClass: FailureClass = 'auth'
      const failedAuth = { failures: 1, failuresByClass: { [credentialClass]: 1 } }
      expect(row(null, 'keyless/locked-mock')).toEqual({ ...locked, ...failedAuth, alias: null })
      expect(row(alias, 'keyless/locked-mock')).toEqual({
        ...locked,
        ...failedAuth,
        alias,
        fallbacks: 1
      })
      expect(row(alias, 'beta/answer-mock')).toMatchObject({ requests: 1, failures: 0 })
    }
  )

  // Catches a client that left counted as the route's failure: the call was abandoned, not
  // failed, though it was still an attempt.
  test.each([
    ['non-streamed', false],
    ['streamed', true]
  ])('count a request the client left as a request, not a failure: %s', async (_mode, stream) => {
    // The handler returns once the attempt has ended, so every count is in when this resolves.
    await ask('silent-mock', { stream, signal: AbortSignal.timeout(LEAVE_AFTER_MS) })

    expect(row(null, 'alpha/silent-mock')).toEqual({
      ...EMPTY,
      alias: null,
      provider: 'alpha',
      model: 'alpha/silent-mock',
      requests: 1
    })
  })

  // Catches the #163 retry miscounted: the model refuses `prompt_cache_breakpoint` and is called
  // again without it, which is two upstream calls in one attempt. Both calls' usage must be added
  // (the refusal is a 400 and reports none) under one request, with no failure.
  test.each([
    ['non-streamed', 'refuses-plain', false],
    ['streamed', 'refuses-stream', true]
  ])(
    '%s: count a prompt_cache_breakpoint retry as one request with both calls’ usage',
    async (_mode, modelId, stream) => {
      const status = await ask(`openai/${modelId}`, {
        stream,
        body: {
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Say ok', prompt_cache_breakpoint: { mode: 'explicit' } }
              ]
            }
          ]
        }
      })

      expect(status).toBe(200)
      await vi.waitFor(() => {
        expect(resultRecords().map((record) => record['properties'])).toEqual([
          expect.objectContaining({ modelId, alias: null, attempt: 1, stopReason: 'error' }),
          expect.objectContaining({ modelId, alias: null, attempt: 1, stopReason: 'stop' })
        ])
      })
      expect(row(null, `openai/${modelId}`)).toEqual({
        ...EMPTY,
        alias: null,
        provider: 'openai',
        model: `openai/${modelId}`,
        requests: 1,
        ...expectedUsage(PRICED_USAGE, 1)
      })
    }
  )

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

  // Catches a subscriber (the console, #61) never told of an update, told after it left, or not
  // told of a reset, which would leave it showing the totals from before.
  test('tell a listener of every update and of a reset, until it unsubscribes', async () => {
    const before = routeTotalsSince()
    const listener = vi.fn()
    const unsubscribe = onRouteTotalsChange(listener)
    try {
      await ask('fast')
      expect(listener).toHaveBeenCalled()

      const seen = listener.mock.calls.length
      clearRouteTotals()
      expect(listener).toHaveBeenCalledTimes(seen + 1)
      expect(routeTotals()).toEqual([])

      unsubscribe()
      await ask('fast')
      expect(listener).toHaveBeenCalledTimes(seen + 1)
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
