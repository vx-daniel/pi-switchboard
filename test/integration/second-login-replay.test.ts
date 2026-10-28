/**
 * A second login, against real traffic (#233): `anthropic-messages/second-login` was recorded
 * through `anthropic-2`, a login slot, by the proxy's own copy of pi's Anthropic provider
 * (`src/pi/account-provider.ts`), and Anthropic answered it. Replayed here, the proxy's request
 * for a model put on that login must carry the login's own token and be shaped exactly as the one
 * Anthropic accepted: the same headers (the Claude Code ones an OAuth token needs) and the same
 * system prompt.
 *
 * Expected values come from the recording, so a re-recording tests the same thing. The tokens are
 * fakes; nothing here calls Anthropic.
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createApp } from '@proxy/server/app'
import { fileConfigReader } from '@proxy/server/routes'
import { isRecord } from '@proxy/utils/guards'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'
import { type MockProvider, startMockProvider } from '../fixtures/mock-provider'
import { loadRecording, replay } from '../fixtures/recording'
import { testConfig } from '../helpers'

const recording = loadRecording('anthropic-messages', 'second-login')

/** The base login's fake OAuth access token. */
const BASE_TOKEN = 'sk-ant-oat01-notarealsecret-base-login'
/** The second login's fake OAuth access token. */
const SECOND_TOKEN = 'sk-ant-oat01-notarealsecret-second-login'
/** How long the fake logins stay valid: past any test, so pi never refreshes them. */
const LOGIN_LIFETIME_MS = 3_600_000

let mock: MockProvider
let agentDir: FixtureAgentDir

/**
 * Builds a fake Anthropic OAuth login.
 *
 * @param access - its access token
 * @returns the auth.json entry
 */
function oauthLogin(access: string): Record<string, unknown> {
  return {
    type: 'oauth',
    access,
    refresh: 'notarealsecret-refresh',
    expires: Date.now() + LOGIN_LIFETIME_MS
  }
}

beforeAll(async () => {
  mock = await startMockProvider({ [recording.model]: replay(recording) })
  agentDir = await loadFixtureAgentDir({
    // The base's entry and the slot's: the slot's composes above the proxy's copy.
    modelsJson: {
      providers: { 'anthropic': { baseUrl: mock.origin }, 'anthropic-2': { baseUrl: mock.origin } }
    },
    authJson: { 'anthropic': oauthLogin(BASE_TOKEN), 'anthropic-2': oauthLogin(SECOND_TOKEN) }
  })
  writeFileSync(
    join(agentDir.path, 'proxy-config.json'),
    JSON.stringify({ routing: { logins: { order: { anthropic: ['anthropic-2'] } } } })
  )
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await mock.close()
  agentDir.remove()
})

describe('a second login, replayed from real traffic (#233)', () => {
  // Catches the copy sending the base login's token (billing the wrong account), or a request
  // shaped unlike the one Anthropic accepted from a second login: a missing Claude Code header or
  // system prompt, which Anthropic refuses for an OAuth token.
  test("sends the second login's own token, shaped as the request Anthropic accepted", async () => {
    const response = await createApp(testConfig(), fileConfigReader).request(
      '/v1/chat/completions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: `anthropic/${recording.model}`,
          messages: [{ role: 'user', content: 'Replayed' }]
        })
      }
    )
    const body: unknown = await response.json()
    const upstream = mock.requests.at(-1)

    expect(response.status).toBe(200)
    expect(isRecord(body) ? body['x_pi'] : undefined).toMatchObject({ login: 'anthropic-2' })
    expect(upstream?.headers.authorization).toBe(`Bearer ${SECOND_TOKEN}`)
    for (const [header, recordedValue] of Object.entries(recording.request.headers)) {
      expect({ [header]: upstream?.headers[header] }).toEqual({ [header]: recordedValue })
    }
    const recorded = isRecord(recording.request.body) ? recording.request.body : {}
    const sent = isRecord(upstream?.body) ? upstream.body : {}
    expect(sent['system']).toEqual(recorded['system'])
  })
})
