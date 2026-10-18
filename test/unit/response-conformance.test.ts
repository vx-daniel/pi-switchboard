/**
 * Non-streaming response conformance tests.
 *
 * Validates that buildChatCompletion() output matches the OpenAI
 * ChatCompletion contract the official SDK expects.
 */

import type {
  AssistantMessage,
  JsonObject,
  TextContent,
  ToolCall,
  Usage
} from '@earendil-works/pi-ai'
import { buildChatCompletion } from '@proxy/openai/responses'
import { describe, expect, test } from 'vite-plus/test'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a pi `Usage` of 10 input and 20 output tokens at zero cost.
 *
 * @param overrides - fields to replace in the default usage
 * @returns the usage record
 */
function makeUsage(overrides: Partial<Usage> = {}): Usage {
  return {
    input: 10,
    output: 20,
    totalTokens: 30,
    cacheRead: 0,
    cacheWrite: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...overrides
  }
}

/**
 * Builds a complete AssistantMessage with these content blocks.
 *
 * @remarks
 * buildChatCompletion reads content, stopReason and usage; the identity fields and timestamp are
 * fixed placeholders. The provider and model differ from every canonical ID the tests pass, so a
 * response that took its `model` from the upstream message instead of the canonical ID fails the
 * `model` assertions.
 *
 * @param content - the message's content blocks
 * @param stopReason - pi's stop reason for the message
 * @param overrides - fields to replace in the built message
 * @returns the assistant message
 */
function makeMessage(
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason'],
  overrides: Partial<AssistantMessage>
): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'upstream-provider',
    model: 'upstream-model',
    stopReason,
    usage: makeUsage(),
    timestamp: 0,
    ...overrides
  }
}

/**
 * Builds an assistant message of one text block that stopped normally.
 *
 * @param text - the text block's content
 * @param overrides - fields to replace in the built message, such as `stopReason` or `usage`
 * @returns the assistant message
 */
function makeTextMessage(
  text: string,
  overrides: Partial<AssistantMessage> = {}
): AssistantMessage {
  const content: TextContent = { type: 'text', text }
  return makeMessage([content], 'stop', overrides)
}

/**
 * Builds an assistant message of tool calls only, with stop reason `toolUse`.
 *
 * @param calls - the tool calls, in order: ID, tool name, and parsed arguments
 * @param overrides - fields to replace in the built message
 * @returns the assistant message
 */
function makeToolCallMessage(
  calls: { id: string; name: string; args: JsonObject }[],
  overrides: Partial<AssistantMessage> = {}
): AssistantMessage {
  const content: ToolCall[] = calls.map((call) => ({
    type: 'toolCall',
    id: call.id,
    name: call.name,
    arguments: call.args
  }))
  return makeMessage(content, 'toolUse', overrides)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('non-streaming response conformance', () => {
  test('has all required top-level fields', () => {
    const result = buildChatCompletion('req-1', 'openai/gpt-4o', makeTextMessage('Hello'))

    expect(result.id).toBe('req-1')
    expect(result.object).toBe('chat.completion')
    expect(result.created).toBeTypeOf('number')
    expect(result.created).toBeGreaterThan(0)
    expect(result.model).toBe('openai/gpt-4o')
    expect(result.choices).toBeInstanceOf(Array)
    expect(result.choices.length).toBe(1)
    expect(result.usage).toBeDefined()
  })

  test('choices[0].finish_reason is never null', () => {
    const result = buildChatCompletion('req-2', 'openai/gpt-4o', makeTextMessage('Hi'))

    const choice = result.choices[0]
    expect(choice).toBeDefined()
    expect(choice?.finish_reason).not.toBeNull()
    expect(choice?.finish_reason).toBe('stop')
  })

  test('finish_reason maps correctly for all stop reasons', () => {
    const mapping: [AssistantMessage['stopReason'], string][] = [
      ['stop', 'stop'],
      ['length', 'length'],
      ['toolUse', 'tool_calls'],
      ['error', 'stop'],
      ['aborted', 'stop']
    ]

    for (const [piReason, expected] of mapping) {
      const message = makeTextMessage('test', { stopReason: piReason })
      const result = buildChatCompletion('req', 'm', message)
      expect(result.choices[0]?.finish_reason).toBe(expected)
    }
  })

  test('choices[0].message.role is assistant', () => {
    const result = buildChatCompletion('req-3', 'm', makeTextMessage('Hi'))
    expect(result.choices[0]?.message.role).toBe('assistant')
  })

  test('content is string for text responses', () => {
    const result = buildChatCompletion('req-4', 'm', makeTextMessage('Hello world'))
    const content = result.choices[0]?.message.content
    expect(content).toBeTypeOf('string')
    expect(content).toBe('Hello world')
  })

  test('content is null when no text parts exist', () => {
    const message = makeToolCallMessage([
      { id: 'tc-1', name: 'get_weather', args: { city: 'NYC' } }
    ])
    const result = buildChatCompletion('req-5', 'm', message)
    const content = result.choices[0]?.message.content
    // Must be explicitly null, not undefined
    expect(content).toBeNull()
  })

  test('tool_calls shape matches OpenAI contract', () => {
    const message = makeToolCallMessage([
      { id: 'call_abc', name: 'get_weather', args: { city: 'NYC' } },
      { id: 'call_def', name: 'search', args: { query: 'hello' } }
    ])
    const result = buildChatCompletion('req-6', 'm', message)
    const toolCalls = result.choices[0]?.message.tool_calls

    expect(toolCalls).toBeDefined()
    expect(toolCalls?.length).toBe(2)

    const first = toolCalls?.[0]
    expect(first?.id).toBe('call_abc')
    expect(first?.type).toBe('function')
    expect(first?.function.name).toBeTypeOf('string')
    expect(first?.function.name).toBe('get_weather')
    expect(first?.function.arguments).toBeTypeOf('string')
    // arguments must be a JSON string, not an object
    expect(JSON.parse(first?.function.arguments ?? '')).toEqual({ city: 'NYC' })
  })

  test('tool_calls is absent (not empty array) when no tool calls', () => {
    const result = buildChatCompletion('req-7', 'm', makeTextMessage('Hi'))
    expect(result.choices[0]?.message.tool_calls).toBeUndefined()
  })

  test('usage fields are all numbers', () => {
    const message = makeTextMessage('Hi', {
      usage: makeUsage({ input: 15, output: 25, totalTokens: 40 })
    })
    const result = buildChatCompletion('req-8', 'm', message)

    expect(result.usage.prompt_tokens).toBeTypeOf('number')
    expect(result.usage.completion_tokens).toBeTypeOf('number')
    expect(result.usage.total_tokens).toBeTypeOf('number')
    expect(result.usage.prompt_tokens).toBe(15)
    expect(result.usage.completion_tokens).toBe(25)
    expect(result.usage.total_tokens).toBe(40)
  })

  test('choices[0].index is 0', () => {
    const result = buildChatCompletion('req-9', 'm', makeTextMessage('Hi'))
    expect(result.choices[0]?.index).toBe(0)
  })
})
