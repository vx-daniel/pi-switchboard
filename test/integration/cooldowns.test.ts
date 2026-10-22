/**
 * Cooldowns after rate limits (#68), end to end: a 429 cools its provider for as long as the
 * response says, a fallback chain that names `rate_limit` skips it meanwhile, and the state shows on
 * `/healthz/models` and `/v1/switchboard/models`. The proxy runs as deployed (its config file read
 * per request) through pi's OpenAI chat completions adapter against the mock provider.
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { AliasTarget } from '@proxy/config/schema'
import { clearAllCooldowns } from '@proxy/pi/cooldowns'
import { createApp } from '@proxy/server/app'
import { fileConfigReader } from '@proxy/server/routes'
import { isRecord } from '@proxy/utils/guards'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi
} from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'
import { FAKE_CODEX_TOKEN } from '../fixtures/codex-token'
import {
  finishChunk,
  googleSse,
  type MockProvider,
  type MockReply,
  sse,
  startMockProvider,
  textChunks
} from '../fixtures/mock-provider'
import { testConfig } from '../helpers'

const MOCK_KEY = 'notarealsecret-mock-provider-key'
/** How long the rate-limited model says to wait, in seconds. */
const RETRY_AFTER_SECONDS = 30

let mock: MockProvider
let agentDir: FixtureAgentDir
/** Whether `limited-mock` answers 429 (true) or answers normally (false). */
let limiting = true

/**
 * Answers `status` with `retry-after` while {@link limiting}, else with an answer.
 *
 * @param status - the failure status: 429, 503 or 529
 * @param answer - the normal answer
 * @returns the reply
 */
function failingWith(status: number, answer: MockReply): MockReply {
  return (response, request) => {
    if (!limiting) return answer(response, request)
    response.writeHead(status, {
      'content-type': 'application/json',
      'retry-after': String(RETRY_AFTER_SECONDS)
    })
    // Google's SDK error has no status the proxy reads, so it classifies by the message's words.
    const message = status === 429 ? 'Rate limit reached' : 'The model is overloaded'
    response.end(JSON.stringify({ error: { message, type: 'upstream_error' } }))
    return undefined
  }
}

/** How long Codex's usage limit says to wait, in seconds. */
const CODEX_RESETS_IN_SECONDS = 3600

/**
 * Answers as Codex does when a ChatGPT plan's usage limit is reached: 429, the reset in the body
 * and no `retry-after` (the shape pi's adapter reads, `parseErrorResponse`).
 *
 * @param response - the mock's response
 */
const codexUsageLimit: MockReply = (response) => {
  response.writeHead(429, { 'content-type': 'application/json' })
  response.end(
    JSON.stringify({
      error: {
        type: 'usage_limit_reached',
        message: 'The usage limit has been reached',
        plan_type: 'plus',
        resets_in_seconds: CODEX_RESETS_IN_SECONDS
      }
    })
  )
  return undefined
}

beforeAll(async () => {
  const answer = sse([...textChunks('ok'), finishChunk('stop')])
  mock = await startMockProvider({
    'limited-mock': failingWith(429, answer),
    'sibling-mock': answer,
    'answer-mock': answer,
    'limited-gemini': failingWith(429, googleSse('ok')),
    'unavailable-mock': failingWith(503, answer),
    'overloaded-mock': failingWith(529, answer),
    'steady-mock': answer,
    'limited-codex': codexUsageLimit
  })
  const provider = (models: string[]): Record<string, unknown> => ({
    baseUrl: `${mock.origin}/v1`,
    api: 'openai-completions',
    apiKey: MOCK_KEY,
    models: models.map((modelId) => ({ id: modelId }))
  })
  agentDir = await loadFixtureAgentDir({
    modelsJson: {
      providers: {
        alpha: provider(['limited-mock', 'sibling-mock']),
        beta: provider(['answer-mock']),
        gamma: provider(['unavailable-mock', 'overloaded-mock', 'steady-mock']),
        google: { ...mock.provider('google-generative-ai'), models: [{ id: 'limited-gemini' }] },
        codex: {
          baseUrl: mock.origin,
          api: 'openai-codex-responses',
          apiKey: FAKE_CODEX_TOKEN,
          models: [{ id: 'limited-codex' }]
        }
      }
    }
  })
})

