/**
 * Record and replay, offline: the recorder sits between pi and the mock provider (standing in for
 * a real one), the recording is saved to a temp dir, and replaying it through the mock gives the
 * client the same answer. The live counterpart, `pnpm run test:live:record`, puts the same
 * recorder in front of a real provider.
 */

import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isRecord } from '@proxy/utils/guards'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'
import { listenOnLoopback } from '../fixtures/local-server'
import {
  finishChunk,
  type MockProvider,
  sse,
  startMockProvider,
  textChunks,
  toolCallChunks
} from '../fixtures/mock-provider'
import {
  type CapturedExchange,
  loadRecording,
  type Recorder,
  type Recording,
  replay,
  saveRecording,
  startRecorder
} from '../fixtures/recording'
import { testApp } from '../helpers'

const PROVIDER_KEY = 'notarealsecret-recorded-provider-key'
const HTTP_BAD_GATEWAY = 502

let upstream: MockProvider
let recorder: Recorder
let recordingsDir = ''
const agentDirs: FixtureAgentDir[] = []

beforeAll(async () => {
  upstream = await startMockProvider({
    'two-tools': sse([
      ...toolCallChunks(0, {
        id: 'call_a',
        name: 'get_weather',
        argumentParts: ['{"city":', '"Oslo"}']
      }),
      ...toolCallChunks(1, { id: 'call_b', name: 'get_time', argumentParts: ['{"zone":"CET"}'] }),
      finishChunk('tool_calls', { prompt_tokens: 9, completion_tokens: 4 })
    ]),
    // A provider that echoes the caller's credential back: the recording must refuse to keep it.
    'echo-key': (response, request) => {
      const key = request.headers.authorization ?? ''
      void sse([...textChunks(`you sent ${key}`), finishChunk('stop')])(response, request)
    },
    // Quota headers among identifying ones, as both subscriptions send them.
    'quota': sse([...textChunks('ok'), finishChunk('stop')], {
      headers: {
        'anthropic-ratelimit-unified-5h-utilization': '0.02',
        'anthropic-ratelimit-unified-status': 'allowed',
        'anthropic-organization-id': 'notarealsecret-organization',
        'x-codex-primary-used-percent': '7',
        'x-codex-plan-type': 'plus',
        'x-codex-turn-state': 'notarealsecret-turn-state',
        'set-cookie': 'session=notarealsecret-cookie'
      }
    })
  })
  recorder = await startRecorder(upstream.origin)
  recordingsDir = mkdtempSync(join(tmpdir(), 'pi-proxy-recordings-'))
})

afterEach(() => {
  vi.unstubAllEnvs()
})

afterAll(async () => {
  await recorder.close()
  await upstream.close()
  for (const agentDir of agentDirs) agentDir.remove()
  rmSync(recordingsDir, { recursive: true, force: true })
})

/**
 * Points pi at `baseUrl` as the openai-completions provider `rec`, serving `model`.
 *
 * @remarks
 * Loads a fresh fixture agent dir, removed in `afterAll`.
 *
 * @param baseUrl - the provider's base URL, `/v1` included
 * @param model - the one model ID the provider serves
 */
async function useProvider(baseUrl: string, model: string): Promise<void> {
  agentDirs.push(
    await loadFixtureAgentDir({
      modelsJson: {
        providers: {
          rec: { baseUrl, api: 'openai-completions', apiKey: PROVIDER_KEY, models: [{ id: model }] }
        }
      }
    })
  )
}

/**
 * Asks `rec/<model>` through the proxy, without streaming, and expects a 200.
 *
 * @param model - the model ID under provider `rec`
 * @returns the parsed chat completion body
 */
async function chat(model: string): Promise<unknown> {
  const response = await testApp().request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: `rec/${model}`, messages: [{ role: 'user', content: 'Hi' }] })
  })
  expect(response.status).toBe(200)
  return response.json()
}

/**
 * Wraps a captured exchange in the recording metadata for the `two-tools` model.
 *
 * @param exchange - the request and response the recorder captured
 * @param scenario - the scenario name the recording is saved under
 * @returns a recording with a fixed timestamp and `piVersion` `test`
 */
