/**
 * Request fields pi has no option for, end to end: the proxy sets them on the payload pi builds
 * (`onPayload`), verbatim for an OpenAI-compatible API, translated for Anthropic and Google. The
 * unit tests cover what each translation returns; this covers that pi's real clients send it.
 */

import { isRecord } from '@proxy/utils/guards'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'
import {
  finishChunk,
  googleSse,
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
  mock = await startMockProvider({
    'chat-mock': answer,
    'claude-mock': answer,
    'gemini-mock': googleSse('ok')
  })
  agentDir = await loadFixtureAgentDir({
    modelsJson: {
      providers: {
        completions: { ...mock.provider(), models: [{ id: 'chat-mock' }] },
        anthropic: { ...mock.provider('anthropic-messages'), models: [{ id: 'claude-mock' }] },
        google: { ...mock.provider('google-generative-ai'), models: [{ id: 'gemini-mock' }] }
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
 * Asks `model` with {@link FIELDS} and returns the body pi sent upstream.
 *
 * @param model - the public model ID to ask
 * @returns the JSON body of the last request the mock provider received
 * @throws Error when that request has no JSON object body
 */
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

  // Catches the Google fields written where @google/genai never reads them (#110): pi's client
  // builds the wire request's generationConfig from flat `config` keys, so fields nested under
  // `config.generationConfig` are dropped without an error and the client gets a normal answer.
  test('google-generative-ai: translated into the wire generationConfig', async () => {
    const body = await sentBody('google/gemini-mock')
    const sent = isRecord(body['generationConfig']) ? body['generationConfig'] : {}

    expect({
      topP: sent['topP'],
      stopSequences: sent['stopSequences'],
      seed: sent['seed']
    }).toEqual({ topP: TOP_P, stopSequences: ['END'], seed: SEED })
  })
})
