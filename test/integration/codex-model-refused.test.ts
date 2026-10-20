/**
 * A Codex model the ChatGPT login's plan does not include (#156), through pi's real Codex adapter
 * and the mock provider. pi's catalog lists such models, so the proxy exposes them; Codex refuses
 * each request with a stream `error` event and no HTTP status. The event's message is the one
 * observed live on 2026-10-20; its other fields were not captured, and pi reads only the message.
 */

import { afterAll, beforeAll, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'
import { FAKE_CODEX_TOKEN } from '../fixtures/codex-token'
import { type MockProvider, sse, startMockProvider } from '../fixtures/mock-provider'
import { testApp } from '../helpers'

/** What Codex answered for `gpt-5.5` with a ChatGPT login. */
const REFUSAL =
  "The 'refused-model' model is not supported when using Codex with a ChatGPT account."

let mock: MockProvider
let agentDir: FixtureAgentDir

beforeAll(async () => {
  mock = await startMockProvider({ 'refused-model': sse([{ type: 'error', message: REFUSAL }]) })
  agentDir = await loadFixtureAgentDir({
    modelsJson: {
      providers: {
        codex: {
          baseUrl: mock.origin,
          api: 'openai-codex-responses',
          apiKey: FAKE_CODEX_TOKEN,
          models: [{ id: 'refused-model' }]
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

/** OpenAI's error body for the refusal: fixed text, the `model` field named. */
const MODEL_UNAVAILABLE = {
  error: {
    message:
      'The model is not available with the provider login the proxy uses. Choose another model.',
    type: 'invalid_request_error',
    param: 'model',
    code: 'model_not_found'
  }
}

/**
 * Asks the refused model.
 *
 * @param stream - whether to ask for a stream
 * @returns the response status and its whole body as text
 */
async function askRefused(stream: boolean): Promise<{ status: number; text: string }> {
  const response = await testApp().request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'codex/refused-model',
      stream,
      messages: [{ role: 'user', content: 'Hi' }]
    })
  })
  return { status: response.status, text: await response.text() }
}

describe('a Codex model the login cannot use (#156)', () => {
  // Catches the refusal answered as an outage (502), which a client retries forever: it is
  // OpenAI's 404 for a model the account cannot use, which agent clients move on from. The
  // provider's text, which names the plan, stays out of the body.
  test('answers 404 model_not_found', async () => {
    const { status, text } = await askRefused(false)

    expect(status).toBe(404)
    expect(JSON.parse(text)).toEqual(MODEL_UNAVAILABLE)
    expect(text).not.toContain('ChatGPT')
  })

  // Catches the same refusal as an outage in a stream that has started. Live, Codex refuses over
  // the WebSocket before pi's first event, so a stream gets the HTTP 404 (observed 2026-10-20);
  // here pi falls back to the POSTed stream, which starts before the error event, so the status
  // is already 200 and the error event must carry the same body.
  test('ends a stream with the same model_not_found error event', async () => {
    const { status, text } = await askRefused(true)
    const events = text
      .split('\n\n')
      .filter((frame) => frame.startsWith('data: {'))
      .map((frame): unknown => JSON.parse(frame.slice('data: '.length)))

    expect(status).toBe(200)
    expect(events.at(-1)).toEqual(MODEL_UNAVAILABLE)
    expect(text).not.toContain('ChatGPT')
  })
})
