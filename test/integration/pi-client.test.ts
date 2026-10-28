/**
 * pi as a client of the proxy (#197): pi's own OpenAI chat completions adapter, pointed at the
 * switchboard as a `models.json` provider would be, gets an answer. pi sends fields of its own to a
 * host it takes for OpenAI (`store: false` today); a pi upgrade that adds one the proxy refuses
 * fails here, before a user meets the 422.
 */

import type { Model } from '@earendil-works/pi-ai'
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import type { ProxyEnv } from '@proxy/server/types'
import { isRecord } from '@proxy/utils/guards'
import type { Hono } from 'hono'
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

/** Where pi thinks the proxy is; requests go to the app in process, never to this host. */
const PROXY_BASE_URL = 'http://switchboard.test/v1'

let app: Hono<ProxyEnv>
let agentDir: FixtureAgentDir
let mock: MockProvider

beforeAll(async () => {
  mock = await startMockProvider({ echo: sse([...textChunks('ok'), finishChunk('stop')]) })
  agentDir = await loadFixtureAgentDir({ modelsJson: { providers: { mock: mock.provider() } } })
  app = testApp()
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await mock.close()
  agentDir.remove()
})

/** The proxy's model as pi sees it in a `models.json` provider pointing at the switchboard. */
const SWITCHBOARD_MODEL: Model<'openai-completions'> = {
  id: 'mock/echo',
  name: 'mock/echo',
  api: 'openai-completions',
  provider: 'switchboard',
  baseUrl: PROXY_BASE_URL,
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096
}

describe("pi's OpenAI adapter as a client (#197)", () => {
  // Catches the proxy refusing a field pi adds to every request for this host: every request from
  // pi would fail with a 422, as `store: false` did before #197.
  test('gets an answer, with pi sending store: false', async () => {
    const sent: unknown[] = []
    const events = streamSimple(
      SWITCHBOARD_MODEL,
      // What pi's ModelRuntime hands an API: the transcript normalized.
      normalizeContext({ messages: [{ role: 'user', content: 'Hi', timestamp: Date.now() }] }),
      {
        apiKey: 'notarealsecret-pi-client',
        fetch: async (input: string | URL | Request, init?: RequestInit) => {
          const request = new Request(input, init)
          sent.push(await request.clone().json())
          return app.fetch(request)
        }
      }
    )
    const answer = await events.result()

    expect(answer.stopReason).toBe('stop')
    expect(answer.content).toEqual([{ type: 'text', text: 'ok' }])
    const [body] = sent
    expect(isRecord(body) ? body['store'] : undefined).toBe(false)
  })
})
