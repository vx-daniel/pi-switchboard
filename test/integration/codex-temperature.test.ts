/**
 * `temperature` on the Codex backend (#49): it rejects the parameter ("Unsupported parameter:
 * temperature"), though pi 1.3.0 forwards it, so the proxy drops it for `openai-codex-responses`
 * and says so at info. Every other API gets it.
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

/** A JWT segment: base64url JSON. */
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
  mock = await startMockProvider({ 'codex-mock': answer, 'chat-mock': answer })
  agentDir = await loadFixtureAgentDir({
    modelsJson: {
      providers: {
        codex: {
          baseUrl: mock.origin,
          api: 'openai-codex-responses',
          apiKey: FAKE_CODEX_TOKEN,
          models: [{ id: 'codex-mock' }]
        },
        completions: { ...mock.provider(), models: [{ id: 'chat-mock' }] }
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

/** Ask `model` with this temperature, and return the body of the request pi POSTed for it. */
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
