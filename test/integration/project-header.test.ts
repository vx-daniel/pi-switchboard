/**
 * `X-Switchboard-Project` (#366) end to end: with proxy auth on, a valid label reaches the
 * finished request and the route events the stats record; an invalid one is a 400 naming the
 * header; with auth off the label is ignored and the request still served.
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ServerConfig } from '@proxy/config/env'
import { finishedRequests } from '@proxy/server/active-requests'
import { createApp } from '@proxy/server/app'
import { onRouteTotalsChange, type RouteEvent } from '@proxy/server/route-totals'
import { fileConfigReader } from '@proxy/server/routes'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'
import {
  chunk,
  type MockProvider,
  sse,
  startMockProvider,
  textChunks
} from '../fixtures/mock-provider'
import { testConfig } from '../helpers'

const MOCK_KEY = 'notarealsecret-mock-provider-key'
const TOKEN = 'notarealsecret-proxy-token'

let mock: MockProvider
let agentDir: FixtureAgentDir

beforeAll(async () => {
  mock = await startMockProvider({ 'answer-mock': sse([...textChunks('ok'), chunk({}, 'stop')]) })
  agentDir = await loadFixtureAgentDir({
    modelsJson: {
      providers: {
        alpha: {
          baseUrl: `${mock.origin}/v1`,
          api: 'openai-completions',
          apiKey: MOCK_KEY,
          models: [{ id: 'answer-mock' }]
        }
      }
    }
  })
  writeFileSync(join(agentDir.path, 'proxy-config.json'), JSON.stringify({ port: 4141 }))
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await mock.close()
  agentDir.remove()
})

/**
 * Sends one chat request, as the client with the project header.
 *
 * @param auth - whether the proxy asks for a token (the request then sends it)
 * @param project - the header's value
 * @param requestId - the client's request ID, to find the request among those finished
 * @returns the response
 */
async function chat(auth: boolean, project: string, requestId: string): Promise<Response> {
  const config: ServerConfig = {
    ...testConfig(),
    proxyAuth: auth ? { kind: 'token', token: TOKEN } : { kind: 'off' }
  }
  return createApp(config, fileConfigReader).request('/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-switchboard-project': project,
      'x-client-request-id': requestId,
      ...(auth ? { authorization: `Bearer ${TOKEN}` } : {})
    },
    body: JSON.stringify({
      model: 'alpha/answer-mock',
      messages: [{ role: 'user', content: 'Hi' }]
    })
  })
}

/**
 * Finds a finished request's project by the proxy's request ID the response named.
 *
 * @param response - the response
 * @returns the project it was counted under; `undefined` when it isn't among those finished
 */
function projectOf(response: Response): string | null | undefined {
  const requestId = response.headers.get('x-request-id')
  return finishedRequests().find((request) => request.requestId === requestId)?.project
}

describe('the project header', () => {
  // Catches a label lost before the stats see it: the finished request and every route event of
  // its attempts carry the project the client sent.
  test('with proxy auth on, a label reaches the request and its route events', async () => {
    const events: RouteEvent[] = []
    const stop = onRouteTotalsChange((event) => events.push(event))

    const response = await chat(true, 'vx-daniel/pi-switchboard', 'labelled')
    await response.text()
    stop()

    expect(response.status).toBe(200)
    expect(projectOf(response)).toBe('vx-daniel/pi-switchboard')
    const keyed = events.flatMap((event) => (event.kind === 'cleared' ? [] : [event.key.project]))
    expect(keyed.length).toBeGreaterThan(0)
    expect(keyed.every((project) => project === 'vx-daniel/pi-switchboard')).toBe(true)
  })

  // Catches a label that isn't one cut, cleaned or silently dropped: it is refused, naming the
  // header, before the model is called.
  test.each(['', '-leading-dash', 'has space', 'x'.repeat(65)])(
    'with proxy auth on, refuses %j',
    async (label) => {
      const response = await chat(true, label, 'invalid')

      expect(response.status).toBe(400)
      expect(await response.text()).toContain('X-Switchboard-Project')
    }
  )

  // Catches a label trusted without a token, where any client could claim any project, or the
  // request refused for a header the proxy is ignoring.
  test('with proxy auth off, the label is ignored and the request served', async () => {
    const response = await chat(false, 'has space', 'ignored')
    await response.text()

    expect(response.status).toBe(200)
    expect(projectOf(response)).toBeNull()
  })
})
