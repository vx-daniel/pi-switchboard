/**
 * A model on `api.openai.com` that refuses `prompt_cache_breakpoint` (#163), through the chat
 * route, pi's real OpenAI chat completions adapter and the OpenAI SDK. The ChatGPT-subscription
 * models answer the field with a 400 naming it as `param`; the proxy retries once without it and
 * leaves it out for that model from then on. `fetch` is redirected from `api.openai.com` to the
 * mock provider, which answers as those models do: a 400 when the request carries the field.
 */

import { resetSync } from '@logtape/logtape'
import { configureLogging } from '@proxy/logging'
import { isRecord } from '@proxy/utils/guards'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'
import {
  finishChunk,
  httpError,
  type MockProvider,
  type MockReply,
  type MockRequest,
  sse,
  startMockProvider,
  textChunks
} from '../fixtures/mock-provider'
import { testApp } from '../helpers'

/** OpenAI's own API, the one host the proxy sends breakpoints to. */
const OPENAI_ORIGIN = 'https://api.openai.com'

/** OpenAI's refusal of the field, as the ChatGPT models send it. */
const BREAKPOINT_REFUSAL = {
  error: {
    message: 'prompt_cache_breakpoint is not supported on this model',
    type: 'invalid_request_error',
    param: 'prompt_cache_breakpoint',
    code: 'invalid_parameter'
  }
}

/** A 400 for another field, which must not be retried. */
const TEMPERATURE_REFUSAL = {
  error: {
    message: 'temperature is not supported on this model',
    type: 'invalid_request_error',
    param: 'temperature',
    code: 'invalid_parameter'
  }
}

/** A successful streamed answer. */
const ANSWER = sse([...textChunks('ok'), finishChunk('stop')])

let mock: MockProvider
let agentDir: FixtureAgentDir
/** Every info line about a refusal: its properties. */
let refusalLines: unknown[] = []

/**
 * Says whether a request to the mock carried a breakpoint anywhere in its body.
 *
 * @param request - the request the mock received
 * @returns whether the body mentions `prompt_cache_breakpoint`
 */
function carriesBreakpoint(request: MockRequest): boolean {
  return JSON.stringify(request.body).includes('prompt_cache_breakpoint')
}

/**
 * Answers as a model that refuses the field: a 400 naming it when sent, else an answer.
 *
 * @param refusal - the 400 body to send when the request carries a breakpoint
 * @returns the reply
 */
function refusingWith(refusal: unknown): MockReply {
  return (response, request) =>
    carriesBreakpoint(request)
      ? httpError(400, refusal)(response, request)
      : ANSWER(response, request)
}

/** How long a held refusal waits for the others before it is sent anyway, in milliseconds. */
const HOLD_LIMIT_MS = 2000

/**
 * Answers as {@link refusingWith} does with the field's refusal, but holds each refusal until
 * `count` requests carrying the field have arrived: all of them are in flight before the first
 * refusal comes back, as an agent's parallel calls are at first use.
 *
 * @param count - how many requests to hold together
 * @returns the reply
 */
function refusingTogether(count: number): MockReply {
  let held: (() => void)[] = []
  return async (response, request) => {
    if (!carriesBreakpoint(request)) {
      await ANSWER(response, request)
      return
    }
    await new Promise<void>((resolve) => {
      held.push(resolve)
      setTimeout(resolve, HOLD_LIMIT_MS)
      if (held.length < count) return
      for (const release of held) release()
      held = []
    })
    httpError(400, BREAKPOINT_REFUSAL)(response, request)
  }
}

