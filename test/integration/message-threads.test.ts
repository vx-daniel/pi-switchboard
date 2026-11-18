/**
 * Anthropic message threads stay off (#360, #361): pi 1.5.1 continues a conversation on
 * Anthropic's side when two calls share a `sessionId`, sending only the new messages. The proxy
 * keeps no conversation state (constitution, Scope), so every request must still send the whole
 * conversation, even for a model whose compat turns threads on.
 */

import { isRecord } from '@proxy/utils/guards'
import { afterAll, beforeAll, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'
import { type MockProvider, startMockProvider } from '../fixtures/mock-provider'
import { loadRecording, replay } from '../fixtures/recording'
import { testApp } from '../helpers'

const MOCK_KEY = 'notarealsecret-mock-provider-key'
const SESSION_KEY = 'j5-thread-session'
const MODEL = 'threaded'

let mock: MockProvider
let agentDir: FixtureAgentDir

beforeAll(async () => {
  mock = await startMockProvider({ [MODEL]: replay(loadRecording('anthropic-messages', 'text')) })
  agentDir = await loadFixtureAgentDir({
    modelsJson: {
      providers: {
        anthropic: {
          baseUrl: mock.origin,
          api: 'anthropic-messages',
          apiKey: MOCK_KEY,
          // pi turns threads on by itself only on api.anthropic.com; the compat flag does the same
          // for the mock, so the test sees what a real Anthropic login would send.
          models: [{ id: MODEL, compat: { supportsMessageThreads: true } }]
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
 * Sends one non-streamed chat completion with the session key, and returns the reply text and the
 * request that reached the provider.
 *
 * @param messages - the conversation so far
 * @returns the assistant's text, and the upstream request's body and `anthropic-beta` header
 * @throws Error when the proxy's answer is not a chat completion with text
 */
async function turn(
  messages: readonly Record<string, unknown>[]
): Promise<{ text: string; upstream: unknown; betas: string | string[] | undefined }> {
  const before = mock.requests.length
  const response = await testApp().request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: `anthropic/${MODEL}`, messages, prompt_cache_key: SESSION_KEY })
  })
  const body: unknown = await response.json()
  const choices = isRecord(body) ? body['choices'] : undefined
  const message = Array.isArray(choices) && isRecord(choices[0]) ? choices[0]['message'] : undefined
  const text = isRecord(message) ? message['content'] : undefined
  if (typeof text !== 'string') throw new Error(`expected a reply, got ${JSON.stringify(body)}`)
  const upstream = mock.requests[before]
  return { text, upstream: upstream?.body, betas: upstream?.headers['anthropic-beta'] }
}

// Catches threads left on: the second turn would carry `thread: { type: "continue" }` and only the
// last user message, so the answer would depend on state the proxy keeps between requests. Also
// catches the threads beta still sent (#363 review): #360 keeps the beta off Anthropic traffic.
test('a session sends the whole conversation each turn, with no thread and no threads beta', async () => {
  const first = [{ role: 'user', content: 'Hi' }]
  const firstTurn = await turn(first)

  const secondTurn = await turn([
    ...first,
    { role: 'assistant', content: firstTurn.text },
    { role: 'user', content: 'And again' }
  ])

  const { upstream } = secondTurn
  expect(isRecord(upstream) && 'thread' in upstream).toBe(false)
  expect(isRecord(upstream) ? upstream['messages'] : undefined).toHaveLength(3)
  for (const { betas } of [firstTurn, secondTurn]) {
    expect(String(betas ?? '')).not.toContain('message-threads')
  }
})