function named(exchange: CapturedExchange, scenario: string): Recording {
  return {
    version: 1,
    api: 'openai-completions',
    scenario,
    model: 'two-tools',
    recordedAt: '2026-10-16T00:00:00.000Z',
    piVersion: 'test',
    ...exchange
  }
}

/**
 * Builds a matcher for the parts of a completion that come from the provider.
 *
 * @remarks
 * Leaves out the request's id and clock fields, which differ between two runs.
 *
 * @param completion - the chat completion body to take `choices` and `usage` from
 * @returns an `expect.objectContaining` matcher for those two fields
 * @throws Error when `completion` is not an object
 */
function answer(completion: unknown): unknown {
  if (!isRecord(completion)) throw new Error('expected a chat completion object')
  return expect.objectContaining({ choices: completion['choices'], usage: completion['usage'] })
}

describe('record and replay', () => {
  // Catches a recording that does not reproduce what the client got: lost chunk boundaries, a
  // dropped event, or a changed status or content type.
  test('a saved recording, replayed, gives the client the same answer', async () => {
    await useProvider(`${recorder.baseUrl}/v1`, 'two-tools')
    const live = await chat('two-tools')
    const captured = recorder.exchanges.at(-1)
    if (captured === undefined) throw new Error('the recorder captured nothing')

    const path = saveRecording(
      named(captured.exchange, 'two-tools'),
      captured.secrets,
      recordingsDir
    )
    const saved = readFileSync(path, 'utf8')
    expect(saved).not.toContain(PROVIDER_KEY)
    expect(captured.exchange.request.headers).not.toHaveProperty('authorization')
    expect(captured.exchange.request.body).toMatchObject({ model: 'two-tools', stream: true })

    const replayer = await startMockProvider({
      'two-tools': replay(loadRecording('openai-completions', 'two-tools', recordingsDir))
    })
    try {
      await useProvider(`${replayer.origin}/v1`, 'two-tools')
      expect(await chat('two-tools')).toEqual(answer(live))
    } finally {
      await replayer.close()
    }
  })

  // Catches a credential reaching a committed fixture because a provider quoted it back.
  test('refuses to save a recording whose response contains the credential the request sent', async () => {
    await useProvider(`${recorder.baseUrl}/v1`, 'echo-key')
    await chat('echo-key')
    const captured = recorder.exchanges.at(-1)
    if (captured === undefined) throw new Error('the recorder captured nothing')

    expect(() =>
      saveRecording(named(captured.exchange, 'echo-key'), captured.secrets, recordingsDir)
    ).toThrow('contains a credential')
  })

  /**
   * Records one exchange and gives it a body that echoes an account ID in a field.
   *
   * @param field - the field, quoted as JSON
   * @param id - the account ID
   * @returns the exchange, and the secrets its request carried
   */
  async function echoing(
    field: string,
    id: string
  ): Promise<{ recording: Recording; secrets: readonly string[] }> {
    await useProvider(`${recorder.baseUrl}/v1`, 'two-tools')
    await chat('two-tools')
    const captured = recorder.exchanges.at(-1)
    if (captured === undefined) throw new Error('the recorder captured nothing')
    const response = { ...captured.exchange.response, chunks: [`data: {${field}:"${id}"}\n\n`] }
    return {
      recording: named({ ...captured.exchange, response }, 'account-id'),
      secrets: captured.secrets
    }
  }

  // Catches the ChatGPT user's ID reaching a committed fixture: OpenAI's Responses API echoes it
  // as `safety_identifier` in every response (#238).
  test('saves an echoed safety_identifier as user-redacted', async () => {
    const id = 'user-AbC123xyzAbC123xyz1234'
    const { recording, secrets } = await echoing('"safety_identifier"', id)

    const saved = readFileSync(saveRecording(recording, secrets, recordingsDir), 'utf8')

    expect(saved).not.toContain(id)
    expect(saved).toContain('user-redacted')
  })

  // Catches a user or organization ID in a field the recorder doesn't know being committed: a
  // provider that starts echoing one must stop the save, not slip past the known-field redaction.
  test.each([
    ['"owner"', 'user-AbC123xyzAbC123xyz1234'],
    ['"organization"', 'org-AbC123xyzAbC123xyz1234']
  ])('refuses %s holding %s', async (field, id) => {
    const { recording, secrets } = await echoing(field, id)

    expect(() => saveRecording(recording, secrets, recordingsDir)).toThrow('contains an account ID')
  })

  // Catches the quota headers lost on the way into a recording or out of a replay (the quota
  // tests replay them, #69), or an identifying header (organization, cookie, turn token) kept.
  test('keeps only the quota headers, and replay sends them back', async () => {
    await useProvider(`${recorder.baseUrl}/v1`, 'quota')
    await chat('quota')
    const captured = recorder.exchanges.at(-1)
    if (captured === undefined) throw new Error('the recorder captured nothing')
    const kept = {
      'anthropic-ratelimit-unified-5h-utilization': '0.02',
      'anthropic-ratelimit-unified-status': 'allowed',
      'x-codex-primary-used-percent': '7',
      'x-codex-plan-type': 'plus'
    }
    expect(captured.exchange.response.headers).toEqual(kept)

    const replayer = await startMockProvider({
      quota: replay(named(captured.exchange, 'quota'))
    })
    try {
      const replayed = await fetch(`${replayer.origin}/v1/chat/completions`, {
        method: 'POST',
        body: JSON.stringify({ model: 'quota' })
      })
      await replayed.body?.cancel()
      expect(
        Object.fromEntries(
          Object.keys(kept).map((headerName) => [headerName, replayed.headers.get(headerName)])
        )
      ).toEqual(kept)
    } finally {
      await replayer.close()
    }
  })
})