beforeAll(async () => {
  mock = await startMockProvider({
    'refuses-plain': refusingWith(BREAKPOINT_REFUSAL),
    'refuses-stream': refusingWith(BREAKPOINT_REFUSAL),
    'refuses-temperature': refusingWith(TEMPERATURE_REFUSAL),
    'refuses-together': refusingTogether(2),
    'accepts': ANSWER
  })
  agentDir = await loadFixtureAgentDir({
    modelsJson: {
      providers: {
        openai: {
          baseUrl: `${OPENAI_ORIGIN}/v1`,
          api: 'openai-completions',
          apiKey: 'notarealsecret-openai-key',
          models: [
            { id: 'refuses-plain' },
            { id: 'refuses-stream' },
            { id: 'refuses-temperature' },
            { id: 'refuses-together' },
            { id: 'accepts' }
          ]
        }
      }
    }
  })
  // The OpenAI SDK reads the global fetch for each client pi creates, which is per request.
  const realFetch = globalThis.fetch
  vi.stubGlobal('fetch', (input: Request | URL | string, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    return realFetch(
      url.startsWith(OPENAI_ORIGIN) ? `${mock.origin}${url.slice(OPENAI_ORIGIN.length)}` : input,
      init
    )
  })
  configureLogging({
    level: 'debug',
    format: 'json',
    write: (line) => {
      const parsed: unknown = JSON.parse(line)
      if (!isRecord(parsed) || typeof parsed['message'] !== 'string') return
      if (
        parsed['level'] === 'INFO' &&
        parsed['message'].includes('refused prompt_cache_breakpoint')
      ) {
        refusalLines.push(parsed['properties'])
      }
    }
  })
})

beforeEach(() => {
  refusalLines = []
})

afterAll(async () => {
  resetSync()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await mock.close()
  agentDir.remove()
})

/**
 * Sends the issue's request, with a breakpoint on its one content part, and counts the upstream
 * calls it made.
 *
 * @param modelId - the model to ask
 * @param stream - whether to ask for a stream
 * @returns the status, the body as text, and each upstream call's "carried a breakpoint"
 */
async function ask(
  modelId: string,
  stream: boolean
): Promise<{ status: number; text: string; upstream: boolean[] }> {
  const before = mock.requests.length
  const response = await testApp().request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: `openai/${modelId}`,
      stream,
      max_completion_tokens: 64,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Say ok', prompt_cache_breakpoint: { mode: 'explicit' } }]
        }
      ]
    })
  })
  const text = await response.text()
  const upstream = mock.requests
    .slice(before)
    .filter((request) => isRecord(request.body) && request.body['model'] === modelId)
    .map(carriesBreakpoint)
  return { status: response.status, text, upstream }
}

describe('a model that refuses prompt_cache_breakpoint (#163)', () => {
  // Catches every docker-agent request to a ChatGPT model failing (the 400 reaching the client),
  // a retry that sends the field again, or the refusal forgotten so each request pays for it.
  test.each([
    ['non-streamed', 'refuses-plain', false],
    ['streamed', 'refuses-stream', true]
  ])(
    '%s: retried once without the field, then left out from the start',
    async (_mode, modelId, stream) => {
      const first = await ask(modelId, stream)

      expect(first.status).toBe(200)
      expect(first.text).toContain('ok')
      expect(first.upstream).toEqual([true, false])
      expect(refusalLines).toEqual([expect.objectContaining({ provider: 'openai', modelId })])

      const second = await ask(modelId, stream)

      expect(second.status).toBe(200)
      expect(second.upstream).toEqual([false])
      // Logged once, at the refusal: not again on every later request.
      expect(refusalLines).toHaveLength(1)
    }
  )

  // Catches only the first of several requests in flight together being retried: they all send
  // the field before the first refusal comes back, and the later ones, refused after the model is
  // remembered, reached the client as a 400 (#166 review).
  test('requests in flight together are each retried', async () => {
    const before = mock.requests.length
    const results = await Promise.all([
      ask('refuses-together', false),
      ask('refuses-together', true)
    ])
    const upstream = mock.requests
      .slice(before)
      .filter((request) => isRecord(request.body) && request.body['model'] === 'refuses-together')

    expect(results.map((answer) => answer.status)).toEqual([200, 200])
    // Each request: one call with the field, refused, then one without it.
    expect(upstream.filter(carriesBreakpoint)).toHaveLength(2)
    expect(upstream.filter((request) => !carriesBreakpoint(request))).toHaveLength(2)
    expect(refusalLines).toHaveLength(1)
  })

  // Catches the retry widened to any 400: a refusal of another field is the client's to see.
  test('a 400 naming another field is answered, not retried', async () => {
    const result = await ask('refuses-temperature', false)

    expect(result.status).toBe(400)
    expect(result.upstream).toEqual([true])
    expect(refusalLines).toEqual([])
  })

  // Catches the refusal remembered for every model: one that takes the field keeps getting it.
  test('a model that accepts the field still gets it', async () => {
    const result = await ask('accepts', false)

    expect(result.status).toBe(200)
    expect(result.upstream).toEqual([true])
  })
})
