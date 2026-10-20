/**
 * `temperature` where it does not reach the provider. The Codex backend rejects the parameter
 * ("Unsupported parameter: temperature") though pi 1.3.0 forwards it, so the proxy drops it for
 * `openai-codex-responses` (#49). pi's Anthropic adapter leaves it out itself on Claude models
 * whose catalog entry clears `supportsTemperature`, and whenever thinking is on (#147). Both say
 * so at info the first time per model, then at debug. Every other model gets it.
 *
 * pi's Codex adapter reads the ChatGPT account ID from its key, a JWT, so the fixture key is an
 * unsigned one carrying a fake account ID. The mock answers in chat-completions format, which the
 * Codex adapter cannot parse; these tests read the request pi sent, which is complete either way.
 */

import { resetSync } from '@logtape/logtape'
import { configureLogging } from '@proxy/logging'
import { isRecord } from '@proxy/utils/guards'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'
import {
  finishChunk,
  type MockProvider,
  sse,
  startMockProvider,
  textChunks
} from '../fixtures/mock-provider'
import { testApp } from '../helpers'

const TEMPERATURE = 0.3

/**
 * Encodes a value as a JWT segment: base64url JSON.
 *
 * @param value - the header or payload to encode
 * @returns the base64url encoding of `value`'s JSON
 */
function jwtSegment(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

/** An unsigned JWT with the claim pi's Codex adapter reads the account ID from. */
const FAKE_CODEX_TOKEN = [
  jwtSegment({ alg: 'none' }),
  jwtSegment({
    'https://api.openai.com/auth': { chatgpt_account_id: 'notarealsecret-account' }
  }),
  'notarealsecret-signature'
].join('.')

let mock: MockProvider
let agentDir: FixtureAgentDir
/** Every log record of the temperature drop: its level and properties. */
const dropRecords: { level: string; properties: unknown }[] = []

beforeAll(async () => {
  const answer = sse([...textChunks('ok'), finishChunk('stop')])
  mock = await startMockProvider({
    'codex-mock': answer,
    'chat-mock': answer,
    'claude-no-temperature': answer,
    'claude-plain': answer
  })
  agentDir = await loadFixtureAgentDir({
    modelsJson: {
      providers: {
        codex: {
          baseUrl: mock.origin,
          api: 'openai-codex-responses',
          apiKey: FAKE_CODEX_TOKEN,
          models: [{ id: 'codex-mock' }]
        },
        completions: { ...mock.provider(), models: [{ id: 'chat-mock' }] },
        anthropic: {
          baseUrl: mock.origin,
          api: 'anthropic-messages',
          apiKey: 'notarealsecret-anthropic-key',
          models: [
            { id: 'claude-no-temperature', compat: { supportsTemperature: false } },
            { id: 'claude-plain', reasoning: true }
          ]
        }
      }
    }
  })
  configureLogging({
    level: 'debug',
    format: 'json',
    write: (line) => {
      const parsed: unknown = JSON.parse(line)
      if (!isRecord(parsed) || typeof parsed['message'] !== 'string') return
      if (!parsed['message'].startsWith('Dropped temperature')) return
      dropRecords.push({ level: String(parsed['level']), properties: parsed['properties'] })
    }
  })
})

beforeEach(() => {
  dropRecords.length = 0
})

afterAll(async () => {
  resetSync()
  vi.unstubAllEnvs()
  await mock.close()
  agentDir.remove()
})

/**
 * Asks a model with a temperature and returns the body of the request pi POSTed for it.
 *
 * @param model - the canonical model ID to request
 * @param temperature - the `temperature` the client sends
 * @returns the JSON body of the first upstream request with one
 * @throws Error when pi sent no request with a JSON object body
 */
async function sentBody(model: string, temperature: number): Promise<Record<string, unknown>> {
  const before = mock.requests.length
  await testApp().request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, temperature, messages: [{ role: 'user', content: 'Hi' }] })
  })
  // The Codex adapter tries a WebSocket first (a bodyless upgrade request), then POSTs.
  const posted = mock.requests.slice(before).find((request) => isRecord(request.body))
  if (posted === undefined || !isRecord(posted.body)) throw new Error('pi sent no request body')
  return posted.body
}

describe('temperature', () => {
  // Catches temperature sent to the Codex backend, which refuses the whole request over it; a drop
  // with no trace at the default log level; or an info line on every request of a client that
  // always sends one (the first per model is enough).
  test('is dropped for openai-codex-responses: logged at info once per model, then debug', async () => {
    const first = await sentBody('codex/codex-mock', TEMPERATURE)
    const second = await sentBody('codex/codex-mock', TEMPERATURE)

    expect([first['model'], second['model']]).toEqual(['codex-mock', 'codex-mock'])
    expect(first).not.toHaveProperty('temperature')
    expect(second).not.toHaveProperty('temperature')
    const properties = {
      temperature: TEMPERATURE,
      modelId: 'codex-mock',
      api: 'openai-codex-responses'
    }
    expect(dropRecords).toEqual([
      { level: 'INFO', properties: expect.objectContaining(properties) as unknown },
      { level: 'DEBUG', properties: expect.objectContaining(properties) as unknown }
    ])
  })

  // Catches the Codex exception spreading to APIs that accept temperature, and a falsy 0 lost on
  // the way (a truthiness check instead of `!== undefined`).
  test.each([TEMPERATURE, 0])('%s is sent to every other API', async (temperature) => {
    const body = await sentBody('completions/chat-mock', temperature)

    expect(body['temperature']).toBe(temperature)
    expect(dropRecords).toEqual([])
  })
})

describe('temperature on Claude (#147)', () => {
  // Catches pi's own drop going unreported: Claude 4.7 and later refuse a temperature below 1, so
  // pi leaves it out on models whose catalog entry says so, and the operator must see that it
  // never reached the provider.
  test('is left out by pi where the model does not accept it, and logged', async () => {
    const first = await sentBody('anthropic/claude-no-temperature', TEMPERATURE)
    const second = await sentBody('anthropic/claude-no-temperature', TEMPERATURE)

    expect(first).not.toHaveProperty('temperature')
    expect(second).not.toHaveProperty('temperature')
    const properties = {
      temperature: TEMPERATURE,
      modelId: 'claude-no-temperature',
      reason: 'pi does not send it, as the model does not accept it'
    }
    expect(dropRecords).toEqual([
      { level: 'INFO', properties: expect.objectContaining(properties) as unknown },
      { level: 'DEBUG', properties: expect.objectContaining(properties) as unknown }
    ])
  })

  // Catches the log claiming a drop that does not happen (thinking off, a model that takes it), or
  // missing the one that does (thinking on, which pi never sends a temperature with).
  test('is sent with thinking off, left out and logged with thinking on', async () => {
    const plain = await sentBody('anthropic/claude-plain', TEMPERATURE)
    expect(plain['temperature']).toBe(TEMPERATURE)
    expect(dropRecords).toEqual([])

    const before = mock.requests.length
    await testApp().request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'anthropic/claude-plain',
        temperature: TEMPERATURE,
        reasoning_effort: 'low',
        messages: [{ role: 'user', content: 'Hi' }]
      })
    })
    const thinking = mock.requests.at(before)?.body

    expect(isRecord(thinking) ? thinking['temperature'] : 'no body').toBeUndefined()
    expect(dropRecords).toEqual([
      {
        level: 'INFO',
        properties: expect.objectContaining({
          reason: 'pi does not send it, as thinking is on'
        }) as unknown
      }
    ])
  })
})
