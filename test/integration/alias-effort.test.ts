/**
 * An alias that sets a reasoning effort per target (#230), end to end: the target's effort replaces
 * the request's `reasoning_effort` on that model, the response reports both, a chain runs each hop
 * at its own effort, and an effort the model doesn't support leaves the target out. The proxy runs
 * as deployed (its config file read per request) through pi's OpenAI chat completions adapter
 * against the mock provider, which answers by model.
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { resetSync } from '@logtape/logtape'
import { configureLogging } from '@proxy/logging'
import { clearAllCooldowns } from '@proxy/pi/cooldowns'
import { createApp } from '@proxy/server/app'
import { fileConfigReader } from '@proxy/server/routes'
import { isRecord } from '@proxy/utils/guards'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'
import {
  finishChunk,
  httpError,
  type MockProvider,
  sse,
  startMockProvider,
  textChunks
} from '../fixtures/mock-provider'
import { jsonBody, testConfig } from '../helpers'

const MOCK_KEY = 'notarealsecret-mock-provider-key'

let mock: MockProvider
let agentDir: FixtureAgentDir

/** The log records these tests read: their level, rendered message and properties. */
const records: { level: string; message: string; properties: unknown }[] = []

beforeAll(async () => {
  const answer = sse([...textChunks('ok'), finishChunk('stop')])
  mock = await startMockProvider({
    'deep-mock': answer,
    'quick-mock': answer,
    'limited-mock': httpError(429, {
      error: { message: 'Rate limit reached', type: 'rate_limit_error' }
    })
  })
  agentDir = await loadFixtureAgentDir({
    modelsJson: {
      providers: {
        alpha: {
          baseUrl: `${mock.origin}/v1`,
          api: 'openai-completions',
          apiKey: MOCK_KEY,
          models: [
            { id: 'deep-mock', reasoning: true, thinkingLevelMap: { xhigh: 'xhigh' } },
            { id: 'quick-mock', reasoning: true },
            { id: 'limited-mock', reasoning: true }
          ]
        }
      }
    }
  })
  configureLogging({
    level: 'debug',
    format: 'json',
    write: (line) => {
      const parsed: unknown = JSON.parse(line)
      if (!isRecord(parsed) || typeof parsed['message'] !== 'string') return
      records.push({
        level: String(parsed['level']),
        message: parsed['message'],
        properties: parsed['properties']
      })
    }
  })
})

// Cooldowns (#68) are process-wide: each case starts with none, so one case's 429 doesn't route
// the next.
beforeEach(() => {
  clearAllCooldowns()
  records.length = 0
})

afterAll(async () => {
  resetSync()
  vi.unstubAllEnvs()
  await mock.close()
  agentDir.remove()
})

/**
 * Writes the proxy's config file with these aliases.
 *
 * @param aliases - the `aliases` field, as a user would write it
 */
function setAliases(aliases: Record<string, unknown>): void {
  writeFileSync(join(agentDir.path, 'proxy-config.json'), JSON.stringify({ aliases }))
}

/**
 * Sends one chat request and records what the upstream was asked.
 *
 * @param model - the request's `model`
 * @param options - the `reasoning_effort` to send, if any, and whether to stream
 * @returns the status, the body as text, and each upstream call's model and `reasoning_effort`
 */
async function ask(
  model: string,
  options: { reasoningEffort?: string; stream?: boolean } = {}
): Promise<{ status: number; text: string; upstream: { model: unknown; effort: unknown }[] }> {
  const before = mock.requests.length
  const response = await createApp(testConfig(), fileConfigReader).request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: options.stream === true,
      ...(options.reasoningEffort === undefined
        ? {}
        : { reasoning_effort: options.reasoningEffort }),
      messages: [{ role: 'user', content: 'Say ok' }]
    })
  })
  const text = await response.text()
  const upstream = mock.requests.slice(before).map((request) => {
    const body = isRecord(request.body) ? request.body : {}
    return { model: body['model'], effort: body['reasoning_effort'] }
  })
  return { status: response.status, text, upstream }
}

