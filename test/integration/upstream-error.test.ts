/**
 * A request whose upstream call fails, through pi's real provider and the mock provider: what the
 * client and the logs get. Provider error text can quote the request back (a prompt, a key, an
 * account), so it reaches the log at debug only and the client never; a failure after a stream has
 * started is in `test/unit/sse.test.ts`.
 */

import { resetSync } from '@logtape/logtape'
import { configureLogging } from '@proxy/logging'
import { isRecord } from '@proxy/utils/guards'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'
import { httpError, type MockProvider, startMockProvider } from '../fixtures/mock-provider'
import { testApp } from '../helpers'

/** What the provider quotes back in its error. */
const QUOTED = 'notarealsecret-quoted-by-provider'
const BELOW_DEFAULT_LEVEL = new Set(['TRACE', 'DEBUG'])

let mock: MockProvider
let agentDir: FixtureAgentDir
let records: { level: string; logger: string; line: string }[] = []

beforeAll(async () => {
  mock = await startMockProvider({
    // A 400 is not retried, so the request fails at once.
    rejecting: httpError(400, {
      error: { message: `Invalid request: the prompt "${QUOTED}" is not allowed`, type: 'invalid' }
    })
  })
  agentDir = await loadFixtureAgentDir({ modelsJson: { providers: { mock: mock.provider() } } })
})

beforeEach(() => {
  records = []
  configureLogging({
    level: 'trace',
    format: 'json',
    write: (line) => {
      const parsed: unknown = JSON.parse(line)
      const field = (name: string): string =>
        isRecord(parsed) && typeof parsed[name] === 'string' ? parsed[name] : ''
      records.push({ level: field('level'), logger: field('logger'), line })
    }
  })
})

afterAll(async () => {
  resetSync()
  vi.unstubAllEnvs()
  await mock.close()
  agentDir.remove()
})

describe('a failed non-streaming upstream call', () => {
  // Catches the provider's error text reaching the client, or a default-level log line, while the
  // failure itself goes unreported; and the detail being lost for whoever turns debug on. A 400 is
  // the provider refusing the client's own request (#147): OpenAI's client error, and a warning.
  test('answers with a fixed error, logs the failure, and keeps the provider text at debug', async () => {
    const response = await testApp().request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'mock/rejecting', messages: [{ role: 'user', content: 'Hi' }] })
    })
    const text = await response.text()

    expect(response.status).toBe(400)
    expect(JSON.parse(text)).toEqual({
      error: {
        message:
          'The provider rejected the request as invalid. Check the fields this model accepts.',
        type: 'invalid_request_error',
        param: null,
        code: 'upstream_invalid_request'
      }
    })
    expect(text).not.toContain(QUOTED)

    const atDefaultLevel = records.filter((record) => !BELOW_DEFAULT_LEVEL.has(record.level))
    // The upstream call's own warning (complete.ts) and the route's warning (routes.ts).
    expect(atDefaultLevel.map((record) => [record.logger, record.level])).toEqual(
      expect.arrayContaining([
        ['pi-switchboard.pi.complete', 'WARN'],
        ['pi-switchboard.server.chat', 'WARN']
      ])
    )
    expect(atDefaultLevel.some((record) => record.level === 'ERROR')).toBe(false)
    for (const record of atDefaultLevel) expect(record.line).not.toContain(QUOTED)
    expect(records.some((record) => record.level === 'DEBUG' && record.line.includes(QUOTED))).toBe(
      true
    )
  })
})

describe('a failed streaming upstream call, before its first event', () => {
  // Catches the streaming branch mapping the provider's refusal apart from the non-streaming one:
  // a stream is not answered until pi's first event, so the refusal must get the same 400 and
  // body, not a 502 or an SSE error frame, and never the provider's text (#147).
  test('answers with the same 400 as a non-streaming request', async () => {
    const response = await testApp().request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mock/rejecting',
        stream: true,
        messages: [{ role: 'user', content: 'Hi' }]
      })
    })
    const text = await response.text()

    expect(response.status).toBe(400)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(JSON.parse(text)).toMatchObject({ error: { code: 'upstream_invalid_request' } })
    expect(text).not.toContain(QUOTED)
  })
})