describe('recorder whose upstream cannot be reached', () => {
  // Catches an unreachable upstream recorded as an exchange (a fixture of the recorder's own
  // failure) or answered as anything a provider client would retry or take for a real answer.
  test('answers 502 with the reason and keeps no exchange', async () => {
    const unreachable = await closedOrigin()
    const deadEnd = await startRecorder(unreachable)
    try {
      const response = await fetch(`${deadEnd.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'two-tools', messages: [{ role: 'user', content: 'Hi' }] })
      })

      expect({
        status: response.status,
        contentType: response.headers.get('content-type'),
        text: await response.text(),
        exchanges: deadEnd.exchanges
      }).toEqual({
        status: HTTP_BAD_GATEWAY,
        contentType: 'text/plain',
        // The recorder's part of the message; the cause after it is Node's wording.
        text: expect.stringMatching(
          new RegExp(`^recorder could not reach ${unreachable.replaceAll('.', '\\.')}: .+`)
        ),
        exchanges: []
      })
    } finally {
      await deadEnd.close()
    }
  })

  // Catches a mid-stream upstream failure answered with a second status line, which threw
  // ERR_HTTP_HEADERS_SENT into an unhandled rejection and left pi waiting (#111): the response is
  // cut instead, as a dropped upstream looks, and no exchange is kept.
  test('cuts the response when the upstream fails after answering', async () => {
    const halfAnswer = createServer((request, response) => {
      request.resume()
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: {"partial":true}\n\n', () => {
        response.socket?.destroy()
      })
    })
    const cutRecorder = await startRecorder(await listenOnLoopback(halfAnswer))
    try {
      const response = await fetch(`${cutRecorder.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'any', messages: [] })
      })

      await expect(response.text()).rejects.toThrow()
      expect({ status: response.status, exchanges: cutRecorder.exchanges }).toEqual({
        status: 200,
        exchanges: []
      })
    } finally {
      await cutRecorder.close()
      halfAnswer.closeAllConnections()
      halfAnswer.close()
    }
  })
})

/**
 * Finds an origin nothing listens on: a port the OS just handed out, then released.
 *
 * @returns the origin, `http://127.0.0.1:<port>`
 */
async function closedOrigin(): Promise<string> {
  const server = createServer()
  const origin = await listenOnLoopback(server)
  server.close()
  await once(server, 'close')
  return origin
}
