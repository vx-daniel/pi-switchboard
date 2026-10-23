/**
 * `reasoning_effort` end to end: what each provider receives through pi's real clients. "none" is
 * pi's "off"; on a model whose reasoning cannot be turned off it is the lowest level the model
 * supports, never the provider's default effort (#41). Any other effort the model does not support
 * is clamped with pi's `clampThinkingLevel`, reported at debug, and `/v1/switchboard/models` lists
 * the efforts each model supports (#43).
 */

import { resetSync } from '@logtape/logtape'
import { configureLogging } from '@proxy/logging'
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
import { jsonBody, testApp, testConfig } from '../helpers'

const MOCK_KEY = 'notarealsecret-mock-provider-key'
/** pi's thinking budget for "minimal" on Anthropic budget-based models. */
const MINIMAL_THINKING_BUDGET = 1024

let mock: MockProvider
let agentDir: FixtureAgentDir
/** Every log record of a clamped effort: its level and properties. */
const clampRecords: { level: string; properties: unknown }[] = []

beforeAll(async () => {
  const answer = sse([...textChunks('ok'), finishChunk('stop')])
  mock = await startMockProvider({
    'claude-thinking': answer,
    'claude-always-thinking': answer,
    'gpt-reasoning': answer,
    'gpt-always-reasoning': answer,
    'gpt-low-floor': answer,
    'chat-off-none': answer,
    'chat-always-reasoning': answer,
    'chat-undeclared-off': answer,
    'chat-plain': answer,
    'chat-xhigh': answer,
    'claude-adaptive-max': answer,
    'claude-log-clamp': answer,
    'chat-limited': httpError(429, {
      error: { message: 'Rate limit reached', type: 'rate_limit_error' }
    })
  })
  agentDir = await loadFixtureAgentDir({
    modelsJson: {
      providers: {
        anthropic: {
          baseUrl: mock.origin,
          api: 'anthropic-messages',
          apiKey: MOCK_KEY,
          models: [
            { id: 'claude-thinking', reasoning: true },
            // Clamped by one test only: the clamp log's "first per model" is per process.
            { id: 'claude-log-clamp', reasoning: true },
            { id: 'claude-always-thinking', reasoning: true, thinkingLevelMap: { off: null } },
            {
              id: 'claude-adaptive-max',
              reasoning: true,
              compat: { forceAdaptiveThinking: true },
              thinkingLevelMap: { max: 'max' }
            }
          ]
        },
        responses: {
          baseUrl: `${mock.origin}/v1`,
          api: 'openai-responses',
          apiKey: MOCK_KEY,
          models: [
            { id: 'gpt-reasoning', reasoning: true },
            { id: 'gpt-always-reasoning', reasoning: true, thinkingLevelMap: { off: null } },
            {
              id: 'gpt-low-floor',
              reasoning: true,
              thinkingLevelMap: { off: null, minimal: null }
            }
          ]
        },
        completions: {
          baseUrl: `${mock.origin}/v1`,
          api: 'openai-completions',
          apiKey: MOCK_KEY,
          models: [
            { id: 'chat-off-none', reasoning: true, thinkingLevelMap: { off: 'none' } },
            { id: 'chat-always-reasoning', reasoning: true, thinkingLevelMap: { off: null } },
            { id: 'chat-undeclared-off', reasoning: true },
            { id: 'chat-plain' },
            { id: 'chat-xhigh', reasoning: true, thinkingLevelMap: { xhigh: 'xhigh' } },
            { id: 'chat-limited', reasoning: true }
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
      if (!parsed['message'].startsWith('Clamped reasoning_effort')) return
      clampRecords.push({ level: String(parsed['level']), properties: parsed['properties'] })
    }
  })
})

beforeEach(() => {
  clampRecords.length = 0
})

afterAll(async () => {
  resetSync()
  vi.unstubAllEnvs()
  await mock.close()
  agentDir.remove()
})

/**
 * Asks `model` with `reasoningEffort` and returns one field of the body pi sent upstream.
 *
 * @remarks
 * Also asserts that the request reached the mock provider exactly once.
 *
 * @param model - the public model ID to ask
 * @param reasoningEffort - the `reasoning_effort` value to send
 * @param field - the top-level field of the upstream body to return
 * @returns that field's value, or `undefined` when the body lacks it or is not an object
 */
async function sentField(model: string, reasoningEffort: string, field: string): Promise<unknown> {
  const before = mock.requests.length
  await testApp().request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      reasoning_effort: reasoningEffort,
      messages: [{ role: 'user', content: 'Hi' }]
    })
  })
  expect(mock.requests).toHaveLength(before + 1)
  const body = mock.requests.at(-1)?.body
  return isRecord(body) ? body[field] : undefined
}

