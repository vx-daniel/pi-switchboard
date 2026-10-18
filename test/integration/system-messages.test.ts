/**
 * Where a system or developer message ends up upstream (#45), through pi's real clients. Ones before
 * the first conversation turn form the system prompt. A later one stays where the client put it on
 * a model that accepts mid-conversation instructions (`compat.supportsMidConvoSystemMessages`); on
 * any other model pi merges it into the leading prompt, which is what the proxy did for every model
 * before, so those payloads are unchanged.
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
const MID_CONVERSATION = { supportsMidConvoSystemMessages: true }

let mock: MockProvider
let agentDir: FixtureAgentDir

beforeAll(async () => {
  const answer = sse([...textChunks('ok'), finishChunk('stop')])
  mock = await startMockProvider({
    'claude-plain': answer,
    'claude-mid': answer,
    'chat-plain': answer,
    'chat-mid': answer
  })
  agentDir = await loadFixtureAgentDir({
    modelsJson: {
      providers: {
        anthropic: {
          baseUrl: mock.origin,
          api: 'anthropic-messages',
          apiKey: MOCK_KEY,
          models: [{ id: 'claude-plain' }, { id: 'claude-mid', compat: MID_CONVERSATION }]
        },
        completions: {
          baseUrl: `${mock.origin}/v1`,
          api: 'openai-completions',
          apiKey: MOCK_KEY,
          models: [{ id: 'chat-plain' }, { id: 'chat-mid', compat: MID_CONVERSATION }]
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

/** A system prompt, a first exchange, then a developer instruction for the next answer. */
const WITH_LATER_INSTRUCTION = [
  { role: 'system', content: 'You are terse.' },
  { role: 'user', content: 'Hi' },
  { role: 'assistant', content: 'Hello' },
  { role: 'developer', content: 'Now answer only in JSON.' },
  { role: 'user', content: 'Weather?' }
]

/** The `system` and `messages` fields of what pi sent upstream for these messages. */
async function sentConversation(
  model: string,
  messages: readonly unknown[]
): Promise<{ system: unknown; messages: unknown }> {
  const before = mock.requests.length
  await testApp().request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages })
  })
  expect(mock.requests).toHaveLength(before + 1)
  const body = mock.requests.at(-1)?.body
  if (!isRecord(body)) throw new Error('expected a JSON body upstream')
  return { system: body['system'], messages: body['messages'] }
}

describe('a later instruction on a model that accepts mid-conversation system messages', () => {
  // Catches the #45 bug: a later instruction moved to the front, where the model reads it as part
  // of the original setup (and the start of the prompt, and its cache, changes every time).
  test('openai-completions: in place, between the turns where the client put it', async () => {
    expect(await sentConversation('completions/chat-mid', WITH_LATER_INSTRUCTION)).toEqual({
      system: undefined,
      messages: [
        { role: 'system', content: 'You are terse.' },
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello' },
        { role: 'system', content: 'Now answer only in JSON.' },
        { role: 'user', content: 'Weather?' }
      ]
    })
  })

  // Catches the same on Anthropic, where pi places a later system message just before the next
  // assistant turn (Anthropic refuses anything between a tool_use and its tool_result): after the
  // user's question, still before the answer it steers.
  test('anthropic-messages: before the next answer, the system prompt unchanged', async () => {
    expect(await sentConversation('anthropic/claude-mid', WITH_LATER_INSTRUCTION)).toEqual({
      system: [{ type: 'text', text: 'You are terse.', cache_control: { type: 'ephemeral' } }],
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] },
        { role: 'user', content: 'Weather?' },
        {
          role: 'system',
          content: [
            {
              type: 'text',
              text: 'Now answer only in JSON.',
              cache_control: { type: 'ephemeral' }
            }
          ]
        }
      ]
    })
  })
})

describe('a later instruction between a tool call and its result', () => {
  /** The model calls a tool; the client adds an instruction before sending the result back. */
  const BETWEEN_TOOL_CALL_AND_RESULT = [
    { role: 'user', content: 'Weather in Oslo?' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"Oslo"}' }
        }
      ]
    },
    { role: 'system', content: 'Report temperatures in Celsius.' },
    { role: 'tool', tool_call_id: 'call_1', content: '{"temp":5}' }
  ]

  /** Each upstream message's role, with the tool call it answers. */
  function roles(messages: unknown): unknown {
    if (!Array.isArray(messages)) return messages
    return messages.map((message: unknown) => {
      if (!isRecord(message)) return message
      const toolCallId = message['tool_call_id']
      return typeof toolCallId === 'string' ? `tool(${toolCallId})` : message['role']
    })
  }

  // Catches the instruction sent where the client put it, between the tool call and its result:
  // OpenAI requires tool results directly after the assistant message that called the tool, and
  // refuses the request otherwise. pi holds it until after the result.
  test('openai-completions: sent after the tool result', async () => {
    const sent = await sentConversation('completions/chat-mid', BETWEEN_TOOL_CALL_AND_RESULT)

    expect(roles(sent.messages)).toEqual(['user', 'assistant', 'tool(call_1)', 'system'])
  })
})

describe('a later instruction on any other model', () => {
  // Catches the change reaching models that cannot take a mid-conversation instruction: their
  // payload must stay what it was, the instruction merged into the leading prompt.
  test('openai-completions: merged into the leading system message, as before', async () => {
    expect(await sentConversation('completions/chat-plain', WITH_LATER_INSTRUCTION)).toEqual({
      system: undefined,
      messages: [
        { role: 'system', content: 'You are terse.\n\nNow answer only in JSON.' },
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello' },
        { role: 'user', content: 'Weather?' }
      ]
    })
  })

  test('anthropic-messages: merged into the system prompt, as before', async () => {
    expect(await sentConversation('anthropic/claude-plain', WITH_LATER_INSTRUCTION)).toEqual({
      system: [
        {
          type: 'text',
          text: 'You are terse.\n\nNow answer only in JSON.',
          cache_control: { type: 'ephemeral' }
        }
      ],
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] },
        {
          role: 'user',
          content: [{ type: 'text', text: 'Weather?', cache_control: { type: 'ephemeral' } }]
        }
      ]
    })
  })
})

describe('system and developer messages before the first turn', () => {
  // Catches a leading developer message split off as a mid-conversation one: everything before the
  // first turn is the system prompt, on every model.
  test('form the system prompt even on a model that accepts later ones', async () => {
    const leading = [
      { role: 'system', content: 'You are terse.' },
      { role: 'developer', content: 'Use metric units.' },
      { role: 'user', content: 'Hi' }
    ]

    expect(await sentConversation('completions/chat-mid', leading)).toEqual({
      system: undefined,
      messages: [
        { role: 'system', content: 'You are terse.\n\nUse metric units.' },
        { role: 'user', content: 'Hi' }
      ]
    })
  })
})