/**
 * Parses a response's `x_pi`: the body's, or each stream chunk's.
 *
 * @param text - the response body
 * @param stream - whether it is a stream
 * @returns every `x_pi` found, in order
 */
function xPi(text: string, stream: boolean): unknown[] {
  if (!stream) {
    const body: unknown = JSON.parse(text)
    return [isRecord(body) ? body['x_pi'] : undefined]
  }
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line) => {
      const chunk: unknown = JSON.parse(line.slice('data: '.length))
      return isRecord(chunk) ? chunk['x_pi'] : undefined
    })
}

describe("an alias's effort replaces the request's", () => {
  // Catches the alias's effort ignored (the request's sent upstream) or applied without telling
  // the client, in a body or in any chunk of a stream.
  test.each([
    ['non-streamed', false],
    ['streamed', true]
  ])('%s: the target runs at its effort, and both are reported', async (_mode, stream) => {
    setAliases({ reviewer: { model: 'alpha/deep-mock', reasoningEffort: 'high' } })

    const { status, text, upstream } = await ask('reviewer', { reasoningEffort: 'low', stream })

    expect(status).toBe(200)
    expect(upstream).toEqual([{ model: 'deep-mock', effort: 'high' }])
    const found = xPi(text, stream)
    expect(found.length).toBeGreaterThan(0)
    for (const fields of found) {
      expect(fields).toMatchObject({
        alias: 'reviewer',
        reasoning_effort: { requested: 'low', applied: 'high' }
      })
    }
  })

  // Catches the report left out, or `requested` invented, when the client sent no effort.
  test('a request without reasoning_effort reports requested as null', async () => {
    setAliases({ reviewer: { model: 'alpha/deep-mock', reasoningEffort: 'high' } })

    const { text, upstream } = await ask('reviewer')

    expect(upstream).toEqual([{ model: 'deep-mock', effort: 'high' }])
    expect(xPi(text, false)).toEqual([
      expect.objectContaining({ reasoning_effort: { requested: null, applied: 'high' } })
    ])
  })

  // Catches the override going unlogged, or logged at info on every request: the first per alias
  // is at info, later ones at debug, and a request already at the alias's effort isn't logged.
  test('a replaced effort is logged at info once per alias, then at debug', async () => {
    setAliases({ 'reviewer-log': { model: 'alpha/deep-mock', reasoningEffort: 'high' } })

    await ask('reviewer-log', { reasoningEffort: 'low' })
    await ask('reviewer-log', { reasoningEffort: 'medium' })
    await ask('reviewer-log', { reasoningEffort: 'high' })

    const replaced = records.filter((record) =>
      record.message.startsWith('Alias "reviewer-log" runs')
    )
    expect(replaced.map(({ level, properties }) => ({ level, properties }))).toEqual([
      {
        level: 'INFO',
        properties: expect.objectContaining({
          aliasEffort: 'high',
          reasoningEffort: 'low'
        }) as unknown
      },
      {
        level: 'DEBUG',
        properties: expect.objectContaining({
          aliasEffort: 'high',
          reasoningEffort: 'medium'
        }) as unknown
      }
    ])
    const resolved = records.find((record) => record.message.startsWith('Chat request for'))
    expect(resolved?.properties).toMatchObject({ reasoningEffort: 'low', aliasEffort: 'high' })
  })
})

