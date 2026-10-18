/**
 * `scoped` model exposure end to end (#46): pi's `enabledModels` setting is read from the agent
 * dir's `settings.json` by the proxy's real config reader, and its patterns are resolved as pi
 * resolves them. Before #46 only exact `provider/id` entries matched; a settings file of patterns
 * left `/v1/models` empty.
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createApp } from '@proxy/server/app'
import { fileConfigReader } from '@proxy/server/routes'
import type { ProxyEnv } from '@proxy/server/types'
import { isRecord } from '@proxy/utils/guards'
import type { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir, offlineProvider } from '../fixtures/agent-dir'
import { testConfig } from '../helpers'

const HTTP_OK = 200
const HTTP_SERVICE_UNAVAILABLE = 503

let agentDir: FixtureAgentDir

beforeAll(async () => {
  agentDir = await loadFixtureAgentDir({
    modelsJson: {
      providers: {
        anthro: offlineProvider(
          { id: 'sonnet-mock', reasoning: true },
          { id: 'opus-mock', reasoning: true },
          'haiku-mock'
        ),
        other: offlineProvider('gpt-mock')
      }
    }
  })
})

afterAll(() => {
  vi.unstubAllEnvs()
  agentDir.remove()
})

/** Write pi's global settings with these `enabledModels`. */
function enableModels(patterns: readonly string[]): void {
  writeFileSync(join(agentDir.path, 'settings.json'), JSON.stringify({ enabledModels: patterns }))
}

/** The proxy as deployed: exposure from its config file and pi's settings, read per request. */
function app(): Hono<ProxyEnv> {
  return createApp(testConfig(), fileConfigReader)
}

async function exposedIds(): Promise<unknown> {
  const body: unknown = await (await app().request('/v1/models')).json()
  const data = isRecord(body) ? body['data'] : undefined
  return Array.isArray(data)
    ? data.map((model: unknown) => (isRecord(model) ? model['id'] : model))
    : body
}

describe('enabledModels patterns select models as pi selects them', () => {
  // Catches patterns compared character for character (#46): each of these selected nothing, so
  // models enabled in pi were missing from the proxy, and a list of only patterns exposed none.
  test.each([
    ['a provider glob', ['anthro/*'], ['sonnet-mock', 'opus-mock', 'haiku-mock']],
    ['an ID glob', ['*us-mock'], ['opus-mock']],
    ['a bare ID', ['gpt-mock'], ['gpt-mock']],
    ['a thinking-level suffix', ['anthro/opus-mock:high'], ['opus-mock']],
    ['an exact ID, as pi saves them', ['anthro/haiku-mock'], ['haiku-mock']],
    [
      'patterns together, in the available order',
      ['gpt-mock', 'anthro/opus-mock'],
      ['opus-mock', 'gpt-mock']
    ]
  ])('%s', async (_case, patterns, expected) => {
    enableModels(patterns)

    expect(await exposedIds()).toEqual(expected)
  })
})

describe('/healthz/models reports patterns that did not resolve', () => {
  // Catches a pattern that selects nothing staying invisible: the only trace was a debug log line.
  test('a pattern matching nothing is listed, the rest still exposed', async () => {
    enableModels(['anthro/haiku-mock', 'claude-*'])

    const response = await app().request('/healthz/models')

    expect(response.status).toBe(HTTP_OK)
    expect(await response.json()).toMatchObject({
      status: 'ok',
      exposedModelCount: 1,
      scopeDiagnostics: [
        { code: 'no-match', pattern: 'claude-*', message: 'No models match pattern "claude-*"' }
      ]
    })
  })

  // Catches the case that empties the model list going unexplained: the check fails, and says why.
  test('when no pattern matches, the check fails and lists every one', async () => {
    enableModels(['claude-*', 'gemini'])

    const response = await app().request('/healthz/models')

    expect(response.status).toBe(HTTP_SERVICE_UNAVAILABLE)
    expect(await response.json()).toMatchObject({
      status: 'unavailable',
      exposedModelCount: 0,
      scopeDiagnostics: [
        { code: 'no-match', pattern: 'claude-*' },
        { code: 'no-match', pattern: 'gemini' }
      ]
    })
  })
})
