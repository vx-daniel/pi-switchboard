/**
 * A fallback chain keeping a provider's quota in reserve, end to end (#69): a provider's response
 * headers report its quota, and a chain then skips it while it has less than `routing.reserve`
 * left. The mock sends the header set a live probe got (`test/fixtures/quota-headers.ts`): 47% of
 * the 7-day window used, so 53% left.
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { resetSync } from '@logtape/logtape'
import { configureLogging } from '@proxy/logging'
import { clearAllCooldowns } from '@proxy/pi/cooldowns'
import { clearAllQuotas } from '@proxy/pi/quota'
import { createApp } from '@proxy/server/app'
import { fileConfigReader } from '@proxy/server/routes'
import { isRecord } from '@proxy/utils/guards'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi
} from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'
import {
  finishChunk,
  type MockProvider,
  sse,
  startMockProvider,
  textChunks
} from '../fixtures/mock-provider'
import { ANTHROPIC_QUOTA_HEADERS } from '../fixtures/quota-headers'
import { testConfig } from '../helpers'

/** The chain: the subscribed provider first, a provider that reports no quota second. */
const CHAIN = {
  targets: ['subscribed/subscribed-mock', 'keyed/keyed-mock'],
  fallbackOn: ['rate_limit']
}

let mock: MockProvider
let agentDir: FixtureAgentDir
let chatRecords: Record<string, unknown>[] = []

beforeAll(async () => {
  const chunks = [...textChunks('ok'), finishChunk('stop')]
  mock = await startMockProvider({
    'subscribed-mock': sse(chunks, { headers: ANTHROPIC_QUOTA_HEADERS }),
    'keyed-mock': sse(chunks)
  })
  const provider = (modelId: string): Record<string, unknown> => ({
    ...mock.provider(),
    models: [{ id: modelId }]
  })
  agentDir = await loadFixtureAgentDir({
    modelsJson: {
      providers: { subscribed: provider('subscribed-mock'), keyed: provider('keyed-mock') }
    }
  })
})

// The recorded reset times are real, so the clock is held at the probe's time: on the real clock
// the windows would reset, and stop counting, from 2026-10-22 on.
beforeEach(() => {
  clearAllQuotas()
  clearAllCooldowns()
  chatRecords = []
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-21T22:34:00Z'))
  configureLogging({
    level: 'info',
    format: 'json',
    write: (line) => {
      const parsed: unknown = JSON.parse(line)
      if (isRecord(parsed) && parsed['logger'] === 'pi-switchboard.server.chat') {
        chatRecords.push(parsed)
      }
    }
  })
})

afterEach(() => {
  vi.useRealTimers()
})

afterAll(async () => {
  resetSync()
  vi.unstubAllEnvs()
  await mock.close()
  agentDir.remove()
})

/**
 * Writes the proxy's config file: the chain as `coding`, and these reserves.
 *
 * @param reserve - provider -> the share to keep free
 */
function configure(reserve: Record<string, number>): void {
  writeFileSync(
    join(agentDir.path, 'proxy-config.json'),
    JSON.stringify({ aliases: { coding: CHAIN }, routing: { reserve } })
  )
}

/**
 * Sends one chat request and records which models the upstream was asked for.
 *
 * @param model - the request's `model`
 * @returns the status, the parsed body, and the upstream models in call order
 */
async function ask(model: string): Promise<{ status: number; body: unknown; upstream: unknown[] }> {
  const before = mock.requests.length
  const response = await createApp(testConfig(), fileConfigReader).request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Say ok' }] })
  })
  const body: unknown = await response.json()
  const upstream = mock.requests
    .slice(before)
    .map((request) => (isRecord(request.body) ? request.body['model'] : undefined))
  return { status: response.status, body, upstream }
}

/**
 * Reads a response's `x_pi.attempts`.
 *
 * @param body - the parsed response body
 * @returns the attempts, or `undefined` when there are none
 */
function attemptsOf(body: unknown): unknown {
  const piFields = isRecord(body) ? body['x_pi'] : undefined
  return isRecord(piFields) ? piFields['attempts'] : undefined
}

describe('the quota reserve', () => {
  // Catches the reserve never acting, or acting without telling: once the provider reported 53%
  // left, a chain with a 60% reserve skips it without calling it, lists the skip in
  // `x_pi.attempts`, and logs it at info with the provider, window and share left.
  test('a chain skips a provider below its reserve, reported in x_pi and the log', async () => {
    configure({ subscribed: 0.6 })
    expect((await ask('subscribed-mock')).status).toBe(200)

    const answer = await ask('coding')

    expect(answer.status).toBe(200)
    expect(answer.upstream).toEqual(['keyed-mock'])
    expect(answer.body).toMatchObject({ model: 'keyed/keyed-mock' })
    expect(attemptsOf(answer.body)).toEqual([
      { model: 'subscribed/subscribed-mock', reason: 'quota', skipped: true }
    ])
    expect(chatRecords).toContainEqual(
      expect.objectContaining({
        level: 'INFO',
        properties: expect.objectContaining({
          alias: 'coding',
          model: 'subscribed/subscribed-mock',
          provider: 'subscribed',
          window: '7d',
          left: 0.53,
          reserve: 0.6
        })
      })
    )
  })

  // Catches a reserve reaching past chains: a request that names the model is always sent, and a
  // provider above its reserve, or one with none set, is called first as before.
  test('a named model, a provider above its reserve, or one without a reserve are called', async () => {
    configure({ subscribed: 0.6 })
    await ask('subscribed-mock')
    expect((await ask('subscribed-mock')).upstream).toEqual(['subscribed-mock'])

    configure({ subscribed: 0.5 })
    expect((await ask('coding')).upstream).toEqual(['subscribed-mock'])

    configure({})
    expect((await ask('coding')).upstream).toEqual(['subscribed-mock'])
  })

  // Catches a reserve applied before the provider reported anything: with no quota known, the
  // chain calls it.
  test('a provider that has reported no quota yet is called', async () => {
    configure({ subscribed: 0.99 })

    expect((await ask('coding')).upstream).toEqual(['subscribed-mock'])
  })
})
