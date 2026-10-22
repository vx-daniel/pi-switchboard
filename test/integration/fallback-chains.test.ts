/**
 * Fallback chains for aliases (#67), end to end: an alias `{ targets, fallbackOn }` tries its targets
 * in order, moving on only for a failure before the response starts whose class the alias names.
 * The proxy runs as deployed (its config file read per request) through pi's OpenAI chat
 * completions adapter against the mock provider, which answers by model.
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { AliasTarget } from '@proxy/config/schema'
import { clearAllCooldowns } from '@proxy/pi/cooldowns'
import { createApp } from '@proxy/server/app'
import { fileConfigReader } from '@proxy/server/routes'
import { isRecord } from '@proxy/utils/guards'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'
import {
  cutOff,
  finishChunk,
  httpError,
  type MockProvider,
  silent,
  sse,
  startMockProvider,
  textChunks
} from '../fixtures/mock-provider'
import { testConfig } from '../helpers'

const MOCK_KEY = 'notarealsecret-mock-provider-key'
/** A 429 as OpenAI sends it. */
const RATE_LIMITED = httpError(429, {
  error: { message: 'Rate limit reached', type: 'rate_limit_error' }
})

let mock: MockProvider
let agentDir: FixtureAgentDir

beforeAll(async () => {
  const answer = sse([...textChunks('ok'), finishChunk('stop')])
  mock = await startMockProvider({
    'limited-mock': RATE_LIMITED,
    'limited2-mock': RATE_LIMITED,
    'busy-mock': httpError(503, { error: { message: 'Overloaded', type: 'server_error' } }),
    'silent-mock': silent(),
    'invalid-mock': httpError(400, {
      error: { message: 'Unsupported value', type: 'invalid_request_error' }
    }),
    'cut-mock': cutOff('par'),
    'text-mock': answer,
    'answer-mock': answer,
    'unauthorized-mock': httpError(401, {
      error: { message: 'Invalid API key', type: 'invalid_request_error' }
    })
  })
  const provider = (models: Record<string, unknown>[]): Record<string, unknown> => ({
    baseUrl: `${mock.origin}/v1`,
    api: 'openai-completions',
    apiKey: MOCK_KEY,
    models
  })
  agentDir = await loadFixtureAgentDir({
    modelsJson: {
      providers: {
        alpha: provider([
          { id: 'limited-mock' },
          { id: 'limited2-mock' },
          { id: 'busy-mock' },
          { id: 'silent-mock' },
          { id: 'invalid-mock' },
          { id: 'cut-mock' },
          { id: 'text-mock', input: ['text'] },
          { id: 'unauthorized-mock' }
        ]),
        beta: provider([{ id: 'answer-mock', input: ['text', 'image'] }])
      }
    }
  })
})

// Cooldowns (#68) are process-wide: each case starts with none, so one case's 429 doesn't route
// the next.
beforeEach(() => {
  clearAllCooldowns()
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await mock.close()
  agentDir.remove()
})

/**
 * Writes the proxy's config file with this one alias, `chain`.
 *
 * @param target - what `chain` names
 */
function setChain(target: AliasTarget): void {
  writeFileSync(
    join(agentDir.path, 'proxy-config.json'),
    JSON.stringify({ aliases: { chain: target } })
  )
}

/** A small PNG as a data URI, for the image request. */
const PNG_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/**
 * Sends one chat request for `model` and records which models the upstream was asked for.
 *
 * @param model - the request's `model`
 * @param options - stream or not, an image part, extra headers, and the upstream idle timeout
 * @returns the status, the body as text, and the upstream models in call order
 */
async function ask(
  model: string,
  options: {
    stream?: boolean
    image?: boolean
    headers?: Record<string, string>
    timeoutMs?: number
  } = {}
): Promise<{ status: number; text: string; upstream: unknown[] }> {
  const before = mock.requests.length
  const content =
    options.image === true
      ? [
          { type: 'text', text: 'What is this?' },
          { type: 'image_url', image_url: { url: PNG_DATA_URI } }
        ]
      : 'Say ok'
  const config = {
    ...testConfig(),
    upstreamTimeoutMs: options.timeoutMs ?? testConfig().upstreamTimeoutMs
  }
  const response = await createApp(config, fileConfigReader).request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...options.headers },
    body: JSON.stringify({
      model,
      stream: options.stream === true,
      messages: [{ role: 'user', content }]
    })
  })
  const text = await response.text()
  const upstream = mock.requests
    .slice(before)
    .map((request) => (isRecord(request.body) ? request.body['model'] : undefined))
  return { status: response.status, text, upstream }
}

