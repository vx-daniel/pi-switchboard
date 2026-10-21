/**
 * Wire-level SSE conformance tests.
 *
 * Validates that streamToSSE() output matches the OpenAI ChatCompletionChunk
 * contract the official SDK expects. Uses mock pi events, no credentials needed.
 */

import type {
  AssistantMessage,
  AssistantMessageEvent,
  ToolCall,
  Usage
} from '@earendil-works/pi-ai'
import type { SSEChunk } from '@proxy/openai/sse'
import { encodeDone, streamToSSE } from '@proxy/openai/sse'
import { isRecord } from '@proxy/utils/guards'
import { describe, expect, test } from 'vite-plus/test'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Checks the fields `streamToSSE` emits on every chunk: `id`, `object`, `created`, `model` and
 * `choices`.
 *
 * @param value - a parsed JSON value from a data frame
 * @returns whether `value` has the SSEChunk shape
 */
function isSSEChunk(value: unknown): value is SSEChunk {
  if (!isRecord(value)) return false
  return (
    typeof value['id'] === 'string' &&
    value['object'] === 'chat.completion.chunk' &&
    typeof value['created'] === 'number' &&
    typeof value['model'] === 'string' &&
    Array.isArray(value['choices'])
  )
}

/** Sentinel value for the terminal [DONE] frame. */
const DONE_SENTINEL = '[DONE]' as const

type ParsedFrame = SSEChunk | typeof DONE_SENTINEL | null

/**
 * Builds a pi `Usage` of 10 input and 20 output tokens at zero cost.
 *
 * @returns the usage record
 */
function makeUsage(): Usage {
  return {
    input: 10,
    output: 20,
    totalTokens: 30,
    cacheRead: 0,
    cacheWrite: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  }
}

/**
 * Builds a complete partial AssistantMessage with these content blocks.
 *
 * @remarks
 * streamToSSE reads the partial's content and the done message's usage (the finish reason comes
 * from the event); the identity fields, stopReason and timestamp are fixed placeholders. The model
 * differs from the `test-model` the stream is opened with, so a chunk that took its `model` from
 * the upstream message instead fails the `model` assertion.
 *
 * @param content - the message's content blocks; none by default
 * @returns the assistant message
 */
function makePartial(content: AssistantMessage['content'] = []): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'upstream-provider',
    model: 'upstream-model',
    stopReason: 'stop',
    usage: makeUsage(),
    timestamp: 0
  }
}

/**
 * Replays pi stream events as an async stream.
 *
 * @param events - the events to yield, in order
 * @returns a generator that yields `events` one by one
 */
async function* mockEvents(events: AssistantMessageEvent[]): AsyncGenerator<AssistantMessageEvent> {
  for (const event of events) {
    yield event
  }
}

/**
 * Runs `streamToSSE` over the events, as request `req-1` for model `test-model`.
 *
 * @param events - the pi stream events to encode
 * @param includeUsage - whether to emit the usage chunk (`stream_options.include_usage`)
 * @returns every SSE frame, in order, including the final `[DONE]`
 */
async function collectFrames(
  events: AssistantMessageEvent[],
  includeUsage = false
): Promise<string[]> {
  const frames: string[] = []
  for await (const frame of streamToSSE(
    mockEvents(events),
    { requestId: 'req-1', model: 'test-model', alias: undefined },
    includeUsage
  )) {
    frames.push(frame)
  }
  return frames
}

/**
 * Parses SSE frames into typed chunks.
 *
 * @param frames - raw SSE frames from {@link collectFrames}
 * @returns per frame: the SSEChunk, `[DONE]` for the terminal frame, or `null` for a frame that
 *   is not a data frame or not chunk-shaped
 * @throws SyntaxError when a data frame's payload is not JSON
 */
