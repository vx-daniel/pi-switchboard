/**
 * Family aliases (#231), end to end: `{ family }` is answered by the family's newest exposed
 * model, moves on the next request when a newer one is exposed (with one warning), holds a pin, and
 * reports what it resolves to in `/healthz/models`. The proxy runs as deployed (its config file
 * read per request) against the mock provider, which answers by model.
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { resetSync } from '@logtape/logtape'
import { configureLogging } from '@proxy/logging'
import { createApp } from '@proxy/server/app'
import { fileConfigReader } from '@proxy/server/routes'
import { isRecord } from '@proxy/utils/guards'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'
import {
  finishChunk,
  type MockProvider,
  sse,
  startMockProvider,
  textChunks
} from '../fixtures/mock-provider'
import { jsonBody, testConfig } from '../helpers'

const MOCK_KEY = 'notarealsecret-mock-provider-key'
/** The Opus models the mock answers, replacing pi's own entries so they reach it. */
const OPUS = ['claude-opus-4-8', 'claude-opus-5', 'claude-opus-5-5', 'claude-opus-next']

let mock: MockProvider
let agentDir: FixtureAgentDir

/** The warnings logged, rendered. */
const warnings: string[] = []

beforeAll(async () => {
  const answer = sse([...textChunks('ok'), finishChunk('stop')])
  mock = await startMockProvider(Object.fromEntries(OPUS.map((modelId) => [modelId, answer])))
  agentDir = await loadFixtureAgentDir({
    modelsJson: {
      providers: {
        anthropic: {
          baseUrl: `${mock.origin}/v1`,
          api: 'openai-completions',
          apiKey: MOCK_KEY,
          models: OPUS.map((modelId) => ({ id: modelId }))
        }
      }
    }
  })
  configureLogging({
    level: 'warning',
    format: 'json',
    write: (line) => {
      const parsed: unknown = JSON.parse(line)
      if (isRecord(parsed) && typeof parsed['message'] === 'string') {
        warnings.push(parsed['message'])
      }
    }
  })
})

beforeEach(() => {
  warnings.length = 0
})

afterAll(async () => {
  resetSync()
  vi.unstubAllEnvs()
  await mock.close()
  agentDir.remove()
})

/**
 * Writes the proxy's config file: these aliases, and only these Opus models exposed.
 *
 * @param aliases - the `aliases` field
 * @param exposed - the Opus model IDs to expose
 */
function setConfig(aliases: Record<string, unknown>, exposed: readonly string[]): void {
  writeFileSync(
    join(agentDir.path, 'proxy-config.json'),
    JSON.stringify({
      modelExposureMode: 'custom',
      customModels: exposed.map((modelId) => `anthropic/${modelId}`),
      aliases
    })
  )
}

/**
 * Sends one chat request.
 *
 * @param model - the request's `model`
 * @returns the status, the parsed body, and the upstream models asked
 */
async function ask(model: string): Promise<{ status: number; body: unknown; upstream: unknown[] }> {
  const before = mock.requests.length
  const response = await createApp(testConfig(), fileConfigReader).request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Say ok' }] })
  })
  const body = await jsonBody(response)
  const upstream = mock.requests
    .slice(before)
    .map((request) => (isRecord(request.body) ? request.body['model'] : undefined))
  return { status: response.status, body, upstream }
}

/**
 * Reads `/healthz/models`.
 *
 * @returns its status and body
 */
async function health(): Promise<{ status: number; body: unknown }> {
  const response = await createApp(testConfig(), fileConfigReader).request('/healthz/models')
  return { status: response.status, body: await jsonBody(response) }
}