/**
 * Parses a response's `x_pi`: the body's, or each stream chunk's.
 *
 * @param text - the response body
 * @param stream - whether it is a stream
 * @returns every `x_pi` found, in order
 */
function xPi(text: string, stream: boolean): unknown[] {
  if (!stream) {
    const body: unknown = JSON.parse(text)
    return [isRecord(body) ? body['x_pi'] : undefined]
  }
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line) => {
      const chunk: unknown = JSON.parse(line.slice('data: '.length))
      return isRecord(chunk) ? chunk['x_pi'] : undefined
    })
}

describe('a fallback chain moves on', () => {
  // Catches a rate-limited first model reaching the client although the alias names the failure
  // and another model can answer, or the hop hidden: the client must see which model answered,
  // which failed, and why, in the body and in every chunk (principle VI).
  test.each([
    ['non-streamed', false],
    ['streamed', true]
  ])(
    '%s: on a named failure, to the next model, with the hop in x_pi.attempts',
    async (_mode, stream) => {
      setChain({ targets: ['alpha/limited-mock', 'beta/answer-mock'], fallbackOn: ['rate_limit'] })

      const answer = await ask('chain', { stream })

      expect(answer.status).toBe(200)
      expect(answer.upstream).toEqual(['limited-mock', 'answer-mock'])
      const route = {
        alias: 'chain',
        attempts: [{ model: 'alpha/limited-mock', reason: 'rate_limit' }]
      }
      const found = xPi(answer.text, stream)
      expect(found.length).toBeGreaterThan(0)
      for (const fields of found) expect(fields).toMatchObject(route)
      expect(answer.text).toContain('"model":"beta/answer-mock"')
    }
  )

  // Catches a refused credential ending the chain when the alias names `auth`: the provider's
  // 401 is the `auth` class, and the next model answers. (A provider with no credential at all is
  // not exposed, so it is never in a chain.)
  test('past a model whose provider refuses the credential, when the alias names auth', async () => {
    setChain({ targets: ['alpha/unauthorized-mock', 'beta/answer-mock'], fallbackOn: ['auth'] })

    const answer = await ask('chain')

    expect(answer.status).toBe(200)
    expect(answer.upstream).toEqual(['unauthorized-mock', 'answer-mock'])
    expect(xPi(answer.text, false)[0]).toMatchObject({
      attempts: [{ model: 'alpha/unauthorized-mock', reason: 'auth' }]
    })
  })

  // Catches an image request sent to a text-only model first when the chain has one that takes
  // images.
  test('an image request skips a text-only model', async () => {
    setChain({ targets: ['alpha/text-mock', 'beta/answer-mock'], fallbackOn: [] })

    expect((await ask('chain', { image: true })).upstream).toEqual(['answer-mock'])
    expect((await ask('chain')).upstream).toEqual(['text-mock'])
  })

  // Catches attempts reported out of order, the earlier ones dropped, or a class mistaken for
  // another along a longer chain: each failure is classed on its own, and the client sees them in
  // the order tried.
  test('through several failures, each reported in order', async () => {
    setChain({
      targets: ['alpha/busy-mock', 'alpha/limited-mock', 'beta/answer-mock'],
      fallbackOn: ['unavailable', 'rate_limit']
    })

    const answer = await ask('chain')

    expect(answer.status).toBe(200)
    expect(answer.upstream).toEqual(['busy-mock', 'limited-mock', 'answer-mock'])
    expect(xPi(answer.text, false)[0]).toMatchObject({
      attempts: [
        { model: 'alpha/busy-mock', reason: 'unavailable' },
        { model: 'alpha/limited-mock', reason: 'rate_limit' }
      ]
    })
  })

  // Catches the idle timeout ending the chain although the alias names `timeout`: a provider that
  // never answers is abandoned at the timeout, and the next one answers.
  test('past a model that never answers, when the alias names timeout', async () => {
    setChain({ targets: ['alpha/silent-mock', 'beta/answer-mock'], fallbackOn: ['timeout'] })

    const answer = await ask('chain', { timeoutMs: 300 })

    expect(answer.status).toBe(200)
    expect(answer.upstream).toEqual(['silent-mock', 'answer-mock'])
    expect(xPi(answer.text, false)[0]).toMatchObject({
      attempts: [{ model: 'alpha/silent-mock', reason: 'timeout' }]
    })
  })
})

