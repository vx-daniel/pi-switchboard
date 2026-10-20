/**
 * `prompt_cache_key` end to end (#39): the proxy passes it to pi as `sessionId`, and pi's real
 * clients send it where the provider takes one. On OpenAI Responses it is the body's
 * `prompt_cache_key`; on Anthropic, a session-affinity header, only for a model whose compat asks
 * for it. `null` is the same as no key, and a key pi would cut to 64 characters is refused.
 */

import { isRecord } from '@proxy/utils/guards'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'
import {
  finishChunk,
  type MockProvider,
  type MockRequest,
  sse,
  startMockProvider,
  textChunks
} from '../fixtures/mock-provider'
import { jsonBody, testApp } from '../helpers'

const MOCK_KEY = 'notarealsecret-mock-provider-key'
const HTTP_BAD_REQUEST = 400
/** pi's limit, and the proxy's: `OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH`. */
const MAX_KEY_LENGTH = 64
const SESSION_KEY = 'j5-session-0192'

let mock: MockProvider
let agentDir: FixtureAgentDir

beforeAll(async () => {
  const answer = sse([...textChunks('ok'), finishChunk('stop')])
  mock = await startMockProvider({ 'gpt-cache': answer, 'claude-affinity': answer })
  agentDir = await loadFixtureAgentDir({
    modelsJson: {
      providers: {
        responses: {
          baseUrl: `${mock.origin}/v1`,
          api: 'openai-responses',
          apiKey: MOCK_KEY,
          models: [{ id: 'gpt-cache' }]
        },
        anthropic: {
          baseUrl: mock.origin,
          api: 'anthropic-messages',
          apiKey: MOCK_KEY,
          models: [{ id: 'claude-affinity', compat: { sendSessionAffinityHeaders: true } }]
        }
      }
    }
  })
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await mock.close()
  agentDir.remove()
})

/**
 * Asks `model` once, with `fields` added to the body, and returns the response and what reached
 * the mock provider.
 *
 * @param model - the public model ID to ask
 * @param fields - extra top-level request fields, such as `prompt_cache_key`
 * @returns the proxy's response, and the upstream request (`undefined` when none was made)
 */
async function ask(
  model: string,
  fields: Record<string, unknown>
): Promise<{ response: Response; upstream: MockRequest | undefined }> {
  const before = mock.requests.length
  const response = await testApp().request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Hi' }], ...fields })
  })
  return { response, upstream: mock.requests[before] }
}

/**
 * Reads the `prompt_cache_key` an upstream request body carried.
 *
 * @param upstream - the request the mock received
 * @returns the key, or `undefined` when the body has none
 */
function sentCacheKey(upstream: MockRequest | undefined): unknown {
  return isRecord(upstream?.body) ? upstream.body['prompt_cache_key'] : undefined
}

describe('prompt_cache_key reaches the provider as pi sends it', () => {
  // Catches the key accepted but never given to pi, so OpenAI Responses and Codex route by
  // prefix only and concurrent sessions compete for one cache entry.
  test('openai-responses: the body carries it as prompt_cache_key', async () => {
    const { upstream } = await ask('gpt-cache', { prompt_cache_key: SESSION_KEY })

    expect(sentCacheKey(upstream)).toBe(SESSION_KEY)
  })

  // Catches the key reaching pi without the session header Anthropic-compatible gateways use to
  // keep a session on one backend.
  test('anthropic-messages with affinity headers: sent as x-session-affinity', async () => {
    const { upstream } = await ask('claude-affinity', { prompt_cache_key: SESSION_KEY })

    expect(upstream?.headers['x-session-affinity']).toBe(SESSION_KEY)
  })

  // Catches a key sent that the client never gave (a derived or default one), which would merge
  // unrelated sessions' caches.
  test.each([
    ['absent', {}],
    ['null', { prompt_cache_key: null }]
  ])('%s: no key and no session header upstream', async (_label, fields) => {
    const responses = await ask('gpt-cache', fields)
    const anthropic = await ask('claude-affinity', fields)

    expect(sentCacheKey(responses.upstream)).toBeUndefined()
    expect(anthropic.upstream?.headers['x-session-affinity']).toBeUndefined()
  })

  // Catches the limit set below pi's, which would refuse keys pi sends whole.
  test(`a ${String(MAX_KEY_LENGTH)}-character key is sent whole`, async () => {
    const key = 'k'.repeat(MAX_KEY_LENGTH)
    const { upstream } = await ask('gpt-cache', { prompt_cache_key: key })

    expect(sentCacheKey(upstream)).toBe(key)
  })
})

describe('a prompt_cache_key pi could not send as given is refused', () => {
  // Catches pi's silent cut to 64 characters, which merges every key sharing its first 64 into
  // one cache entry, and an empty key sent as a real one.
  test.each([
    ['longer than 64 characters', 'k'.repeat(MAX_KEY_LENGTH + 1)],
    ['empty', ''],
    ['only spaces', '   ']
  ])('%s: 400 naming the field, nothing sent upstream', async (_label, key) => {
    const { response, upstream } = await ask('gpt-cache', { prompt_cache_key: key })
    const body = await jsonBody(response)

    expect(response.status).toBe(HTTP_BAD_REQUEST)
    expect(body).toMatchObject({
      error: { type: 'invalid_request_error', param: 'prompt_cache_key' }
    })
    expect(upstream).toBeUndefined()
  })
})