describe('a family alias', () => {
  // Catches the family alias answered by an older member, or the answer not saying which alias it
  // came through (principle VI).
  test("is answered by the family's newest exposed model", async () => {
    setConfig({ 'opus-latest': { family: 'anthropic/claude-opus' } }, OPUS)

    const answer = await ask('opus-latest')

    expect(answer.upstream).toEqual(['claude-opus-5-5'])
    expect(answer.body).toMatchObject({
      model: 'anthropic/claude-opus-5-5',
      x_pi: { alias: 'opus-latest' }
    })
  })

  // Catches a move that needs a restart, goes unlogged, or is logged on every request; and the
  // hidden newer model reached anyway, or its hiding not shown.
  test('moves on the next request when a newer model is exposed, with one warning', async () => {
    const aliases = { 'opus-moving': { family: 'anthropic/claude-opus' } }
    setConfig(aliases, ['claude-opus-4-8', 'claude-opus-5'])

    const first = await ask('opus-moving')
    const before = await health()
    setConfig(aliases, ['claude-opus-4-8', 'claude-opus-5', 'claude-opus-5-5'])
    const moved = await ask('opus-moving')
    await ask('opus-moving')

    expect(first.upstream).toEqual(['claude-opus-5'])
    expect(before.body).toMatchObject({
      familyAliases: [
        {
          alias: 'opus-moving',
          resolved: 'anthropic/claude-opus-5',
          newerHidden: 'anthropic/claude-opus-5-5'
        }
      ]
    })
    expect(moved.upstream).toEqual(['claude-opus-5-5'])
    expect(warnings.filter((message) => message.includes('now follows'))).toEqual([
      'Alias "opus-moving" now follows "anthropic/claude-opus" to "anthropic/claude-opus-5-5", not "anthropic/claude-opus-5"'
    ])
  })

  // Catches a pin that moves with the family, or a hidden pin served by the newest instead.
  test('holds its pin, and is not served at all while the pin is hidden', async () => {
    const aliases = {
      'opus-steady': { family: 'anthropic/claude-opus', pin: 'anthropic/claude-opus-4-8' }
    }
    setConfig(aliases, OPUS)
    const held = await ask('opus-steady')
    setConfig(aliases, ['claude-opus-5', 'claude-opus-5-5'])
    const hidden = await ask('opus-steady')

    expect(held.upstream).toEqual(['claude-opus-4-8'])
    expect(hidden.status).toBe(404)
    expect(hidden.upstream).toEqual([])
  })

  // Catches a misconfigured family alias passing the health check, or an unreadable member picked
  // or kept quiet.
  test('/healthz/models fails on an unknown family or a pin outside it, and lists the rest', async () => {
    setConfig(
      {
        'opus-latest': { family: 'anthropic/claude-opus' },
        'gpt-latest': { family: 'openai/gpt' },
        'opus-odd': { family: 'anthropic/claude-opus', pin: 'anthropic/claude-sonnet-5' }
      },
      OPUS
    )

    const { status, body } = await health()

    expect(status).toBe(503)
    expect(body).toMatchObject({
      aliasDiagnostics: [
        { code: 'family-unparsed', alias: 'opus-latest', target: 'anthropic/claude-opus-next' },
        { code: 'family-unknown', alias: 'gpt-latest', target: 'openai/gpt' },
        // The pin's check comes after the family's members are scanned.
        { code: 'family-unparsed', alias: 'opus-odd', target: 'anthropic/claude-opus-next' },
        { code: 'pin-outside-family', alias: 'opus-odd', target: 'anthropic/claude-sonnet-5' }
      ],
      familyAliases: [
        {
          alias: 'opus-latest',
          position: 0,
          family: 'anthropic/claude-opus',
          pin: null,
          resolved: 'anthropic/claude-opus-5-5',
          newest: 'anthropic/claude-opus-5-5',
          newerHidden: null
        }
      ]
    })
  })

  // Catches the new field or a 503 appearing for a config with no family alias.
  test('a config without family aliases reports none, and stays healthy', async () => {
    setConfig({ opus: 'anthropic/claude-opus-5' }, OPUS)

    const { status, body } = await health()

    expect(status).toBe(200)
    expect(body).toMatchObject({ familyAliases: [], aliasDiagnostics: [] })
  })
})