describe('a fallback chain stops', () => {
  // Catches fallback on failures the configuration doesn't name (principle VI): the alias lists
  // only timeouts, so a rate limit reaches the client from the first model.
  test('on a failure the alias does not name', async () => {
    setChain({ targets: ['alpha/limited-mock', 'beta/answer-mock'], fallbackOn: ['timeout'] })

    const answer = await ask('chain')

    expect(answer.status).toBe(429)
    expect(answer.upstream).toEqual(['limited-mock'])
  })

  // Catches a client error retried on another model: a 400 is the request's own fault, so it is
  // answered at once even with every class named.
  test('on a 400, whatever the alias names', async () => {
    setChain({
      targets: ['alpha/invalid-mock', 'beta/answer-mock'],
      fallbackOn: ['rate_limit', 'unavailable', 'timeout', 'auth', 'refused', 'upstream_error']
    })

    const answer = await ask('chain')

    expect(answer.status).toBe(400)
    expect(answer.upstream).toEqual(['invalid-mock'])
  })

  // Catches a second model called after the first one's stream started: the client already has
  // bytes from the first, so the stream ends with an error event instead.
  test('once a stream has started', async () => {
    setChain({
      targets: ['alpha/cut-mock', 'beta/answer-mock'],
      fallbackOn: ['upstream_error', 'timeout']
    })

    const answer = await ask('chain', { stream: true })

    expect(answer.status).toBe(200)
    expect(answer.upstream).toEqual(['cut-mock'])
    expect(answer.text).toContain('"error"')
    expect(answer.text).not.toContain('answer-mock')
  })

  // Catches an exhausted chain answering with the first failure, or a success: the client gets
  // the last model's failure.
  test('after the last model, with its failure', async () => {
    setChain({ targets: ['alpha/limited-mock', 'alpha/limited2-mock'], fallbackOn: ['rate_limit'] })

    const answer = await ask('chain')

    expect(answer.status).toBe(429)
    expect(answer.upstream).toEqual(['limited-mock', 'limited2-mock'])
  })

  // Catches a per-request upstream key sent to another provider: it is one provider's key, so
  // the request runs on the first model only.
  test('for a request with its own upstream key', async () => {
    setChain({ targets: ['alpha/limited-mock', 'beta/answer-mock'], fallbackOn: ['rate_limit'] })

    const answer = await ask('chain', {
      headers: { 'X-Switchboard-Upstream-Api-Key': 'notarealsecret-client-key' }
    })

    expect(answer.status).toBe(429)
    expect(answer.upstream).toEqual(['limited-mock'])
  })

  // Catches a client's own key, refused by the provider, moving down a chain that names `auth`:
  // the refusal is class `auth`, but the key is one provider's, so the request runs on the first
  // model only and the client gets the 401 that says its key is wrong (#128).
  test('for a request whose own upstream key the provider refuses, though `auth` is named', async () => {
    setChain({ targets: ['alpha/unauthorized-mock', 'beta/answer-mock'], fallbackOn: ['auth'] })

    const answer = await ask('chain', {
      headers: { 'X-Switchboard-Upstream-Api-Key': 'notarealsecret-client-key' }
    })
    const body: unknown = JSON.parse(answer.text)

    expect(answer.status).toBe(401)
    expect(isRecord(body) && isRecord(body['error']) ? body['error']['code'] : undefined).toBe(
      'upstream_api_key_invalid'
    )
    expect(answer.upstream).toEqual(['unauthorized-mock'])
  })

  // Catches routing applied to a request that named a model, not an alias: it behaves as without
  // routing (principle VI), with no attempts reported.
  test('never for a request that names a model', async () => {
    setChain({ targets: ['alpha/limited-mock', 'beta/answer-mock'], fallbackOn: ['rate_limit'] })

    const answer = await ask('limited-mock')

    expect(answer.status).toBe(429)
    expect(answer.upstream).toEqual(['limited-mock'])
  })
})