describe('reasoning_effort "none" turns reasoning off', () => {
  // Catches the #41 bug: "none" mapped to "minimal", so a client asking for no thinking got a
  // thinking budget (latency and output tokens it did not ask for).
  test('anthropic-messages: thinking disabled', async () => {
    expect(await sentField('anthropic/claude-thinking', 'none', 'thinking')).toEqual({
      type: 'disabled'
    })
  })

  // Catches the same on OpenAI Responses, where off is an explicit effort, not an absent field.
  test('openai-responses: effort none', async () => {
    expect(await sentField('responses/gpt-reasoning', 'none', 'reasoning')).toEqual({
      effort: 'none'
    })
  })
})

describe('reasoning_effort "none" on a model that cannot turn reasoning off', () => {
  // Catches "none" sent as no reasoning field at all, which the provider reads as its default
  // effort (OpenAI: medium): asking for none would then reason more than asking for minimal.
  test('openai-responses: the lowest level the model supports, minimal', async () => {
    expect(await sentField('responses/gpt-always-reasoning', 'none', 'reasoning')).toEqual({
      effort: 'minimal',
      summary: 'auto'
    })
  })

  // Catches the clamp assuming "minimal" instead of asking the model's own levels.
  test('openai-responses: low, when the model has no minimal either', async () => {
    expect(await sentField('responses/gpt-low-floor', 'none', 'reasoning')).toEqual({
      effort: 'low',
      summary: 'auto'
    })
  })

  // Catches the clamp missing for Anthropic, which would send no thinking setting at all.
  test('anthropic-messages: the minimal thinking budget', async () => {
    expect(await sentField('anthropic/claude-always-thinking', 'none', 'thinking')).toEqual({
      type: 'enabled',
      budget_tokens: MINIMAL_THINKING_BUDGET,
      display: 'summarized'
    })
  })
})

describe('reasoning_effort "none" on openai-completions follows the model definition', () => {
  // Catches "none" not reaching a chat-completions model that declares how to say off.
  test('a model with an off value gets it', async () => {
    expect(await sentField('completions/chat-off-none', 'none', 'reasoning_effort')).toBe('none')
  })

  // Catches the clamp missing on chat completions, the API with the most models that cannot turn
  // reasoning off: they would get the provider's default effort.
  test('a model that cannot turn reasoning off gets the lowest level, minimal', async () => {
    expect(await sentField('completions/chat-always-reasoning', 'none', 'reasoning_effort')).toBe(
      'minimal'
    )
  })

  // Catches the proxy overriding the model definition with an effort of its own: a model that
  // declares no off value says that sending nothing is off (pi's contract; README).
  test('a model that declares no off value gets no reasoning_effort', async () => {
    expect(
      await sentField('completions/chat-undeclared-off', 'none', 'reasoning_effort')
    ).toBeUndefined()
  })
})

describe('reasoning_effort "minimal" is unchanged', () => {
  // Catches the "none" fix spilling into "minimal".
  test('anthropic-messages: the minimal thinking budget', async () => {
    expect(await sentField('anthropic/claude-thinking', 'minimal', 'thinking')).toEqual({
      type: 'enabled',
      budget_tokens: MINIMAL_THINKING_BUDGET,
      display: 'summarized'
    })
  })

  // Catches "minimal" sent as "none" on OpenAI Responses, or losing the reasoning summary.
  test('openai-responses: effort minimal', async () => {
    expect(await sentField('responses/gpt-reasoning', 'minimal', 'reasoning')).toEqual({
      effort: 'minimal',
      summary: 'auto'
    })
  })
})

