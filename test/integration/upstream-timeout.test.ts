/**
 * The upstream timeout through the real app and pi's real OpenAI-compatible provider, against a
 * local mock provider: it limits silence, not the length of the call.
 *
 * Real time, not fake timers: the timeout races real socket reads inside pi's provider and the
 * HTTP stack, which fake timers cannot drive. The intervals are kept to tenths of a second.
 */

import { afterAll, beforeAll, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'
import {
  chunk,
  finishChunk,
  type MockProvider,
  silent,
  sse,
  stall,
  startMockProvider,
  textChunks
} from '../fixtures/mock-provider'
import { testApp, testConfig } from '../helpers'

/** Shorter than the whole steady answer, ten times the gap between its chunks. */
const IDLE_TIMEOUT_MS = 1000
const CHUNK_INTERVAL_MS = 100
/** 15 chunks 100 ms apart: about 1.5 s in total, past the 1 s timeout. */
const STEADY_CHUNKS = 15
/** 15 keep-alive chunks 100 ms apart: 1.5 s of them, past the 1 s timeout, before any answer. */
const KEEP_ALIVE_CHUNKS = 15
/**
 * A chunk with no choices: no text, no tool call, so no pi event. Azure, for one, sends one before
 * the answer with only its content-filter results.
 */
const KEEP_ALIVE = { ...chunk({}), choices: [] }

let mock: MockProvider
let agentDir: FixtureAgentDir

beforeAll(async () => {
  mock = await startMockProvider({
    // A chunk every 100 ms, then the finish: the whole answer outlasts the timeout.
    'steady': sse(
      [...textChunks(...Array.from({ length: STEADY_CHUNKS }, () => 'x')), finishChunk('stop')],
      { intervalMs: CHUNK_INTERVAL_MS }
    ),
    // Only chunks that carry no choices, for longer than the timeout, then the answer.
    'keep-alive': sse(
      [
        ...Array.from({ length: KEEP_ALIVE_CHUNKS }, () => KEEP_ALIVE),
        ...textChunks('x'),
        finishChunk('stop')
      ],
      { intervalMs: CHUNK_INTERVAL_MS }
    ),
    // One chunk, then nothing.
    'stall': stall(textChunks('x')),
    // Not even headers.
    'silent': silent()
  })
  agentDir = await loadFixtureAgentDir({
    modelsJson: { providers: { 'timeout-mock': mock.provider() } }
  })
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await mock.close()
  agentDir.remove()
})

/**
 * Builds the test app with the upstream idle timeout set to {@link IDLE_TIMEOUT_MS}.
 *
 * @returns a fresh app
 */
const app = () => testApp({ ...testConfig(), upstreamTimeoutMs: IDLE_TIMEOUT_MS })

/**
 * Asks `timeout-mock/<model>` through the timeout-limited app.
 *
 * @param model - the mock model ID, which picks the provider's behaviour
 * @param stream - whether to request a streamed answer
 * @returns the proxy's response
 */
async function chat(model: string, stream: boolean): Promise<Response> {
  return app().request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: `timeout-mock/${model}`,
      stream,
      messages: [{ role: 'user', content: 'Hello' }]
    })
  })
}

describe('upstream timeout', () => {
  // Catches the timeout capping the whole call again: an answer that keeps arriving must finish,
  // however long it takes in total.
  test('does not cut off an answer that keeps arriving, streamed or not', async () => {
    const complete = await chat('steady', false)
    const completeBody: unknown = await complete.json()
    expect(complete.status).toBe(200)
    expect(completeBody).toMatchObject({
      choices: [{ message: { content: 'x'.repeat(STEADY_CHUNKS) }, finish_reason: 'stop' }]
    })

    const streamed = await (await chat('steady', true)).text()
    expect(streamed).not.toContain('"error"')
    expect(streamed).toContain('"finish_reason":"stop"')
    expect(streamed.endsWith('data: [DONE]\n\n')).toBe(true)
  })

  // Catches the wait restarting only on pi's events: a provider that is still sending, but only
  // chunks pi makes no event of, would be cut off as if it had gone quiet (#50), streamed or not.
  test('does not cut off a provider that sends only chunks pi makes no event of', async () => {
    const complete = await chat('keep-alive', false)
    expect(complete.status).toBe(200)
    expect(await complete.json()).toMatchObject({
      choices: [{ message: { content: 'x' }, finish_reason: 'stop' }]
    })

    const streamed = await chat('keep-alive', true)
    const text = await streamed.text()
    expect(streamed.status).toBe(200)
    expect(text).not.toContain('"error"')
    expect(text).toContain('"content":"x"')
    expect(text).toContain('"finish_reason":"stop"')
    expect(text.endsWith('data: [DONE]\n\n')).toBe(true)
  })

  // Catches a stalled provider hanging the request, or failing it as a generic upstream error that
  // does not say it timed out.
  test('ends a stalled call as a timeout: 504, or an error event once streaming', async () => {
    const complete = await chat('stall', false)
    expect(complete.status).toBe(504)
    expect(await complete.json()).toMatchObject({ error: { code: 'timeout' } })

    const streamed = await (await chat('stall', true)).text()
    expect(streamed).toContain(
      `data: ${JSON.stringify({ error: { message: 'Upstream request timed out', type: 'server_error', param: null, code: 'timeout' } })}\n\n`
    )
    expect(streamed.endsWith('data: [DONE]\n\n')).toBe(true)
  })

  // Catches the case the old whole-call timeout covered: a provider that never responds must still
  // be timed out, though no event ever restarts the wait.
  test('times out a provider that never answers', async () => {
    const complete = await chat('silent', false)
    expect(complete.status).toBe(504)
    expect(await complete.json()).toMatchObject({ error: { code: 'timeout' } })
  })

  // Catches a streaming request to a provider that never answers getting HTTP 200 and an error
  // event: nothing was streamed, so it gets the 504 a non-streaming request gets (#40).
  test('answers a streaming request to a provider that never answers with 504', async () => {
    const streamed = await chat('silent', true)
    expect(streamed.status).toBe(504)
    expect(await streamed.json()).toEqual({
      error: {
        message: 'Upstream request timed out',
        type: 'server_error',
        param: null,
        code: 'timeout'
      }
    })
  })
})
