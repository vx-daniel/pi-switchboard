/**
 * Integration tests for POST /v1/chat/completions validation: request parsing, validation and
 * error responses. Requests that need a model to resolve use a fixture provider (literal key,
 * unreachable base URL) and are rejected before any upstream call. Requests that must pass
 * validation use a mock provider model, so the test sees the answer a client gets.
 */

import type { ProxyEnv } from '@proxy/server/types'
import { isRecord } from '@proxy/utils/guards'
import type { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir, offlineProvider } from '../fixtures/agent-dir'
import {
  finishChunk,
  type MockProvider,
  sse,
  startMockProvider,
  textChunks
} from '../fixtures/mock-provider'
import { isErrorBody, isErrorLike, jsonBody, present, testApp, testConfig } from '../helpers'

const FIXTURE_MODEL = 'validation-fixture/model'
/** A model the mock provider answers with "ok". */
const MOCK_MODEL = 'mock/echo'
const HTTP_OK = 200

let app: Hono<ProxyEnv>
let agentDir: FixtureAgentDir
let mock: MockProvider

beforeAll(async () => {
  mock = await startMockProvider({ echo: sse([...textChunks('ok'), finishChunk('stop')]) })
  agentDir = await loadFixtureAgentDir({
    modelsJson: {
      providers: { 'validation-fixture': offlineProvider('model'), 'mock': mock.provider() }
    }
  })
  app = testApp()
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await mock.close()
  agentDir.remove()
})

/**
 * Builds the completion a client gets for the mock's "ok" answer.
 *
 * @param response - the proxy's response, whose `x-request-id` header is the completion id
 * @returns the expected chat completion body, for `toEqual`
 */
function okCompletion(response: Response): Record<string, unknown> {
  return {
    id: response.headers.get('x-request-id'),
    object: 'chat.completion',
    created: expect.any(Number) as number,
    model: MOCK_MODEL,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'ok' },
        finish_reason: 'stop',
        logprobs: null
      }
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }
    },
    x_pi: {
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cache_read_tokens: 0,
      cache_write_tokens: 0
    }
  }
}

/**
 * Builds a request body sent as a stream, so it has no `Content-Length`, as a chunked upload.
 *
 * @param chunks - the body's chunks, sent in order, one per read
 * @returns the body, and how many chunks the reader has asked for so far
 */
function streamedBody(chunks: readonly string[]): {
  body: ReadableStream<Uint8Array>
  pulled: () => number
} {
  const encoder = new TextEncoder()
  let next = 0
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const chunk = chunks[next]
        next += 1
        if (chunk === undefined) controller.close()
        else controller.enqueue(encoder.encode(chunk))
      }
    },
    { highWaterMark: 0 }
  )
  return { body, pulled: () => next }
}