describe('an effort the model does not support is clamped (#43)', () => {
  // Catches pi's Anthropic adapter fallback (effort high, in `mapThinkingLevelToEffort`) instead
  // of pi's clamp, which takes the nearest supported level above the one asked for, as every
  // other adapter and pi itself do.
  test('anthropic-messages: xhigh on an adaptive model with max but no xhigh is max', async () => {
    expect(await sentField('anthropic/claude-adaptive-max', 'xhigh', 'output_config')).toEqual({
      effort: 'max'
    })
  })

  // Catches "max" rejected or mapped to another level on a model whose definition maps it.
  test('anthropic-messages: max on an adaptive model with max is max, unclamped', async () => {
    expect(await sentField('anthropic/claude-adaptive-max', 'max', 'output_config')).toEqual({
      effort: 'max'
    })
    expect(clampRecords).toEqual([])
  })

  // Catches "max" on a model without it sent upstream as is, or dropped: it is the model's
  // highest level.
  test('openai-completions: max on a model whose highest level is xhigh is xhigh', async () => {
    expect(await sentField('completions/chat-xhigh', 'max', 'reasoning_effort')).toBe('xhigh')
  })

  // Catches the clamp going unreported to the operator, or reported at info on every request: the
  // first clamp per model is at info, later ones at debug, as dropped temperatures are (#175).
  test('the first clamp per model is logged at info, later ones at debug', async () => {
    await sentField('anthropic/claude-log-clamp', 'xhigh', 'thinking')
    await sentField('anthropic/claude-log-clamp', 'xhigh', 'thinking')

    const properties = expect.objectContaining({
      reasoningEffort: 'xhigh',
      thinkingLevel: 'high',
      modelId: 'claude-log-clamp',
      supportedEfforts: ['none', 'minimal', 'low', 'medium', 'high']
    }) as unknown
    expect(clampRecords).toEqual([
      { level: 'INFO', properties },
      { level: 'DEBUG', properties }
    ])
  })

  // Catches a clamp reported for an effort the model runs at as asked.
  test('a supported effort is not reported', async () => {
    await sentField('completions/chat-xhigh', 'xhigh', 'reasoning_effort')

    expect(clampRecords).toEqual([])
  })
})

/**
 * Asks `model` and returns the `x_pi` of the answer: the body's, or each stream chunk's.
 *
 * @param model - the public model ID to ask
 * @param reasoningEffort - the `reasoning_effort` to send, or `undefined` to send none
 * @param stream - whether to ask for a stream
 * @returns every `x_pi` found, in order; `undefined` entries where a chunk or body had none
 */
async function answerXPi(
  model: string,
  reasoningEffort: string | undefined,
  stream: boolean
): Promise<unknown[]> {
  const response = await testApp().request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream,
      ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
      messages: [{ role: 'user', content: 'Hi' }]
    })
  })
  return xPiOf(await response.text(), stream)
}

/**
 * Parses a response's `x_pi`: the body's, or each stream chunk's.
 *
 * @param text - the response body
 * @param stream - whether it is a stream
 * @returns every `x_pi` found, in order; `undefined` entries where a chunk or body had none
 */
