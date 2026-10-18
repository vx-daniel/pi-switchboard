/**
 * OpenAI's `user` on Anthropic, through pi's real Anthropic client: Anthropic takes it as
 * `metadata.user_id`, its only metadata key, so the client's own `metadata` never reaches it
 * (#48).
 */

import { isRecord } from '@proxy/utils/guards'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'
import {
  finishChunk,
  type MockProvider,
  sse,
  startMockProvider,
  textChunks
} from '../fixtures/mock-provider'
import { testApp } from '../helpers'

const MOCK_KEY = 'notarealsecret-mock-provider-key'

let mock: MockProvider
let agentDir: FixtureAgentDir

beforeAll(async () => {
  mock = await startMockProvider({ 'claude-mock': sse([...textChunks('ok'), finishChunk('stop')]) })
  agentDir = await loadFixtureAgentDir({
    modelsJson: {
      providers: {
        anthropic: {
          baseUrl: mock.origin,
          api: 'anthropic-messages',
          apiKey: MOCK_KEY,
          models: [{ id: 'claude-mock' }]
        }
      }
    }
  })
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await mock.close()
  agentDir.remove()
})

/** Send these extra request fields, and return the body pi sent upstream. */
async function sentBody(fields: Record<string, unknown>): Promise<Record<string, unknown>> {
  const before = mock.requests.length
  await testApp().request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'anthropic/claude-mock',
      messages: [{ role: 'user', content: 'Hi' }],
      ...fields
    })
  })
  expect(mock.requests).toHaveLength(before + 1)
  const body = mock.requests.at(-1)?.body
  if (!isRecord(body)) throw new Error('pi sent no request body')
  return body
}

describe('user on anthropic-messages', () => {
  // Catches user lost on the way, or the client's own metadata keys sent along with it, which
  // Anthropic would refuse.
  test('is metadata.user_id, with no other metadata key', async () => {
    const body = await sentBody({ user: 'user-123', metadata: { task: 'triage' } })

    expect(body['metadata']).toEqual({ user_id: 'user-123' })
  })

  // Catches an empty or partial metadata object sent for a request that has no user.
  test('without one, no metadata is sent', async () => {
    const body = await sentBody({ metadata: { task: 'triage' } })

    expect(body).not.toHaveProperty('metadata')
  })
})