describe('POST /v1/chat/completions - validation', () => {
  // Catches the validator's thrown 400 escaping as Hono's plain text, or the error quoting the
  // body (parser messages in newer engines do).
  test('rejects invalid JSON', async () => {
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json'
    })

    expect(response.status).toBe(400)
    expect(await jsonBody(response)).toEqual({
      error: {
        message: 'Malformed JSON in request body',
        type: 'invalid_request_error',
        param: null,
        code: null
      }
    })
  })

  // Catches `validator('json')` skipping a body not sent as JSON and validating `{}` instead:
  // `curl -d '{…}'` sends form-urlencoded, and the request would fail as "messages: required".
  test.each([
    ['no Content-Type', {}],
    ['form-urlencoded, as curl -d sends', { 'Content-Type': 'application/x-www-form-urlencoded' }],
    ['text/plain', { 'Content-Type': 'text/plain' }]
  ])('reads a JSON body sent with %s', async (_label, headers: Record<string, string>) => {
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: MOCK_MODEL, messages: [{ role: 'user', content: 'Hello' }] })
    })

    expect(response.status).toBe(HTTP_OK)
    expect(await jsonBody(response)).toEqual(okCompletion(response))
  })

  test('rejects missing model', async () => {
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Hello' }]
      })
    })
    expect(response.status).toBe(400)
  })

  test('rejects empty messages', async () => {
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openai/gpt-4o',
        messages: []
      })
    })
    expect(response.status).toBe(400)
  })

  // Catches a request with a valid tool refused by validation or conversion, or answered without
  // the tool reaching the provider.
  test('accepts a function tool and sends it to the provider', async () => {
    const weatherTool = {
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get the weather',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city']
        }
      }
    }
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MOCK_MODEL,
        messages: [{ role: 'user', content: 'Hello' }],
        tools: [weatherTool]
      })
    })

    expect({ status: response.status, body: await jsonBody(response) }).toEqual({
      status: HTTP_OK,
      body: okCompletion(response)
    })
    const upstreamBody = present(mock.requests.at(-1), 'an upstream request').body
    expect(isRecord(upstreamBody) ? upstreamBody['tools'] : undefined).toEqual([weatherTool])
  })

  test('rejects unsupported tool schemas with 422', async () => {
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: FIXTURE_MODEL,
        messages: [{ role: 'user', content: 'Hello' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'bad_tool',
              parameters: {
                type: 'object',
                properties: {
                  data: { $ref: '#/definitions/Data' }
                }
              }
            }
          }
        ]
      })
    })
    expect(response.status).toBe(422)
    const body = await jsonBody(response)
    expect(isErrorBody(body)).toBe(true)
    if (!isErrorBody(body)) return
    expect(body.error.code).toBe('unsupported_parameter')
  })

  // Catches `n: 1` refused again: OpenAI's default, which clients such as Elixir's LangChain send
  // on every request (#197). The proxy returns one choice, so it is answered as asked.
  test.each([1, null])('n: %s is answered', async (choices) => {
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MOCK_MODEL,
        messages: [{ role: 'user', content: 'Hi' }],
        n: choices
      })
    })
    expect(response.status).toBe(HTTP_OK)
    expect(await jsonBody(response)).toEqual(okCompletion(response))
  })

  // Catches several choices asked for and one returned as if that were the answer, or the refusal
  // not naming `n`.
  test.each([2, 0, '1'])('n: %j is a named 422', async (choices) => {
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MOCK_MODEL,
        messages: [{ role: 'user', content: 'Hi' }],
        n: choices
      })
    })
    expect(response.status).toBe(422)
    const body = await jsonBody(response)
    expect(isErrorLike(body) ? body.error['param'] : undefined).toBe('n')
  })

  // Catches an accepted value blamed for another field's error: the client would be told to drop
  // `n: 1`, which is not what is wrong.
  test.each([{ n: 1 }, { store: false }])(
    '%j beside an invalid field reports that field',
    async (honored) => {
      const response = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MOCK_MODEL,
          messages: [{ role: 'user', content: 'Hi' }],
          temperature: 'hot',
          ...honored
        })
      })
      expect(response.status).toBe(400)
      const body = await jsonBody(response)
      expect(isErrorLike(body) ? body.error['param'] : undefined).toBe('temperature')
    }
  )

  // Catches `store: false` refused again: pi's OpenAI adapter sends it to this host on every
  // request (#197). The proxy stores nothing, so "don't store" is answered as asked.
  test.each([false, null])('store: %s is answered', async (store) => {
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MOCK_MODEL,
        messages: [{ role: 'user', content: 'Hi' }],
        store
      })
    })
    expect(response.status).toBe(HTTP_OK)
    expect(await jsonBody(response)).toEqual(okCompletion(response))
  })

  // Catches `store: true` accepted as if the proxy stored completions, or refused without naming
  // the field, or its name lost to a generic 400 when another field is invalid too (the named
  // refusal is checked before the schema).
  test.each([{}, { temperature: 'hot' }])('store: true is a named 422 (with %j)', async (extra) => {
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MOCK_MODEL,
        messages: [{ role: 'user', content: 'Hi' }],
        store: true,
        ...extra
      })
    })
    expect(response.status).toBe(422)
    const body = await jsonBody(response)
    expect(isErrorLike(body) ? body.error['param'] : undefined).toBe('store')
  })

  test('rejects unknown fields with 422', async () => {
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openai/gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
        totally_made_up: true
      })
    })
    expect(response.status).toBe(422)
  })

  test('returns 404 for non-existent model', async () => {
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'fakeprovider/fake-model',
        messages: [{ role: 'user', content: 'Hello' }]
      })
    })
    expect(response.status).toBe(404)
    const body = await jsonBody(response)
    expect(isErrorBody(body)).toBe(true)
    if (!isErrorBody(body)) return
    expect(body.error.code).toBe('model_not_found')
  })

  test('returns request-id header', async () => {
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openai/gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }]
      })
    })
    const requestId = response.headers.get('x-request-id')
    expect(requestId).toBeDefined()
    expect(requestId).toMatch(/^piproxy-/)
  })

  test('echoes x-client-request-id', async () => {
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Request-Id': 'client-123'
      },
      body: JSON.stringify({
        model: 'fakeprovider/fake-model',
        messages: [{ role: 'user', content: 'Hello' }]
      })
    })
    expect(response.headers.get('x-client-request-id')).toBe('client-123')
  })
})

