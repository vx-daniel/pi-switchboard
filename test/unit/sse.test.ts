import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai'
import { resetSync } from '@logtape/logtape'
import { configureLogging } from '@proxy/logging'
import { encodeDone, encodeSSE, streamToSSE } from '@proxy/openai/sse'
import { isRecord } from '@proxy/utils/guards'
import { afterEach, describe, expect, test } from 'vite-plus/test'

describe('encodeSSE', () => {
  test('encodes a chunk as SSE data frame', () => {
    const chunk = {
      id: 'req-1',
      object: 'chat.completion.chunk' as const,
      created: 1234567890,
      model: 'openai/gpt-4o',
      choices: [
        {
          index: 0,
          delta: { role: 'assistant' as const },
          finish_reason: null
        }
      ]
    }

    const result = encodeSSE(chunk)
    expect(result).toMatch(/^data: /)
    expect(result).toMatch(/\n\n$/)

    const parsed = JSON.parse(result.slice(6))
    expect(parsed.id).toBe('req-1')
    expect(parsed.object).toBe('chat.completion.chunk')
    expect(parsed.choices[0].delta.role).toBe('assistant')
  })
})

describe('encodeDone', () => {
  test('returns [DONE] sentinel', () => {
    expect(encodeDone()).toBe('data: [DONE]\n\n')
  })
})

/**
 * Builds an empty OpenAI Responses assistant message that ended in an error.
 *
 * @param errorMessage - the upstream error text pi reports in `errorMessage`
 * @returns the assistant message, with stop reason `error` and zero usage
 */
function makeErrorMessage(errorMessage: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: 'openai-responses',
    provider: 'openai',
    model: 'gpt-5.4-mini',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: 'error',
    errorMessage,
    timestamp: Date.now()
  }
}

/**
 * Replays pi stream events as an async stream.
 *
 * @param events - the events to yield, in order
 * @returns a generator that yields `events` one by one
 */
async function* yieldEvents(
  events: AssistantMessageEvent[]
): AsyncGenerator<AssistantMessageEvent> {
  for (const event of events) yield event
}

