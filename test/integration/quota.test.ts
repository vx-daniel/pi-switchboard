/**
 * Subscription quota end to end (#69): a provider's response headers reach `/healthz/creds` and
 * `/v1/switchboard/models`. The mock sends the header sets a live probe got
 * (`test/fixtures/quota-headers.ts`), through pi's OpenAI chat completions adapter.
 */

import { clearAllQuotas } from '@proxy/pi/quota'
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
import { testApp } from '../helpers'

let mock: MockProvider
let agentDir: FixtureAgentDir

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
// the windows would reset, and drop out of the views, from 2026-10-22 on.
beforeEach(() => {
  clearAllQuotas()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-21T22:34:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await mock.close()
  agentDir.remove()
})

/**
 * Asks a model to say ok.
 *
 * @param model - the public model ID
 * @param headers - extra request headers
 * @returns the response status
 */
async function ask(model: string, headers: Record<string, string> = {}): Promise<number> {
  const response = await testApp().request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Say ok' }] })
  })
  await response.text()
  return response.status
}

/**
 * Reads a JSON route's list field as records.
 *
 * @param path - the route
 * @param field - the list field
 * @returns its records
 */
async function listOf(path: string, field: string): Promise<Record<string, unknown>[]> {
  const body: unknown = await (await testApp().request(path)).json()
  const list = isRecord(body) ? body[field] : undefined
  return Array.isArray(list) ? list.filter(isRecord) : []
}

/**
 * Reads each provider's `quota` on `/healthz/creds`.
 *
 * @returns provider -> quota
 */
async function credsQuota(): Promise<Map<unknown, unknown>> {
  const providers = await listOf('/healthz/creds', 'providers')
  return new Map(providers.map((provider) => [provider['provider'], provider['quota']]))
}

/**
 * Reads each model's `quota` on `/v1/switchboard/models`.
 *
 * @returns model ID -> quota
 */
async function modelsQuota(): Promise<Map<unknown, unknown>> {
  const models = await listOf('/v1/switchboard/models', 'data')
  return new Map(models.map((listed) => [listed['id'], listed['quota']]))
}

describe('quota from response headers', () => {
  // Catches the headers never reaching the store, or either view not showing them: after one
  // call, the provider's windows are on both, in each view's own units.
  test('shows on /healthz/creds and /v1/switchboard/models after a call', async () => {
    expect(await ask('subscribed-mock')).toBe(200)

    expect((await credsQuota()).get('subscribed')).toEqual({
      observedAt: expect.any(String),
      status: 'allowed',
      plan: null,
      windows: [
        {
          name: '5h',
          used: 0,
          resetsAt: '2026-10-22T03:30:00.000Z',
          windowMinutes: 300,
          status: 'allowed'
        },
        {
          name: '7d',
          used: 0.47,
          resetsAt: '2026-10-25T02:00:00.000Z',
          windowMinutes: 10_080,
          status: 'allowed'
        }
      ]
    })
    expect((await modelsQuota()).get('subscribed-mock')).toMatchObject({
      status: 'allowed',
      windows: [
        { name: '5h', used: 0, resets_at: 1_792_639_800, window_minutes: 300 },
        { name: '7d', used: 0.47, resets_at: 1_792_893_600, window_minutes: 10_080 }
      ]
    })
  })

  // Catches zeros made up for a provider that sends no quota headers, or one provider's quota
  // shown on another's models.
  test('a provider that reports none shows none', async () => {
    await ask('subscribed-mock')
    await ask('keyed-mock')

    expect((await credsQuota()).get('keyed')).toBeNull()
    expect((await modelsQuota()).get('keyed-mock')).toBeNull()
  })

  // Catches a client's own key reporting its account's quota as the shared login's.
  test('a request with its own upstream key records nothing', async () => {
    await ask('subscribed-mock', { 'X-Switchboard-Upstream-Api-Key': 'notarealsecret-client-key' })

    expect((await credsQuota()).get('subscribed')).toBeNull()
  })

  // Catches an identifying header reaching a view: the org and workspace IDs the provider sent
  // appear on neither.
  test('no account ID reaches either view', async () => {
    await ask('subscribed-mock')

    for (const path of ['/healthz/creds', '/v1/switchboard/models']) {
      const text = await (await testApp().request(path)).text()
      expect(text).not.toContain('notarealsecret')
    }
  })
})