describe('POST /v1/chat/completions - proxy auth', () => {
  test('blocks requests when proxy auth is configured', async () => {
    const authedApp = testApp({
      ...testConfig(),
      proxyAuth: { kind: 'token', token: 'notarealsecret-token' }
    })

    const response = await authedApp.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openai/gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }]
      })
    })
    expect(response.status).toBe(401)
  })

  test('accepts requests with correct proxy auth', async () => {
    const authedApp = testApp({
      ...testConfig(),
      proxyAuth: { kind: 'token', token: 'notarealsecret-token' }
    })

    const response = await authedApp.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer notarealsecret-token'
      },
      body: JSON.stringify({
        model: 'fakeprovider/fake-model',
        messages: [{ role: 'user', content: 'Hello' }]
      })
    })
    expect(response.status).toBe(404)
  })
})

describe('POST /v1/chat/completions - body size limit', () => {
  test('rejects requests exceeding body size limit', async () => {
    const smallLimitApp = testApp({
      ...testConfig(),
      maxBodySize: 100
    })

    const response = await smallLimitApp.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': '200'
      },
      body: JSON.stringify({
        model: 'openai/gpt-4o',
        messages: [{ role: 'user', content: 'a'.repeat(150) }]
      })
    })
    expect(response.status).toBe(413)
    const body = await jsonBody(response)
    expect(isErrorLike(body)).toBe(true)
    if (!isErrorLike(body)) return
    expect(body.error.message).toContain('too large')
  })

  // Catches the limit applied with `>=` instead of `>`, refusing a body exactly at the limit, or
  // the limit middleware consuming the body so the request no longer parses.
  test('allows a body exactly at the limit', async () => {
    const requestBody = JSON.stringify({
      model: MOCK_MODEL,
      messages: [{ role: 'user', content: 'Hello' }]
    })
    const bodyBytes = Buffer.byteLength(requestBody)
    const exactLimitApp = testApp({ ...testConfig(), maxBodySize: bodyBytes })

    const response = await exactLimitApp.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(bodyBytes) },
      body: requestBody
    })

    expect({ status: response.status, body: await jsonBody(response) }).toEqual({
      status: HTTP_OK,
      body: okCompletion(response)
    })
  })

  test('does not apply body size limit to GET requests', async () => {
    const smallLimitApp = testApp({
      ...testConfig(),
      maxBodySize: 10
    })

    const response = await smallLimitApp.request('/v1/models', {
      method: 'GET',
      headers: {
        'Content-Length': '999999'
      }
    })
    expect(response.status).toBe(200)
  })

  // Catches a body without `Content-Length` (chunked) skipping the limit (#187), or the limit
  // reading the whole body before refusing it.
  test('rejects a streamed body over the limit without reading the rest', async () => {
    const chunkCount = 100
    const { body, pulled } = streamedBody(Array.from({ length: chunkCount }, () => 'a'.repeat(64)))
    const limit = 100

    const response = await testApp({ ...testConfig(), maxBodySize: limit }).request(
      '/v1/chat/completions',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, duplex: 'half' }
    )

    expect({ status: response.status, body: await jsonBody(response) }).toEqual({
      status: 413,
      body: {
        error: {
          message: `Request body too large. Maximum size: ${String(limit)} bytes`,
          type: 'invalid_request_error',
          param: null,
          code: null
        }
      }
    })
    expect(pulled()).toBeLessThan(chunkCount)
  })

  // Catches the streamed count refusing a body exactly at the limit, or the limit consuming a
  // streamed body so the route no longer reads it.
  test('allows a streamed body exactly at the limit', async () => {
    const requestBody = JSON.stringify({
      model: MOCK_MODEL,
      messages: [{ role: 'user', content: 'Hello' }]
    })
    const half = Math.floor(requestBody.length / 2)
    const { body } = streamedBody([requestBody.slice(0, half), requestBody.slice(half)])

    const response = await testApp({
      ...testConfig(),
      maxBodySize: Buffer.byteLength(requestBody)
    }).request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      duplex: 'half'
    })

    expect({ status: response.status, body: await jsonBody(response) }).toEqual({
      status: HTTP_OK,
      body: okCompletion(response)
    })
  })
})

