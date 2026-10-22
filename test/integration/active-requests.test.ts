/**
 * The chat requests in flight (the console's sidebar, #61), end to end: a request is listed while
 * it waits on the model and while its stream is relayed, and every way it can end removes it. The
 * proxy runs as deployed (its config file read per request) through pi's OpenAI chat completions
 * adapter against the mock provider.
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { clearAllCooldowns } from '@proxy/pi/cooldowns'
import { activeRequests, finishedRequests } from '@proxy/server/active-requests'
import { createApp } from '@proxy/server/app'
import { fileConfigReader } from '@proxy/server/routes'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'
import {
  chunk,
  cutOff,
  httpError,
  type MockProvider,
  silent,
  sse,
  startMockProvider,
  textChunks
} from '../fixtures/mock-provider'
import { testConfig } from '../helpers'

const MOCK_KEY = 'notarealsecret-mock-provider-key'
/** Between the slow stream's chunks: long enough to look at the request while it streams. */
const CHUNK_INTERVAL_MS = 150

let mock: MockProvider
let agentDir: FixtureAgentDir

beforeAll(async () => {
  mock = await startMockProvider({
    'answer-mock': sse([...textChunks('ok'), chunk({}, 'stop')]),
    'slow-mock': sse([...textChunks('a', 'b', 'c'), chunk({}, 'stop')], {
      intervalMs: CHUNK_INTERVAL_MS
    }),
    'limited-mock': httpError(429, {
      error: { message: 'Rate limit reached', type: 'rate_limit_error' }
    }),
    'invalid-mock': httpError(400, {
      error: { message: 'Unsupported value', type: 'invalid_request_error' }
    }),
    'cut-mock': cutOff('par'),
    'silent-mock': silent()
  })
  agentDir = await loadFixtureAgentDir({
    modelsJson: {
      providers: {
        alpha: {
          baseUrl: `${mock.origin}/v1`,
          api: 'openai-completions',
          apiKey: MOCK_KEY,
          models: [
            'answer-mock',
            'slow-mock',
            'limited-mock',
            'invalid-mock',
            'cut-mock',
            'silent-mock'
          ].map((modelId) => ({ id: modelId }))
        }
      }
    }
  })
  writeFileSync(
    join(agentDir.path, 'proxy-config.json'),
    JSON.stringify({
      aliases: {
        coding: { targets: ['alpha/limited-mock', 'alpha/answer-mock'], fallbackOn: ['rate_limit'] }
      }
    })
  )
})

beforeEach(() => {
  clearAllCooldowns()
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await mock.close()
  agentDir.remove()
})

/**
 * Sends one chat request, without reading its answer.
 *
 * @param model - the request's `model`
 * @param options - stream or not, and a signal to leave early
 * @param options.stream - whether to ask for a stream
 * @param options.signal - aborts the request: the client leaves
 * @returns the response, once its headers are in
 */
function send(
  model: string,
  options: { stream?: boolean; signal?: AbortSignal } = {}
): Promise<Response> {
  return Promise.resolve(
    createApp(testConfig(), fileConfigReader).request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: options.stream === true,
        messages: [{ role: 'user', content: 'Say ok' }]
      }),
      ...(options.signal === undefined ? {} : { signal: options.signal })
    })
  )
}

describe('requests in flight', () => {
  // Catches a request missing from the sidebar while it waits on the model, or listed with the
  // wrong route, and one left listed after the client gave up on it or recorded as a failure.
  test.each([
    ['streamed', true],
    ['non-streamed', false]
  ])(
    'lists a %s request until the client leaves, then records that it left',
    async (_mode, stream) => {
      const client = new AbortController()
      const answer = send('alpha/silent-mock', { stream, signal: client.signal })

      await vi.waitFor(() => {
        expect(activeRequests()).toEqual([
          expect.objectContaining({
            alias: null,
            model: 'alpha/silent-mock',
            attempt: 1,
            stream,
            firstEventAt: undefined
          })
        ])
      })
      client.abort()
      await answer.then((response) => response.text()).catch(() => undefined)

      await vi.waitFor(() => {
        expect(activeRequests()).toEqual([])
      })
      expect(finishedRequests()[0]).toEqual(
        expect.objectContaining({ model: 'alpha/silent-mock', outcome: 'left' })
      )
    }
  )

  // Catches a streamed request dropped as soon as its first event is relayed (the dispatch returns
  // then), one kept after its stream closed, or a stream's first event not timed.
  test('keeps a streamed request listed until its stream closes', async () => {
    const response = await send('alpha/slow-mock', { stream: true })

    expect(activeRequests()).toEqual([
      expect.objectContaining({ model: 'alpha/slow-mock', firstEventAt: expect.any(Number) })
    ])
    await response.text()
    await vi.waitFor(() => {
      expect(activeRequests()).toEqual([])
    })
    const [done] = finishedRequests()
    expect(done).toEqual(expect.objectContaining({ model: 'alpha/slow-mock', outcome: 'ok' }))
    expect(done?.endedAt).toBeGreaterThanOrEqual(done?.firstEventAt ?? Number.POSITIVE_INFINITY)
  })

  // Catches an ending that leaks an entry, so the sidebar counts requests that are long gone, or
  // one recorded with the wrong outcome or the wrong model: an answer, a fallback, a refusal, and
  // a stream the provider cut off.
  test.each([
    { ending: 'an answer', model: 'alpha/answer-mock', stream: false, attempt: 1, outcome: 'ok' },
    {
      ending: 'a fallback to the next model',
      model: 'coding',
      stream: false,
      attempt: 2,
      outcome: 'ok'
    },
    { ending: 'a streamed fallback', model: 'coding', stream: true, attempt: 2, outcome: 'ok' },
    {
      ending: 'a refusal',
      model: 'alpha/invalid-mock',
      stream: false,
      attempt: 1,
      outcome: 'failed'
    },
    {
      ending: 'a streamed refusal',
      model: 'alpha/invalid-mock',
      stream: true,
      attempt: 1,
      outcome: 'failed'
    },
    {
      ending: 'a stream cut off',
      model: 'alpha/cut-mock',
      stream: true,
      attempt: 1,
      outcome: 'failed'
    }
  ])('ends a request in $ending and records how', async ({ model, stream, attempt, outcome }) => {
    const response = await send(model, { stream })
    await response.text()

    await vi.waitFor(() => {
      expect(activeRequests()).toEqual([])
    })
    // An alias's request is recorded on the model that answered it.
    const served = model === 'coding' ? 'alpha/answer-mock' : model
    expect(finishedRequests()[0]).toEqual(
      expect.objectContaining({ model: served, attempt, stream, outcome })
    )
  })
})