describe('a chain runs each target at its own effort', () => {
  // Catches one effort for the whole chain (the first target's, or the request's) instead of each
  // hop's own, and an attempt that doesn't say what it ran at.
  test('the fallback runs at its effort, and the attempt shows the first one', async () => {
    setAliases({
      'builder-high': {
        targets: [
          { model: 'alpha/limited-mock', reasoningEffort: 'high' },
          { model: 'alpha/quick-mock', reasoningEffort: 'medium' }
        ],
        fallbackOn: ['rate_limit']
      }
    })

    const { status, text, upstream } = await ask('builder-high', { reasoningEffort: 'low' })

    expect(status).toBe(200)
    expect(upstream).toEqual([
      { model: 'limited-mock', effort: 'high' },
      { model: 'quick-mock', effort: 'medium' }
    ])
    expect(xPi(text, false)).toEqual([
      expect.objectContaining({
        reasoning_effort: { requested: 'low', applied: 'medium' },
        attempts: [{ model: 'alpha/limited-mock', reasoning_effort: 'high', reason: 'rate_limit' }]
      })
    ])
  })

  // Catches a target without an effort picking up a neighbour's: it keeps the request's, clamped
  // as for a model named directly.
  test("a target without an effort keeps the request's", async () => {
    setAliases({
      mixed: {
        targets: [{ model: 'alpha/limited-mock', reasoningEffort: 'high' }, 'alpha/quick-mock'],
        fallbackOn: ['rate_limit']
      }
    })

    const { text, upstream } = await ask('mixed', { reasoningEffort: 'xhigh' })

    expect(upstream).toEqual([
      { model: 'limited-mock', effort: 'high' },
      { model: 'quick-mock', effort: 'high' }
    ])
    expect(xPi(text, false)).toEqual([
      expect.objectContaining({ reasoning_effort: { requested: 'xhigh', applied: 'high' } })
    ])
  })
})

describe('an effort the target does not support', () => {
  // Catches an unsupported effort clamped (the issue makes it a configuration error) or the alias
  // listed and served anyway, and the operator not told.
  test('leaves the target out, fails /healthz/models and warns', async () => {
    setAliases({
      broken: { model: 'alpha/quick-mock', reasoningEffort: 'xhigh' },
      partial: {
        targets: [
          { model: 'alpha/quick-mock', reasoningEffort: 'max' },
          { model: 'alpha/deep-mock', reasoningEffort: 'xhigh' }
        ],
        fallbackOn: ['rate_limit']
      }
    })
    const app = createApp(testConfig(), fileConfigReader)

    const health = await app.request('/healthz/models')
    const models = await jsonBody(await app.request('/v1/models'))
    const partial = await ask('partial', { reasoningEffort: 'low' })
    const broken = await ask('broken')

    expect(health.status).toBe(503)
    expect(await jsonBody(health)).toMatchObject({
      aliasDiagnostics: [
        { code: 'effort-unsupported', alias: 'broken', target: 'alpha/quick-mock' },
        { code: 'effort-unsupported', alias: 'partial', target: 'alpha/quick-mock' }
      ]
    })
    const listed: unknown[] =
      isRecord(models) && Array.isArray(models['data']) ? models['data'] : []
    const ids = listed.filter(isRecord).map((model) => model['id'])
    expect(ids).toContain('partial')
    expect(ids).not.toContain('broken')
    expect(partial.upstream).toEqual([{ model: 'deep-mock', effort: 'xhigh' }])
    expect(broken.status).toBe(404)
    expect(
      records.filter(
        (record) => record.level === 'WARN' && record.message.includes('reasoning effort')
      )
    ).toHaveLength(1)
  })
})

describe('GET /v1/switchboard/models', () => {
  // Catches an alias listed with its model's whole ladder, which tells a client it can choose an
  // effort the alias will replace.
  test('an alias with an effort lists that effort alone, marked fixed', async () => {
    setAliases({
      reviewer: { model: 'alpha/deep-mock', reasoningEffort: 'high' },
      plain: 'alpha/deep-mock'
    })

    const body = await jsonBody(
      await createApp(testConfig(), fileConfigReader).request('/v1/switchboard/models')
    )

    const data: unknown[] = isRecord(body) && Array.isArray(body['data']) ? body['data'] : []
    const byId = Object.fromEntries(data.filter(isRecord).map((model) => [model['id'], model]))
    expect(byId['reviewer']).toMatchObject({
      reasoning_efforts: ['high'],
      reasoning_effort_fixed: true
    })
    expect(byId['plain']).toMatchObject({
      reasoning_efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
      reasoning_effort_fixed: false
    })
  })
})