describe('POST /v1/chat/completions - upstream API key override', () => {
  // Catches the header ignored (the provider's configured key sent instead), or the request
  // refused because of it.
  test('sends the X-Switchboard-Upstream-Api-Key value to the provider instead of its configured key', async () => {
    const upstreamKey = 'notarealsecret-per-request-upstream-key'
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Switchboard-Upstream-Api-Key': upstreamKey
      },
      body: JSON.stringify({
        model: MOCK_MODEL,
        messages: [{ role: 'user', content: 'Hello' }]
      })
    })

    expect({ status: response.status, body: await jsonBody(response) }).toEqual({
      status: HTTP_OK,
      body: okCompletion(response)
    })
    expect(present(mock.requests.at(-1), 'an upstream request').headers.authorization).toBe(
      `Bearer ${upstreamKey}`
    )
  })

  // Catches an empty header sent to the provider as the key: the call fails upstream and the
  // client gets a 502 blaming the provider for its own mistake (#207). It must be a 400, before
  // any upstream request.
  test.each(['', '   '])('refuses an empty key (%j) with 400, calling nothing', async (key) => {
    const before = mock.requests.length
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Switchboard-Upstream-Api-Key': key },
      body: JSON.stringify({ model: MOCK_MODEL, messages: [{ role: 'user', content: 'Hello' }] })
    })
    const body = await jsonBody(response)

    expect(response.status).toBe(400)
    expect(isErrorBody(body) ? body.error.message : undefined).toContain(
      'X-Switchboard-Upstream-Api-Key header is empty'
    )
    expect(mock.requests.length).toBe(before)
  })
})

describe('unsupported endpoints', () => {
  const endpoints = ['/v1/completions', '/v1/embeddings', '/v1/assistants']

  test.each(endpoints)('returns 404 for %s', async (endpoint) => {
    const response = await app.request(endpoint, { method: 'POST' })
    expect(response.status).toBe(404)
    const body = await jsonBody(response)
    expect(isErrorLike(body)).toBe(true)
    if (!isErrorLike(body)) return
    expect(body.error.message).toContain('not supported')
  })
})
