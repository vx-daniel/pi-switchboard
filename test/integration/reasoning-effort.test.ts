/**
 * `reasoning_effort` end to end: what each provider receives through pi's real clients. "none" is
 * pi's "off"; on a model whose reasoning cannot be turned off it is the lowest level the model
 * supports, never the provider's default effort (#41).
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
/** pi's thinking budget for "minimal" on Anthropic budget-based models. */
const MINIMAL_THINKING_BUDGET = 1024

let mock: MockProvider
let agentDir: FixtureAgentDir

beforeAll(async () => {
  const answer = sse([...textChunks('ok'), finishChunk('stop')])
  mock = await startMockProvider({
    'claude-thinking': answer,
    'claude-always-thinking': answer,
    'gpt-reasoning': answer,
    'gpt-always-reasoning': answer,
    'gpt-low-floor': answer
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
            { id: 'claude-always-thinking', reasoning: true, thinkingLevelMap: { off: null } }
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

/** Ask `model` with this reasoning_effort, and return the named field of what pi sent upstream. */
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