beforeEach(() => {
  clearAllCooldowns()
  limiting = true
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-21T12:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

afterAll(async () => {
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
 * Sends one chat request and records which models the upstream was asked for.
 *
 * @param model - the request's `model`
 * @param headers - extra request headers
 * @returns the status, the parsed body, and the upstream models in call order
 */
async function ask(
  model: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: unknown; upstream: unknown[] }> {
  const before = mock.requests.length
  const response = await createApp(testConfig(), fileConfigReader).request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Say ok' }] })
  })
  const body: unknown = await response.json()
  const upstream = mock.requests
    .slice(before)
    .map((request) => (isRecord(request.body) ? request.body['model'] : undefined))
  return { status: response.status, body, upstream }
}

/**
 * Reads a GET route's JSON body.
 *
 * @param path - the route
 * @returns the body
 */
async function getJson(path: string): Promise<Record<string, unknown>> {
  const body: unknown = await (await createApp(testConfig(), fileConfigReader).request(path)).json()
  return isRecord(body) ? body : {}
}

const CHAIN: AliasTarget = {
  targets: ['alpha/limited-mock', 'beta/answer-mock'],
  fallbackOn: ['rate_limit']
}

describe('a 429 cools its provider down', () => {
  // Catches every request rediscovering a rate-limited provider: after the 429 says to wait 30 s,
  // the chain goes straight to the next model and reports the skip, until the time is up.
  test('a chain that names rate_limit skips it for as long as the response says', async () => {
    setAliases({ chain: CHAIN })

    expect((await ask('chain')).upstream).toEqual(['limited-mock', 'answer-mock'])

    const skipping = await ask('chain')
    expect(skipping.upstream).toEqual(['answer-mock'])
    expect(skipping.body).toMatchObject({
      x_pi: { attempts: [{ model: 'alpha/limited-mock', reason: 'rate_limit', skipped: true }] }
    })

    vi.setSystemTime(new Date(Date.now() + RETRY_AFTER_SECONDS * 1000))
    limiting = false
    expect((await ask('chain')).upstream).toEqual(['limited-mock'])
  })

  // Catches a 429 cooling only its own model, when the account's limit covers the provider: the
  // provider's other model is skipped too.
  test("the provider's other models are skipped too", async () => {
    setAliases({
      chain: CHAIN,
      sibling: { targets: ['alpha/sibling-mock', 'beta/answer-mock'], fallbackOn: ['rate_limit'] }
    })
    await ask('chain')

    expect((await ask('sibling')).upstream).toEqual(['answer-mock'])
  })

  // Catches routing a request by a failure the configuration doesn't name (principle VI): a
  // request that names the model, and a chain without rate_limit, still call it.
  test('a request that names the model, or a chain that does not name rate_limit, still calls it', async () => {
    setAliases({
      chain: CHAIN,
      plain: { targets: ['alpha/limited-mock', 'beta/answer-mock'], fallbackOn: ['timeout'] }
    })
    await ask('chain')

    expect((await ask('limited-mock')).upstream).toEqual(['limited-mock'])
    expect((await ask('plain')).upstream).toEqual(['limited-mock'])
  })

  // Catches a cooldown invisible to the operator and to clients that pick models themselves:
  // /healthz/models lists it with the time left, /v1/switchboard/models marks each model under it.
  test('shows on /healthz/models and /v1/switchboard/models', async () => {
    setAliases({ chain: CHAIN })
    await ask('chain')

    const health = await getJson('/healthz/models')
    expect(health['cooldowns']).toEqual([
      expect.objectContaining({
        scope: 'provider',
        provider: 'alpha',
        model: null,
        reason: 'rate_limit',
        secondsLeft: RETRY_AFTER_SECONDS,
        source: 'response'
      })
    ])
    const data = (await getJson('/v1/switchboard/models'))['data']
    const byId = new Map(
      (Array.isArray(data) ? data : []).map((listed: unknown) => [
        isRecord(listed) ? listed['id'] : listed,
        isRecord(listed) ? listed['cooldown'] : undefined
      ])
    )
    const until = Math.ceil(Date.now() / 1000) + RETRY_AFTER_SECONDS
    expect(byId.get('limited-mock')).toEqual({ reason: 'rate_limit', scope: 'provider', until })
    expect(byId.get('sibling-mock')).toEqual({ reason: 'rate_limit', scope: 'provider', until })
    expect(byId.get('answer-mock')).toBeNull()
  })
})

/**
 * Reads the active cooldowns `/healthz/models` lists.
 *
 * @returns the `cooldowns` list
 */
async function listedCooldowns(): Promise<unknown> {
  return (await getJson('/healthz/models'))['cooldowns']
}

describe('what does not cool the shared login', () => {
  // Catches a client's own key cooling the login every other client shares (fourth #181 review):
  // its 429 is about that key, so nothing is recorded, and the chain still calls the provider.
  test('a 429 on a request with its own upstream key', async () => {
    setAliases({ chain: CHAIN })

    const own = await ask('chain', {
      'X-Switchboard-Upstream-Api-Key': 'notarealsecret-client-key'
    })

    expect(own.status).toBe(429)
    expect(await listedCooldowns()).toEqual([])
    expect((await ask('chain')).upstream).toEqual(['limited-mock', 'answer-mock'])
  })
})

describe("Google's adapter", () => {
  // Catches the capturing fetch passed to pi's Google adapter, which refuses any custom fetch and
  // would fail every Google call; without it, a 429 still cools the provider, for the default 60 s.
  test('cools down for the default time, as the proxy cannot read its response', async () => {
    setAliases({
      gchain: { targets: ['google/limited-gemini', 'beta/answer-mock'], fallbackOn: ['rate_limit'] }
    })

    expect((await ask('gchain')).status).toBe(200)
    expect(await listedCooldowns()).toEqual([
      expect.objectContaining({
        provider: 'google',
        reason: 'rate_limit',
        source: 'backoff',
        secondsLeft: 60
      })
    ])
  })
})

describe('a 503 or 529 cools only its model', () => {
  // Catches an overload cooling the whole provider, when it is about one model: the chain skips
  // the overloaded model, while a chain starting at its sibling still calls the sibling.
  test.each([
    ['503', 'unavailable-mock'],
    ['529', 'overloaded-mock']
  ])('after a %s', async (_status, failing) => {
    setAliases({
      overload: { targets: [`gamma/${failing}`, 'beta/answer-mock'], fallbackOn: ['unavailable'] },
      sibling: { targets: ['gamma/steady-mock', 'beta/answer-mock'], fallbackOn: ['unavailable'] }
    })

    expect((await ask('overload')).upstream).toEqual([failing, 'answer-mock'])
    expect((await ask('overload')).upstream).toEqual(['answer-mock'])
    expect((await ask('sibling')).upstream).toEqual(['steady-mock'])
    expect(await listedCooldowns()).toEqual([
      expect.objectContaining({
        scope: 'model',
        provider: 'gamma',
        model: `gamma/${failing}`,
        reason: 'unavailable',
        secondsLeft: RETRY_AFTER_SECONDS,
        source: 'response'
      })
    ])
  })
})

describe('a Codex usage limit (#185)', () => {
  // Catches a Codex usage limit reaching the client as a 502 provider failure: pi throws it with
  // only its own wording ("You have hit your ChatGPT usage limit"), no status, so the proxy has to
  // know that wording to answer 429 rate_limit, as for any other provider's limit.
  test('answers 429 rate_limit', async () => {
    setAliases({})

    const named = await ask('limited-codex')

    expect(named.status).toBe(429)
    expect(named.body).toMatchObject({ error: { code: 'rate_limit' } })
  })

  // Catches the proxy calling Codex over pi's WebSocket, where it sees no response: the 429 body's
  // resets_in_seconds then never reaches the cooldown, which falls back to the 60 s default.
  test('cools the provider for the reset Codex gives, read over SSE', async () => {
    setAliases({
      codexChain: {
        targets: ['codex/limited-codex', 'beta/answer-mock'],
        fallbackOn: ['rate_limit']
      }
    })
    const upgradesBefore = mock.upgrades

    expect((await ask('codexChain')).status).toBe(200)
    expect(mock.upgrades).toBe(upgradesBefore)
    expect(await listedCooldowns()).toEqual([
      expect.objectContaining({
        scope: 'provider',
        provider: 'codex',
        reason: 'rate_limit',
        source: 'response',
        secondsLeft: CODEX_RESETS_IN_SECONDS
      })
    ])
  })
})