describe('streamToSSE', () => {
  // Catches an upstream failure ending the stream as a normal stop, without `[DONE]`, or with the
  // upstream message in the frame instead of the fixed mapped text (#54).
  test('emits the mapped error frame and [DONE] for an upstream error event', async () => {
    const upstreamMessage = '401 {"error":{"message":"notarealsecret-quoted-in-error"}}'
    const events: AssistantMessageEvent[] = [
      { type: 'error', reason: 'error', error: makeErrorMessage(upstreamMessage) }
    ]

    const frames: string[] = []
    for await (const frame of streamToSSE(
      yieldEvents(events),
      { requestId: 'req-1', route: { model: 'openai/gpt-5.4-mini' } },
      false
    )) {
      frames.push(frame)
    }

    expect(frames).toEqual([
      `data: ${JSON.stringify({ error: { message: 'Upstream authentication failed', type: 'server_error', param: null, code: 'upstream_auth_error' } })}\n\n`,
      'data: [DONE]\n\n'
    ])
  })

  // Catches an overflow reported after the stream started (its 200 already sent) arriving as a
  // generic upstream error: the SSE event must carry the code agent clients compact on (#40).
  test('maps an overflow after the stream started to context_length_exceeded', async () => {
    const overflow = makeErrorMessage(
      'Your input exceeds the context window of this model. notarealsecret-quoted-prompt'
    )
    const events: AssistantMessageEvent[] = [
      { type: 'start', partial: overflow },
      { type: 'error', reason: 'error', error: overflow }
    ]

    const frames: string[] = []
    for await (const frame of streamToSSE(
      yieldEvents(events),
      { requestId: 'req-1', route: { model: 'openai/gpt-5.4-mini' } },
      false
    )) {
      frames.push(frame)
    }

    expect(frames.slice(1)).toEqual([
      `data: ${JSON.stringify({ error: { message: "The messages exceed the model's context window. Shorten or summarize them and try again.", type: 'invalid_request_error', param: 'messages', code: 'context_length_exceeded' } })}\n\n`,
      'data: [DONE]\n\n'
    ])
  })

  test('emits normal stop for successful done events', async () => {
    const doneMsg = makeErrorMessage('')
    doneMsg.stopReason = 'stop'
    const events: AssistantMessageEvent[] = [
      { type: 'start', partial: doneMsg },
      { type: 'done', reason: 'stop', message: doneMsg }
    ]

    const frames: string[] = []
    for await (const frame of streamToSSE(
      yieldEvents(events),
      { requestId: 'req-1', route: { model: 'test/model' } },
      false
    )) {
      frames.push(frame)
    }

    // start chunk + finish chunk + [DONE]
    expect(frames).toHaveLength(3)
    const finishFrame = JSON.parse(frames[1]?.slice(6) ?? '')
    expect(finishFrame.choices[0].finish_reason).toBe('stop')
  })

  // Catches the role sent only on a `start` or text chunk (#111): a stream whose first event is a
  // tool call, or that ends with no content at all, must still open with `role: "assistant"`, and
  // no later chunk may repeat it.
  test.each([
    {
      first: 'toolcall_start',
      events: (message: AssistantMessage): AssistantMessageEvent[] => [
        { type: 'toolcall_start', contentIndex: 0, partial: message },
        { type: 'done', reason: 'toolUse', message }
      ],
      deltas: [
        {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'call-1',
              type: 'function',
              function: { name: 'lookup', arguments: '' }
            }
          ]
        },
        {}
      ]
    },
    {
      first: 'done',
      events: (message: AssistantMessage): AssistantMessageEvent[] => [
        { type: 'done', reason: 'stop', message }
      ],
      deltas: [{ role: 'assistant' }]
    }
  ])(
    'the first chunk carries the role when the first event is $first',
    async ({ events, deltas }) => {
      const message: AssistantMessage = {
        ...makeErrorMessage(''),
        stopReason: 'stop',
        content: [{ type: 'toolCall', id: 'call-1', name: 'lookup', arguments: {} }]
      }

      const frames: string[] = []
      for await (const frame of streamToSSE(
        yieldEvents(events(message)),
        { requestId: 'req-1', route: { model: 'test/model' } },
        false
      )) {
        frames.push(frame)
      }

      const sentDeltas = frames
        .filter((frame) => frame !== 'data: [DONE]\n\n')
        .map((frame): unknown => {
          const chunk: unknown = JSON.parse(frame.slice('data: '.length))
          const choices: unknown = isRecord(chunk) ? chunk['choices'] : undefined
          const choice: unknown = Array.isArray(choices) ? choices.at(0) : undefined
          return isRecord(choice) ? choice['delta'] : undefined
        })
      expect(sentDeltas).toEqual(deltas)
    }
  )
})

describe('upstream error logging', () => {
  afterEach(() => {
    resetSync()
  })

  /**
   * Streams one upstream error event whose text quotes the request, and captures the log lines.
   *
   * @remarks
   * Some providers quote the request back in their error text. The tests below catch that text
   * reaching a level a default deployment writes, while keeping it available to someone
   * debugging.
   *
   * @param level - the lowest log level to write
   * @returns the JSON log lines written while the stream ran
   */
  async function logLinesFor(level: 'info' | 'debug'): Promise<string[]> {
    const lines: string[] = []
    configureLogging({ level, format: 'json', write: (line) => lines.push(line) })
    const echoed = makeErrorMessage('Invalid request: "echoed user prompt" is too long')
    const events: AssistantMessageEvent[] = [{ type: 'error', reason: 'error', error: echoed }]
    for await (const frame of streamToSSE(
      yieldEvents(events),
      { requestId: 'req-1', route: { model: 'p/m' } },
      false
    )) {
      expect(frame.length).toBeGreaterThan(0)
    }
    return lines
  }

  test('logs the error without the provider text at info', async () => {
    const lines = await logLinesFor('info')
    expect(lines.some((line) => line.includes('"ERROR"'))).toBe(true)
    expect(lines.join('')).not.toContain('echoed user prompt')
  })

  test('keeps the provider text for debugging at debug', async () => {
    const lines = await logLinesFor('debug')
    const detailLines = lines.filter((line) => line.includes('echoed user prompt'))
    expect(detailLines).toHaveLength(1)
    expect(detailLines[0]).toContain('"DEBUG"')
  })
})
