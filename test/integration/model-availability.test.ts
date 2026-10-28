/**
 * `availability` on `/v1/switchboard/models` (#174): whether the proxy's login refused or answered
 * each model. The refusal is the Codex one from #156, through pi's real Codex adapter and the mock
 * provider.
 */

import { resetSync } from '@logtape/logtape'
import { configureLogging } from '@proxy/logging'
import { clearAvailability, noteAvailability } from '@proxy/pi/availability'
import { isRecord } from '@proxy/utils/guards'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'
import { FAKE_CODEX_TOKEN } from '../fixtures/codex-token'
import {
  cutOff,
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
 * Builds the app, with an alias to the refused model and a chain from it to one that answers.
 *
 * @returns the app
 */
const app = () =>
  testApp({
    ...testConfig(),
    aliases: {
      picky: 'codex/refused-model',
      chain: { targets: ['codex/refused-model', 'acme/ok-model'], fallbackOn: ['refused'] }
    }
  })

beforeAll(async () => {
  mock = await startMockProvider({
    'refused-model': sse([{ type: 'error', message: REFUSAL }]),
    'ok-model': sse([...textChunks('ok'), finishChunk('stop')]),
    'cut-model': cutOff('o')
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
          models: [{ id: 'ok-model' }, { id: 'cut-model' }]
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
 * @param headers - extra request headers
 */
async function ask(
  model: string,
  stream: boolean,
  headers: Record<string, string> = {}
): Promise<void> {
  const response = await app().request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ model, stream, messages: [{ role: 'user', content: 'Hi' }] })
  })
  await response.text()
}

/**
 * Counts the info lines that announce a model's refusal.
 *
 * @param model - the canonical ID
 * @returns how many
 */
function refusalLines(model: string): number {
  return infoLines.filter(
    (line) => line.includes('login refused') && line.includes(`"model":"${model}"`)
  ).length
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
      'cut-model': 'unknown',
      'picky': 'unknown',
      'chain': 'unknown'
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
      expect(refusalLines('codex/refused-model')).toBe(1)
    }
  )

  // Catches a model that answered left unknown.
  test.each([false, true])('is verified after a whole answer (stream %s)', async (stream) => {
    await ask('acme/ok-model', stream)

    expect(await availability()).toMatchObject({
      'ok-model': 'verified',
      'refused-model': 'unknown'
    })
  })

  // Catches a stream that started and then broke off counted as an answer: the model would show
  // as working though the client never got a whole reply.
  test('stays unknown after a stream cut off mid-answer', async () => {
    await ask('acme/cut-model', true)

    expect(await availability()).toMatchObject({ 'cut-model': 'unknown' })
  })

  // Catches a client's own key speaking for the shared login: its answer says nothing about the
  // plan of the login other clients use.
  test('records nothing for a request with its own upstream key', async () => {
    await ask('acme/ok-model', false, { 'X-Switchboard-Upstream-Api-Key': 'notarealsecret-own' })

    expect(await availability()).toMatchObject({ 'ok-model': 'unknown' })
  })

  // Catches the refusal logged on every refused request (log noise), or never again after the
  // plan changed and the model answered in between.
  test('logs a refusal once, and again only after the model was verified in between', () => {
    const model = 'codex/refused-model'
    noteAvailability(model, {}, 'refused')
    noteAvailability(model, {}, 'refused')
    expect(refusalLines(model)).toBe(1)

    noteAvailability(model, {}, 'answered')
    noteAvailability(model, {}, 'refused')
    expect(refusalLines(model)).toBe(2)
  })

  // Catches a fallback chain recording its outcome under the alias's first target only: the
  // refused model would hide the answer of the one after it, or take its `verified`. Not
  // streamed: the mock's refusal is an event inside a started stream, past falling back.
  test('records each model of a fallback chain under its own ID', async () => {
    await ask('chain', false)

    expect(await availability()).toMatchObject({
      'refused-model': 'refused',
      'ok-model': 'verified'
    })
  })
})