function parseChunks(frames: string[]): ParsedFrame[] {
  return frames.map((frame): ParsedFrame => {
    if (!frame.startsWith('data: ')) return null
    const json = frame.slice(6).trim()
    if (json === '[DONE]') return DONE_SENTINEL
    const parsed: unknown = JSON.parse(json)
    if (!isSSEChunk(parsed)) return null
    return parsed
  })
}

/**
 * Keeps only the SSEChunk objects.
 *
 * @param frames - frames from {@link parseChunks}
 * @returns the chunks, without `[DONE]` and `null` entries
 */
function chunkFrames(frames: ParsedFrame[]): SSEChunk[] {
  return frames.filter((chunk): chunk is SSEChunk => chunk !== DONE_SENTINEL && chunk !== null)
}

/**
 * Keeps only the chunks that have at least one choice, dropping the usage chunk.
 *
 * @param frames - frames from {@link parseChunks}
 * @returns the chunks with a non-empty `choices` array
 */
function chunksWithChoices(frames: ParsedFrame[]): SSEChunk[] {
  return chunkFrames(frames).filter((chunk) => chunk.choices.length > 0)
}

// ---------------------------------------------------------------------------
// Text streaming
// ---------------------------------------------------------------------------

describe('SSE text streaming conformance', () => {
  const textEvents: AssistantMessageEvent[] = [
    { type: 'start', partial: makePartial() },
    { type: 'text_start', contentIndex: 0, partial: makePartial([{ type: 'text', text: '' }]) },
    {
      type: 'text_delta',
      contentIndex: 0,
      delta: 'Hello',
      partial: makePartial([{ type: 'text', text: 'Hello' }])
    },
    {
      type: 'text_delta',
      contentIndex: 0,
      delta: ' world',
      partial: makePartial([{ type: 'text', text: 'Hello world' }])
    },
    {
      type: 'text_end',
      contentIndex: 0,
      content: 'Hello world',
      partial: makePartial([{ type: 'text', text: 'Hello world' }])
    },
    {
      type: 'done',
      reason: 'stop',
      message: { ...makePartial([{ type: 'text', text: 'Hello world' }]), stopReason: 'stop' }
    }
  ]

  test('each chunk has required fields: id, object, created, model', async () => {
    const frames = await collectFrames(textEvents)
    const chunks = chunkFrames(parseChunks(frames))

    for (const chunk of chunks) {
      expect(chunk.id).toBe('req-1')
      expect(chunk.object).toBe('chat.completion.chunk')
      expect(chunk.created).toBeTypeOf('number')
      expect(chunk.created).toBeGreaterThan(0)
      expect(chunk.model).toBe('test-model')
    }
  })

  test('first chunk has delta.role = assistant', async () => {
    const frames = await collectFrames(textEvents)
    const chunks = chunkFrames(parseChunks(frames))
    const first = chunks[0]
    expect(first).toBeDefined()
    if (first === undefined) return
    const choice = first.choices[0]
    expect(choice).toBeDefined()
    if (choice === undefined) return
    expect(choice.delta.role).toBe('assistant')
  })

  test('delta.content is a string on text delta chunks', async () => {
    const frames = await collectFrames(textEvents)
    const chunks = chunkFrames(parseChunks(frames))

    const contentChunks = chunks.filter((chunk) => {
      const choice = chunk.choices[0]
      return choice !== undefined && choice.delta.content !== undefined
    })

    expect(contentChunks.length).toBeGreaterThan(0)
    for (const chunk of contentChunks) {
      const choice = chunk.choices[0]
      expect(choice).toBeDefined()
      if (choice === undefined) continue
      expect(choice.delta.content).toBeTypeOf('string')
    }
  })

  test('finish_reason is null on intermediate chunks, set on final', async () => {
    const frames = await collectFrames(textEvents)
    const chunks = chunksWithChoices(parseChunks(frames))

    // All but last should be null
    for (let chunkIndex = 0; chunkIndex < chunks.length - 1; chunkIndex++) {
      const chunk = chunks[chunkIndex]
      if (chunk === undefined) continue
      const choice = chunk.choices[0]
      if (choice === undefined) continue
      expect(choice.finish_reason).toBeNull()
    }

    // Last chunk with choices should have finish_reason set
    const last = chunks[chunks.length - 1]
    expect(last).toBeDefined()
    if (last === undefined) return
    const lastChoice = last.choices[0]
    expect(lastChoice).toBeDefined()
    if (lastChoice === undefined) return
    expect(lastChoice.finish_reason).toBe('stop')
  })

  test('final frame is data: [DONE]', async () => {
    const frames = await collectFrames(textEvents)
    expect(frames[frames.length - 1]).toBe('data: [DONE]\n\n')
  })

  test('chunk id is stable across the full stream', async () => {
    const frames = await collectFrames(textEvents)
    const chunks = chunkFrames(parseChunks(frames))
    const ids = chunks.map((chunk) => chunk.id)

    const unique = new Set(ids)
    expect(unique.size).toBe(1)
    expect([...unique][0]).toBe('req-1')
  })
})

