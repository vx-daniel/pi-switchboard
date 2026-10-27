/**
 * `availability` on `/v1/switchboard/models` (#174): whether the proxy's login refused or answered
 * each model. The refusal is the Codex one from #156, through pi's real Codex adapter and the mock
 * provider.
 */

import { resetSync } from '@logtape/logtape'
import { configureLogging } from '@proxy/logging'
import { clearAvailability } from '@proxy/pi/availability'
import { isRecord } from '@proxy/utils/guards'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'
import { FAKE_CODEX_TOKEN } from '../fixtures/codex-token'
import {
  finishChunk,
  type MockProvider,
  sse,
  startMockProvider,
  textChunks
} from '../fixtures/mock-provider'
import { testApp, testConfig } from '../helpers'

/** What Codex answered for a model the ChatGPT login's plan does not include (#156). */
const REFUSAL =
  "The 'refused-model' model is not supported when using Codex with a ChatGPT account."

let mock: MockProvider
let agentDir: FixtureAgentDir
/** The info lines a request causes. */
let infoLines: string[] = []

/**
 * Builds the app, with an alias to the refused model.
 *
 * @returns the app
 */
const app = () => testApp({ ...testConfig(), aliases: { picky: 'codex/refused-model' } })

beforeAll(async () => {
  mock = await startMockProvider({
    'refused-model': sse([{ type: 'error', message: REFUSAL }]),
    'ok-model': sse([...textChunks('ok'), finishChunk('stop')])
  })
  agentDir = await loadFixtureAgentDir({
    modelsJson: {
      providers: {
        codex: {
          baseUrl: mock.origin,
          api: 'openai-codex-responses',
          apiKey: FAKE_CODEX_TOKEN,
          models: [{ id: 'refused-model' }]
        },
        acme: {
          baseUrl: mock.origin,
          api: 'openai-completions',
          apiKey: 'test-key',
          models: [{ id: 'ok-model' }]
        }
      }
    }
  })
})

beforeEach(() => {
  clearAvailability()
  infoLines = []
  configureLogging({
    level: 'info',
    format: 'json',
    write: (line) => {
      const parsed: unknown = JSON.parse(line)
      if (isRecord(parsed) && parsed['level'] === 'INFO') infoLines.push(line)
    }
  })
})

afterAll(async () => {
  resetSync()
  vi.unstubAllEnvs()
  await mock.close()
  agentDir.remove()
})

/**
 * Asks a model, reading the whole answer.
 *
 * @param model - the model to ask
 * @param stream - whether to ask for a stream
 */
async function ask(model: string, stream: boolean): Promise<void> {
  const response = await app().request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, stream, messages: [{ role: 'user', content: 'Hi' }] })
  })
  await response.text()
}

/**
 * Reads each entry's `availability` from `/v1/switchboard/models`.
 *
 * @returns the availability by public ID
 */
async function availability(): Promise<Record<string, unknown>> {
  const body: unknown = await (await app().request('/v1/switchboard/models')).json()
  const data = isRecord(body) && Array.isArray(body['data']) ? body['data'] : []
  const entries = data.flatMap((listed: unknown) =>
    isRecord(listed) && typeof listed['id'] === 'string'
      ? [[listed['id'], listed['availability']] as const]
      : []
  )
  return Object.fromEntries(entries)
}

describe('availability on /v1/switchboard/models (#174)', () => {
  // Catches a client told nothing before any call, or told a model works that was never tried.
  test('is unknown before any call', async () => {
    expect(await availability()).toEqual({
      'refused-model': 'unknown',
      'ok-model': 'unknown',
      'picky': 'unknown'
    })
  })

  // Catches a client that keeps picking a model the login refuses, for itself and its alias, and
  // the operator never told which model it is, or told on every request.
  test.each([false, true])(
    'is refused after the login refuses it (stream %s), logged once',
    async (stream) => {
      await ask('codex/refused-model', stream)
      await ask('picky', stream)

      expect(await availability()).toMatchObject({
        'refused-model': 'refused',
        'picky': 'refused',
        'ok-model': 'unknown'
      })
      // The route's own line per request names the requested model; the refusal's does not.
      const refusals = infoLines.filter(
        (line) => line.includes('codex/refused-model') && !line.includes('requestedModel')
      )
      expect(refusals).toHaveLength(1)
    }
  )

  // Catches a model that answered left unknown, or a started stream that later failed counted as
  // an answer.
  test.each([false, true])('is verified after a whole answer (stream %s)', async (stream) => {
    await ask('acme/ok-model', stream)

    expect(await availability()).toMatchObject({
      'ok-model': 'verified',
      'refused-model': 'unknown'
    })
  })
})
