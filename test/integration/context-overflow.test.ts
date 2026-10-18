/**
 * The context-overflow paths that are not an upstream error status (#40): a provider that accepts
 * an over-long prompt and answers anyway, and a client that leaves while the proxy waits for the
 * provider to accept a streaming request. Overflows the provider reports are in
 * `upstream-status.test.ts`.
 */

import { resetSync } from '@logtape/logtape'
import { configureLogging } from '@proxy/logging'
import { isRecord } from '@proxy/utils/guards'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'
import {
  finishChunk,
  type MockProvider,
  silent,
  sse,
  startMockProvider,
  textChunks
} from '../fixtures/mock-provider'
import { testApp } from '../helpers'

const HTTP_OK = 200
/** A context window the mock's reported usage overflows. */
const CONTEXT_WINDOW = 1000
const REPORTED_INPUT_TOKENS = 5000
/** Long enough for the request to reach the provider before the client leaves. */
const LEAVE_AFTER_MS = 200

let mock: MockProvider
let agentDir: FixtureAgentDir
/** Every JSON log line written: level and message. */
const records: { level: string; message: string }[] = []

beforeAll(async () => {
  mock = await startMockProvider({
    truncating: sse([
      ...textChunks('An answer'),
      finishChunk('stop', { prompt_tokens: REPORTED_INPUT_TOKENS, completion_tokens: 3 })
    ]),
    unresponsive: silent()
  })
  const provider = {
    ...mock.provider(),
    models: [
      { id: 'truncating', contextWindow: CONTEXT_WINDOW },
      { id: 'unresponsive', contextWindow: CONTEXT_WINDOW }
    ]
  }
  agentDir = await loadFixtureAgentDir({ modelsJson: { providers: { mock: provider } } })
  configureLogging({
    level: 'debug',
    format: 'json',
    write: (line) => {
      const parsed: unknown = JSON.parse(line)
      const field = (name: string): string =>
        isRecord(parsed) && typeof parsed[name] === 'string' ? parsed[name] : ''
      records.push({ level: field('level'), message: field('message') })
    }
  })
})

beforeEach(() => {
  records.length = 0
})

afterAll(async () => {
  resetSync()
  vi.unstubAllEnvs()
  await mock.close()
  agentDir.remove()
})

describe('a provider that answers an over-long prompt anyway', () => {
  // Catches a silent overflow either turned into an error (the client did get an answer) or not
  // reported at all: the operator must learn the model did not see the whole conversation.
  test('the answer goes to the client, and a warning names the overflow', async () => {
    const response = await testApp().request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mock/truncating',
        messages: [{ role: 'user', content: 'Hi' }]
      })
    })
    const body: unknown = await response.json()

    expect(response.status).toBe(HTTP_OK)
    expect(body).toMatchObject({
      choices: [{ message: { content: 'An answer' }, finish_reason: 'stop' }]
    })
    await vi.waitFor(() => {
      expect(records).toContainEqual({
        level: 'WARN',
        message: `Upstream call to "truncating" looks like a silent context overflow: ${String(REPORTED_INPUT_TOKENS)} input tokens for a ${String(CONTEXT_WINDOW)}-token window`
      })
    })
  })
})

describe('a client that leaves before the stream starts', () => {
  // Catches the wait for the provider's first event treating the client's own departure as an
  // upstream failure: an error-level log of a 502 for a request nobody is waiting on.
  test('is not reported as an upstream failure', async () => {
    const response = await testApp().request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mock/unresponsive',
        stream: true,
        messages: [{ role: 'user', content: 'Hi' }]
      }),
      signal: AbortSignal.timeout(LEAVE_AFTER_MS)
    })

    expect(response.headers.get('content-type')).not.toBe('text/event-stream')
    await vi.waitFor(() => {
      expect(
        records.some(
          (record) =>
            record.level === 'DEBUG' &&
            record.message.startsWith('Client left before the stream started')
        )
      ).toBe(true)
    })
    expect(records.filter((record) => record.level === 'ERROR')).toEqual([])
  })
})