// ---------------------------------------------------------------------------
// Usage chunk
// ---------------------------------------------------------------------------

describe('SSE usage chunk conformance', () => {
  const events: AssistantMessageEvent[] = [
    { type: 'start', partial: makePartial() },
    {
      type: 'text_delta',
      contentIndex: 0,
      delta: 'Hi',
      partial: makePartial([{ type: 'text', text: 'Hi' }])
    },
    {
      type: 'done',
      reason: 'stop',
      message: { ...makePartial([{ type: 'text', text: 'Hi' }]), stopReason: 'stop' }
    }
  ]

  test('usage chunk has empty choices array and populated usage', async () => {
    const frames = await collectFrames(events, true)
    const chunks = chunkFrames(parseChunks(frames))

    const usageChunk = chunks.find((chunk) => chunk.choices.length === 0)

    expect(usageChunk).toBeDefined()
    if (usageChunk === undefined) return
    expect(usageChunk.choices).toEqual([])
    expect(usageChunk.usage).toBeDefined()
    if (usageChunk.usage === undefined || usageChunk.usage === null) return
    expect(usageChunk.usage.prompt_tokens).toBeTypeOf('number')
    expect(usageChunk.usage.completion_tokens).toBeTypeOf('number')
    expect(usageChunk.usage.total_tokens).toBeTypeOf('number')
  })

  test('usage chunk is absent when include_usage is false', async () => {
    const frames = await collectFrames(events, false)
    const chunks = chunkFrames(parseChunks(frames))

    const usageChunk = chunks.find((chunk) => chunk.choices.length === 0)
    expect(usageChunk).toBeUndefined()
  })

  // Catches the streamed usage chunk reporting only Pi's uncached `input` as prompt_tokens. Docker
  // Agent reads context size and its compaction trigger from this chunk; with prompt caching a
  // ~9,650-token prompt arrived as prompt_tokens 4. Numbers are those of the measured case.
  test('usage chunk counts cached tokens in prompt_tokens and breaks them out', async () => {
    const cachedMessage: AssistantMessage = {
      ...makePartial([{ type: 'text', text: 'Hi' }]),
      stopReason: 'stop',
      usage: {
        input: 4,
        output: 4,
        cacheRead: 9000,
        cacheWrite: 642,
        totalTokens: 9650,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      }
    }
    const cachedEvents: AssistantMessageEvent[] = [
      { type: 'start', partial: makePartial() },
      { type: 'done', reason: 'stop', message: cachedMessage }
    ]

    const chunks = chunkFrames(parseChunks(await collectFrames(cachedEvents, true)))
    const usage = chunks.find((chunk) => chunk.choices.length === 0)?.usage

    expect(usage).toEqual({
      prompt_tokens: 9646,
      completion_tokens: 4,
      total_tokens: 9650,
      prompt_tokens_details: { cached_tokens: 9000, cache_write_tokens: 642 }
    })
  })
})

