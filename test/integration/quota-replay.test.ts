/**
 * Subscription quota from real traffic (#69): the `quota` recordings
 * (`test/fixtures/recordings/<api>/quota.json`, made by `pnpm run test:live:record`) are served
 * to pi's real provider clients, and the windows they carried reach `/healthz/creds`.
 *
 * Expected values are read from each recording's headers, not written out, so a re-recording
 * still tests the same thing; the clock is held at the recording's time, so its windows have not
 * reset yet.
 */

import { clearAllQuotas } from '@proxy/pi/quota'
import { isRecord } from '@proxy/utils/guards'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'
import { type MockProvider, startMockProvider } from '../fixtures/mock-provider'
import { loadRecording, type Recording, replay } from '../fixtures/recording'
import { testApp } from '../helpers'

const anthropic = loadRecording('anthropic-messages', 'quota')

/** Milliseconds per second, for the recordings' epoch-second reset times. */
const MS_PER_SECOND = 1000
/** The Anthropic windows' lengths, which its headers do not carry. */
const ANTHROPIC_WINDOW_MINUTES = { '5h': 300, '7d': 10_080 } as const

let mock: MockProvider
let agentDir: FixtureAgentDir

beforeAll(async () => {
  mock = await startMockProvider({ [anthropic.model]: replay(anthropic) })
  agentDir = await loadFixtureAgentDir({
    modelsJson: {
      providers: {
        recorded: { ...mock.provider('anthropic-messages'), models: [{ id: anthropic.model }] }
      }
    }
  })
})

afterEach(() => {
  clearAllQuotas()
  vi.useRealTimers()
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await mock.close()
  agentDir.remove()
})

/**
 * Reads one of a recording's response headers.
 *
 * @param recording - the recording
 * @param name - the header name
 * @returns its value
 * @throws Error when the recording lacks it: a re-recording that lost a quota header
 */
function header(recording: Recording, name: string): string {
  const value = recording.response.headers?.[name]
  if (value === undefined) throw new Error(`${recording.api}/quota has no ${name} header`)
  return value
}

/**
 * Asks `recorded/<model>` through the proxy at the recording's time, and reads the provider's
 * quota on `/healthz/creds`.
 *
 * @param recording - the recording the mock serves for its model
 * @returns the `quota` the `recorded` provider reports
 */
async function quotaAfterReplaying(recording: Recording): Promise<unknown> {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(recording.recordedAt))
  const response = await testApp().request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: `recorded/${recording.model}`,
      messages: [{ role: 'user', content: 'Reply with exactly: ok.' }]
    })
  })
  expect(response.status).toBe(200)
  await response.text()
  const body: unknown = await (await testApp().request('/healthz/creds')).json()
  const providers = isRecord(body) && Array.isArray(body['providers']) ? body['providers'] : []
  return providers.filter(isRecord).find((provider) => provider['provider'] === 'recorded')?.[
    'quota'
  ]
}

describe('quota from recorded subscription traffic', () => {
  // Catches pi's Anthropic client not handing the response headers on, or the real header set
  // (as opposed to the fixtures' copy of it) parsed differently: the windows Anthropic reported
  // are the ones /healthz/creds shows.
  test('Anthropic: the 5h and 7d windows it sent reach /healthz/creds', async () => {
    const window = (name: keyof typeof ANTHROPIC_WINDOW_MINUTES): Record<string, unknown> => ({
      name,
      used: Number(header(anthropic, `anthropic-ratelimit-unified-${name}-utilization`)),
      resetsAt: new Date(
        Number(header(anthropic, `anthropic-ratelimit-unified-${name}-reset`)) * MS_PER_SECOND
      ).toISOString(),
      windowMinutes: ANTHROPIC_WINDOW_MINUTES[name],
      status: header(anthropic, `anthropic-ratelimit-unified-${name}-status`)
    })

    expect(await quotaAfterReplaying(anthropic)).toEqual({
      observedAt: expect.any(String),
      status: header(anthropic, 'anthropic-ratelimit-unified-status'),
      plan: null,
      windows: [window('5h'), window('7d')]
    })
  })
})