function xPiOf(text: string, stream: boolean): unknown[] {
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

describe('x_pi.reasoning_effort reports what the model ran at (#175)', () => {
  // Catches a clamp the client can't see: a client running one effort across models must learn
  // the level each one ran at, in the body and in every chunk of a stream.
  test.each([
    ['non-streamed', false],
    ['streamed', true]
  ])('%s: a clamped effort reports both values', async (_mode, stream) => {
    const found = await answerXPi('completions/chat-xhigh', 'max', stream)

    expect(found.length).toBeGreaterThan(0)
    for (const fields of found) {
      expect(fields).toMatchObject({ reasoning_effort: { requested: 'max', applied: 'xhigh' } })
    }
  })

  // Catches the report only on clamps: a client checking it must not have to tell "no clamp" from
  // "no report".
  test('an effort the model supports reports the same value twice', async () => {
    expect(await answerXPi('completions/chat-xhigh', 'xhigh', false)).toEqual([
      expect.objectContaining({ reasoning_effort: { requested: 'xhigh', applied: 'xhigh' } })
    ])
  })

  // Catches pi's level leaking into the report: a model without reasoning runs at pi's `off`,
  // which OpenAI calls `none`.
  test("a model without reasoning reports `none`, OpenAI's name for off", async () => {
    expect(await answerXPi('completions/chat-plain', 'high', false)).toEqual([
      expect.objectContaining({ reasoning_effort: { requested: 'high', applied: 'none' } })
    ])
  })

  // Catches `none` reported as applied on a model that can't turn reasoning off (#41): it runs at
  // its lowest level, and the client must see which.
  test('`none` on a model that always reasons reports its lowest level', async () => {
    expect(await answerXPi('completions/chat-always-reasoning', 'none', false)).toEqual([
      expect.objectContaining({ reasoning_effort: { requested: 'none', applied: 'minimal' } })
    ])
  })

  // Catches the report taken from the model the request asked for rather than the one that
  // answered: `chat-limited` would clamp `xhigh` to `high`, `chat-xhigh` runs it as asked.
  test.each([
    ['non-streamed', false],
    ['streamed', true]
  ])('%s: after a fallback, the model that answered decides the report', async (_mode, stream) => {
    const config = {
      ...testConfig(),
      aliases: {
        chain: {
          targets: ['completions/chat-limited', 'completions/chat-xhigh'],
          fallbackOn: ['rate_limit' as const]
        }
      }
    }
    const response = await testApp(config).request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'chain',
        stream,
        reasoning_effort: 'xhigh',
        messages: [{ role: 'user', content: 'Hi' }]
      })
    })

    const found = xPiOf(await response.text(), stream)
    expect(found.length).toBeGreaterThan(0)
    for (const fields of found) {
      expect(fields).toMatchObject({ reasoning_effort: { requested: 'xhigh', applied: 'xhigh' } })
    }
  })

  // Catches the field on requests that never asked for an effort, which would change every
  // response's shape.
  test.each([
    ['non-streamed', false],
    ['streamed', true]
  ])('%s: a request without reasoning_effort has no report', async (_mode, stream) => {
    for (const fields of await answerXPi('completions/chat-xhigh', undefined, stream)) {
      expect(isRecord(fields) && 'reasoning_effort' in fields).toBe(false)
    }
  })
})

describe('GET /v1/switchboard/models', () => {
  // Catches a model's efforts listed from its reasoning flag alone, ignoring the levels its
  // definition maps or forbids: a client would pick an effort that then gets clamped.
  test('lists the efforts each exposed model supports', async () => {
    const upToHigh = ['none', 'minimal', 'low', 'medium', 'high']
    // The fixture's models. The `anthropic` provider also brings pi's built-in Anthropic catalog.
    const expected: Record<string, string[]> = {
      'chat-always-reasoning': upToHigh.slice(1),
      'chat-off-none': upToHigh,
      'chat-plain': ['none'],
      'chat-undeclared-off': upToHigh,
      'chat-xhigh': [...upToHigh, 'xhigh'],
      'claude-adaptive-max': [...upToHigh, 'max'],
      'claude-always-thinking': upToHigh.slice(1),
      'claude-thinking': upToHigh,
      'gpt-always-reasoning': upToHigh.slice(1),
      'gpt-low-floor': ['low', 'medium', 'high'],
      'gpt-reasoning': upToHigh
    }

    const response = await testApp().request('/v1/switchboard/models')

    expect(response.status).toBe(200)
    const body = await jsonBody(response)
    expect(isRecord(body) && body['object']).toBe('list')
    const data = isRecord(body) && Array.isArray(body['data']) ? body['data'] : []
    const fixtureEntries = data.filter((model) => entryId(model) in expected)
    // The efforts only: the entry's other catalogue fields are switchboard-models.test.ts's.
    const efforts = fixtureEntries
      .toSorted((left, right) => entryId(left).localeCompare(entryId(right)))
      .map((model) => ({
        id: entryId(model),
        reasoning_efforts: isRecord(model) ? model['reasoning_efforts'] : undefined
      }))
    expect(efforts).toEqual(
      Object.entries(expected).map(([id, levels]) => ({ id, reasoning_efforts: levels }))
    )
  })
})

/**
 * Reads a model list entry's `id`.
 *
 * @param entry - one element of a `/v1/switchboard/models` `data` array
 * @returns the entry's `id`, or '' when it has none
 */
function entryId(entry: unknown): string {
  return isRecord(entry) && typeof entry['id'] === 'string' ? entry['id'] : ''
}