// ---------------------------------------------------------------------------
// Tool call streaming
// ---------------------------------------------------------------------------

describe('SSE tool call streaming conformance', () => {
  const toolCall: ToolCall = {
    type: 'toolCall',
    id: 'call_abc',
    name: 'get_weather',
    arguments: {}
  }
  const toolCallDone: ToolCall = {
    type: 'toolCall',
    id: 'call_abc',
    name: 'get_weather',
    arguments: { city: 'NYC' }
  }

  const toolEvents: AssistantMessageEvent[] = [
    { type: 'start', partial: makePartial() },
    { type: 'toolcall_start', contentIndex: 0, partial: makePartial([toolCall]) },
    {
      type: 'toolcall_delta',
      contentIndex: 0,
      delta: '{"city":',
      partial: makePartial([toolCall])
    },
    {
      type: 'toolcall_delta',
      contentIndex: 0,
      delta: '"NYC"}',
      partial: makePartial([toolCallDone])
    },
    {
      type: 'toolcall_end',
      contentIndex: 0,
      toolCall: toolCallDone,
      partial: makePartial([toolCallDone])
    },
    {
      type: 'done',
      reason: 'toolUse',
      message: { ...makePartial([toolCallDone]), stopReason: 'toolUse' }
    }
  ]

  test('tool call start chunk has index, id, type, function.name', async () => {
    const frames = await collectFrames(toolEvents)
    const chunks = chunkFrames(parseChunks(frames))

    const tcStartChunk = chunks.find((chunk) => {
      const tc = chunk.choices[0]?.delta.tool_calls?.[0]
      return tc !== undefined && tc.id !== undefined
    })

    expect(tcStartChunk).toBeDefined()
    if (tcStartChunk === undefined) return
    const choice = tcStartChunk.choices[0]
    expect(choice).toBeDefined()
    if (choice === undefined) return
    const tc = choice.delta.tool_calls?.[0]
    expect(tc).toBeDefined()
    if (tc === undefined) return
    expect(tc.index).toBeTypeOf('number')
    expect(tc.index).toBe(0)
    expect(tc.id).toBe('call_abc')
    expect(tc.type).toBe('function')
    expect(tc.function).toBeDefined()
    if (tc.function === undefined) return
    expect(tc.function.name).toBe('get_weather')
  })

  test('tool call delta chunks have index and function.arguments', async () => {
    const frames = await collectFrames(toolEvents)
    const chunks = chunkFrames(parseChunks(frames))

    const deltaChunks = chunks.filter((chunk) => {
      const tc = chunk.choices[0]?.delta.tool_calls?.[0]
      return tc !== undefined && tc.id === undefined
    })

    expect(deltaChunks.length).toBe(2)
    for (const chunk of deltaChunks) {
      const choice = chunk.choices[0]
      expect(choice).toBeDefined()
      if (choice === undefined) continue
      const tc = choice.delta.tool_calls?.[0]
      expect(tc).toBeDefined()
      if (tc === undefined) continue
      expect(tc.index).toBeTypeOf('number')
      expect(tc.function).toBeDefined()
      if (tc.function === undefined) continue
      expect(tc.function.arguments).toBeTypeOf('string')
    }
  })

  test('finish_reason is tool_calls on final chunk', async () => {
    const frames = await collectFrames(toolEvents)
    const chunks = chunksWithChoices(parseChunks(frames))

    const last = chunks[chunks.length - 1]
    expect(last).toBeDefined()
    if (last === undefined) return
    const lastChoice = last.choices[0]
    expect(lastChoice).toBeDefined()
    if (lastChoice === undefined) return
    expect(lastChoice.finish_reason).toBe('tool_calls')
  })
})

// ---------------------------------------------------------------------------
// encodeDone
// ---------------------------------------------------------------------------

describe('encodeDone', () => {
  test('produces correct terminal frame', () => {
    expect(encodeDone()).toBe('data: [DONE]\n\n')
  })
})
