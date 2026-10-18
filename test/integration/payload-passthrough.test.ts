/**
 * Request fields pi has no option for, end to end: the proxy sets them on the payload pi builds
 * (`onPayload`), verbatim for an OpenAI-compatible API, translated for Anthropic. The unit tests
 * cover what each translation returns; this covers that pi's real clients send it.
 */

import { isRecord } from '@proxy/utils/guards'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'
import {
  finishChunk,
  type MockProvider,
  sse,
  startMockProvider,
  textChunks
} from '../fixtures/mock-provider'
import { testApp } from '../helpers'

const TOP_P = 0.5
const SEED = 7
/** Fields every API is sent: a stop sequence, top_p and a seed. */
const FIELDS = { stop: ['END'], top_p: TOP_P, seed: SEED }

let mock: MockProvider
let agentDir: FixtureAgentDir

beforeAll(async () => {
  const answer = sse([...textChunks('ok'), finishChunk('stop')])
  mock = await startMockProvider({ 'chat-mock': answer, 'claude-mock': answer })
  agentDir = await loadFixtureAgentDir({
    modelsJson: {
      providers: {
        completions: { ...mock.provider(), models: [{ id: 'chat-mock' }] },
        anthropic: { ...mock.provider('anthropic-messages'), models: [{ id: 'claude-mock' }] }
      }
    }
  })
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await mock.close()
  agentDir.remove()
})

/** Ask `model` with FIELDS, and return the body pi sent upstream. */
async function sentBody(model: string): Promise<Record<string, unknown>> {
  await testApp().request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Hi' }], ...FIELDS })
  })
  const body = mock.requests.at(-1)?.body
  if (!isRecord(body)) throw new Error('pi sent no request body')
  return body
}

describe('passthrough fields reach the provider', () => {
  // Catches the payload hook not set, or set where pi never calls it: every field would be lost
  // with no error, as only the unit tests of each translation would still pass.
  test('openai-completions: verbatim', async () => {
    const body = await sentBody('completions/chat-mock')

    expect({ stop: body['stop'], top_p: body['top_p'], seed: body['seed'] }).toEqual(FIELDS)
  })

  // Catches the Anthropic translation not applied: stop must arrive as stop_sequences, and seed,
  // which Anthropic has no field for, must not be sent at all (#81).
  test('anthropic-messages: translated', async () => {
    const body = await sentBody('anthropic/claude-mock')

    expect({
      stop_sequences: body['stop_sequences'],
      top_p: body['top_p'],
      hasStop: 'stop' in body,
      hasSeed: 'seed' in body
    }).toEqual({ stop_sequences: ['END'], top_p: TOP_P, hasStop: false, hasSeed: false })
  })
})
