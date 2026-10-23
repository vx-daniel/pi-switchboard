/**
 * `GET /v1/switchboard/models`'s catalogue data (#173): each exposed model's pi catalogue entry, as
 * pi resolves it from `models.json`, so a client can choose models by price, context window and
 * capabilities instead of hard-coding them.
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createApp } from '@proxy/server/app'
import { fileConfigReader } from '@proxy/server/routes'
import { isRecord } from '@proxy/utils/guards'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir, offlineProvider } from '../fixtures/agent-dir'
import { testConfig } from '../helpers'

let agentDir: FixtureAgentDir

beforeAll(async () => {
  agentDir = await loadFixtureAgentDir({
    modelsJson: {
      providers: {
        acme: offlineProvider(
          {
            id: 'big-mock',
            reasoning: true,
            input: ['text', 'image'],
            contextWindow: 400000,
            maxTokens: 64000,
            cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 3.125 }
          },
          'plain-mock'
        )
      }
    }
  })
  writeFileSync(
    join(agentDir.path, 'proxy-config.json'),
    JSON.stringify({ aliases: { big: 'acme/big-mock' } })
  )
})

afterAll(() => {
  vi.unstubAllEnvs()
  agentDir.remove()
})

/**
 * Lists `/v1/switchboard/models` by public ID.
 *
 * @returns each entry, by its `id`
 */
async function catalogue(): Promise<Map<unknown, unknown>> {
  const response = await createApp(testConfig(), fileConfigReader).request('/v1/switchboard/models')
  const body: unknown = await response.json()
  const data = isRecord(body) && Array.isArray(body['data']) ? body['data'] : []
  return new Map(data.map((listed: unknown) => [isRecord(listed) ? listed['id'] : listed, listed]))
}

describe("GET /v1/switchboard/models: pi's catalogue entry per model", () => {
  // Catches a field missing, renamed, or taken from the wrong pi field (`maxTokens` as the context
  // window, `cacheWrite` as the read price): a client prices and sizes its runs from these.
  test("a model's entry carries its models.json values", async () => {
    expect((await catalogue()).get('big-mock')).toEqual({
      id: 'big-mock',
      provider: 'acme',
      reasoning: true,
      reasoning_efforts: expect.arrayContaining(['low', 'high']),
      input: ['text', 'image'],
      context_window: 400000,
      max_output_tokens: 64000,
      cost: { input: 2.5, output: 15, cache_read: 0.25, cache_write: 3.125 },
      cooldown: null,
      quota: null,
      logins: [{ id: 'acme', cooldown: null, quota: null }]
    })
  })

  // Catches an alias listed without its target's data, or with another model's: a client choosing
  // by an alias sees what the alias runs.
  test("an alias carries its target's entry", async () => {
    const entries = await catalogue()
    const target = entries.get('big-mock')

    expect(entries.get('big')).toEqual({ ...(isRecord(target) ? target : {}), id: 'big' })
  })

  // Catches a model without prices or limits in models.json shown with none: pi's defaults apply,
  // and the entry still has every field.
  test("a model with no catalogue values gets pi's defaults, every field present", async () => {
    expect((await catalogue()).get('plain-mock')).toEqual({
      id: 'plain-mock',
      provider: 'acme',
      reasoning: false,
      reasoning_efforts: ['none'],
      input: ['text'],
      context_window: expect.any(Number),
      max_output_tokens: expect.any(Number),
      cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      cooldown: null,
      quota: null,
      logins: [{ id: 'acme', cooldown: null, quota: null }]
    })
  })
})
