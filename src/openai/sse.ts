/**
 * Encodes a pi AssistantMessageEvent stream as OpenAI chat-completion SSE chunks.
 *
 * @remarks
 * - The first chunk has `delta.role = "assistant"`
 * - Text deltas map to `delta.content`, tool call deltas to `delta.tool_calls`
 * - One chunk ID (the request ID) across the whole response
 * - Ends with the `[DONE]` sentinel
 * - With `stream_options.include_usage`, a final usage chunk with empty `choices`
 * - Thinking events are dropped: no non-standard reasoning fields
 *
 * @packageDocumentation
 */

import type { AssistantMessageEvent, Usage } from '@earendil-works/pi-ai'
import { proxyLogger } from '@proxy/logging'
import {
  attemptsSchema,
  type FinishReason,
  finishReasonSchema,
  mapFinishReason,
  loginSchema,
  mapUsage,
  openAIUsageSchema,
  type ResponseRoute,
  routeFields
} from '@proxy/openai/responses'
import { mapFailedCall, type OpenAIError } from '@proxy/server/errors'
import * as z from 'zod'

/** Logger for SSE encoding. */
const sseLogger = proxyLogger('openai', 'sse')

/**
 * One streamed tool call fragment; `id`, `type` and `name` come only in its first fragment.
 * Documents the response; never parsed.
 */
const sseToolCallDeltaSchema = z.object({
  index: z.int(),
  id: z.string().trim().optional(),
  type: z.literal('function').optional(),
  function: z
    .object({
      name: z.string().trim().optional(),
      arguments: z.string().trim().optional().meta({ description: 'The next piece of JSON text.' })
    })
    .optional()
})

/** The incremental `delta` of a chunk choice. Documents the response; never parsed. */
const sseChunkDeltaSchema = z.object({
  role: z.literal('assistant').optional().meta({ description: 'In the first chunk only.' }),
  content: z.string().trim().optional(),
  tool_calls: z.array(sseToolCallDeltaSchema).optional()
})

/** The incremental `delta` of a chunk choice. */
type SSEChunkDelta = z.infer<typeof sseChunkDeltaSchema>

/** One choice of a chunk. Documents the response; never parsed. */
const sseChunkChoiceSchema = z.object({
  index: z.int(),
  delta: sseChunkDeltaSchema,
  finish_reason: finishReasonSchema.nullable()
})

/** One `chat.completion.chunk` SSE payload. Documents the response; never parsed. */
export const sseChunkSchema = z
  .object({
    id: z.string().trim().meta({ description: 'The request ID, the same in every chunk.' }),
    object: z.literal('chat.completion.chunk'),
    created: z.int(),
    model: z.string().trim(),
    choices: z.array(sseChunkChoiceSchema).meta({
      description: 'Empty in the final usage chunk.'
    }),
    usage: openAIUsageSchema.nullable().optional().meta({
      description: 'Only in the final chunk, and only with `stream_options.include_usage`.'
    }),
    x_pi: z
      .object({
        alias: z
          .string()
          .trim()
          .optional()
          .meta({ description: 'The alias the request named (#66).' }),
        login: loginSchema,
        attempts: attemptsSchema
      })
      .optional()
      .meta({
        description:
          "Not OpenAI's: in every chunk, only when the request named an alias or an alias fell " +
          'back (#67).'
      })
  })
  .meta({ id: 'ChatCompletionChunk', description: 'One `data:` event of a streamed completion.' })

/** One `chat.completion.chunk` SSE payload. */
export type SSEChunk = z.infer<typeof sseChunkSchema>

/**
 * Encodes a chunk as an SSE `data:` frame.
 *
 * @param chunk - the chunk payload
 * @returns the frame text, ending in a blank line
 */
export function encodeSSE(chunk: SSEChunk): string {
  return `data: ${JSON.stringify(chunk)}\n\n`
}

/**
 * Encodes the terminal `[DONE]` frame.
 *
 * @returns the frame text
 */
export function encodeDone(): string {
  return 'data: [DONE]\n\n'
}

/** Milliseconds per second, to turn `Date.now()` into a Unix timestamp. */
const MS_PER_SECOND = 1000

/** The fields every chunk of one response shares. */
interface ChunkMeta {
  readonly id: string
  readonly created: number
  readonly model: string
  /** The alias and failed attempts (#66, #67): sent under `x_pi` in every chunk. */
  readonly route: ResponseRoute
}

/**
 * Returns the `x_pi` a chunk carries: the alias and the failed attempts, when there are any.
 *
 * @param meta - the shared chunk fields
 * @returns `{ x_pi: … }`, or nothing to add
 */
function routeField(meta: ChunkMeta): Pick<SSEChunk, 'x_pi'> {
  const fields = routeFields(meta.route)
  return Object.keys(fields).length === 0 ? {} : { x_pi: fields }
}

/** Mutable state of one stream while events are encoded. */
interface StreamState {
  sentFirstChunk: boolean
  finishReason: FinishReason | null
  finalUsage: Usage | undefined
  terminated: boolean
  // Content indexes of started tool calls, in start order; the order gives the OpenAI index
  readonly toolCallIndexes: Map<number, boolean>
}

/**
 * Encodes a chunk with a single choice at index 0.
 *
 * @param meta - the shared chunk fields
 * @param delta - the choice delta
 * @param finishReason - the finish_reason; `null` on every chunk but the last
 * @returns the SSE frame
 */
function encodeChoiceChunk(
  meta: ChunkMeta,
  delta: SSEChunkDelta,
  finishReason: FinishReason | null = null
): string {
  return encodeSSE({
    id: meta.id,
    object: 'chat.completion.chunk',
    created: meta.created,
    model: meta.model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason
      }
    ],
    ...routeField(meta)
  })
}

/**
 * Returns the delta for the next choice chunk, with `role: "assistant"` when it is the stream's
 * first: OpenAI's first chunk carries the role, whichever event produced it (#111).
 *
 * @param state - the stream state; marks the first chunk as sent
 * @param delta - the delta the event produces
 * @returns `delta`, with the role added on the first chunk
 */
function firstDelta(state: StreamState, delta: SSEChunkDelta): SSEChunkDelta {
  if (state.sentFirstChunk) return delta
  state.sentFirstChunk = true
  return { role: 'assistant', ...delta }
}

/**
 * Encodes a text delta.
 *
 * @param meta - the shared chunk fields
 * @param state - the stream state; marks the first chunk as sent
 * @param text - the text delta
 * @returns the SSE frame
 */
function encodeTextDelta(meta: ChunkMeta, state: StreamState, text: string): string {
  return encodeChoiceChunk(meta, firstDelta(state, { content: text }))
}

/**
 * Encodes the first fragment of a tool call: its index, ID, name and empty arguments.
 *
 * @param meta - the shared chunk fields
 * @param state - the stream state; records the tool call's content index
 * @param event - the `toolcall_start` event
 * @returns one frame, or none when the event's content is not a tool call
 */
function encodeToolCallStart(
  meta: ChunkMeta,
  state: StreamState,
  event: Extract<AssistantMessageEvent, { type: 'toolcall_start' }>
): string[] {
  const ci = event.contentIndex
  const toolCallContent = event.partial.content[ci]
  if (toolCallContent === undefined || toolCallContent.type !== 'toolCall') {
    sseLogger.debug('Dropped toolcall_start whose content {contentIndex} is not a tool call', {
      contentIndex: ci
    })
    return []
  }
  // The OpenAI tool call index is the number of tool calls started before this one
  const tcIndex = state.toolCallIndexes.size
  state.toolCallIndexes.set(ci, true)
  return [
    encodeChoiceChunk(
      meta,
      firstDelta(state, {
        tool_calls: [
          {
            index: tcIndex,
            id: toolCallContent.id,
            type: 'function',
            function: {
              name: toolCallContent.name,
              arguments: ''
            }
          }
        ]
      })
    )
  ]
}

/**
 * Encodes an arguments fragment of a started tool call.
 *
 * @param meta - the shared chunk fields
 * @param state - the stream state with the started tool calls
 * @param contentIndex - the pi content index of the tool call
 * @param delta - the arguments JSON fragment
 * @returns one frame, or none when no tool call started at `contentIndex`
 */
function encodeToolCallDelta(
  meta: ChunkMeta,
  state: StreamState,
  contentIndex: number,
  delta: string
): string[] {
  // The OpenAI index is the position of contentIndex among the started tool calls
  let tcIndex = 0
  for (const [ci] of state.toolCallIndexes) {
    if (ci === contentIndex) {
      return [
        encodeChoiceChunk(meta, {
          tool_calls: [
            {
              index: tcIndex,
              function: {
                arguments: delta
              }
            }
          ]
        })
      ]
    }
    tcIndex++
  }
  sseLogger.debug('Dropped toolcall_delta for content {contentIndex} with no started tool call', {
    contentIndex
  })
  return []
}

/**
 * Encodes the error frame for an upstream failure, followed by `[DONE]`.
 *
 * @remarks
 * The body is the one `mapFailedCall` gives a non-streaming answer, with the same fixed text.
 * The upstream message can quote the request, a key or an account, so it stays in the debug log
 * ({@link logUpstreamStreamError}) and never reaches the client.
 *
 * @param body - the mapped OpenAI error body
 * @returns the error frame and the `[DONE]` frame
 */
function encodeUpstreamError(body: OpenAIError): string[] {
  return [`data: ${JSON.stringify(body)}\n\n`, encodeDone()]
}

/**
 * Maps one pi event to the SSE frames it produces, updating stream state.
 *
 * @remarks
 * `done` emits nothing: its finish_reason and usage go out in {@link closingFrames}. `error`
 * marks the stream terminated.
 *
 * @param event - the pi event
 * @param meta - the shared chunk fields
 * @param state - the stream state to update
 * @returns the frames to send, possibly none
 */
function eventToFrames(
  event: AssistantMessageEvent,
  meta: ChunkMeta,
  state: StreamState
): string[] {
  switch (event.type) {
    case 'start':
      return [encodeChoiceChunk(meta, firstDelta(state, {}))]
    case 'text_delta':
      return [encodeTextDelta(meta, state, event.delta)]
    case 'toolcall_start':
      return encodeToolCallStart(meta, state, event)
    case 'toolcall_delta':
      return encodeToolCallDelta(meta, state, event.contentIndex, event.delta)
    case 'done':
      state.finishReason = mapFinishReason(event.reason)
      state.finalUsage = event.message.usage
      sseLogger.debug('Upstream stream done: {stopReason} -> {finishReason}', {
        stopReason: event.reason,
        finishReason: state.finishReason
      })
      return []
    case 'error': {
      state.terminated = true
      const { body } = mapFailedCall(event.error)
      logUpstreamStreamError(event, body.error.code)
      return encodeUpstreamError(body)
    }
    // Not mapped to SSE output in the stable path.
    case 'text_start':
    case 'text_end':
    case 'thinking_start':
    case 'thinking_delta':
    case 'thinking_end':
    case 'toolcall_end':
      break
  }
  return []
}

/**
 * Logs an upstream error event.
 *
 * @remarks
 * The provider's raw message goes to debug only, as in the route's handler: some providers quote
 * parts of the request back, and request content is never logged at a level a default
 * deployment writes.
 *
 * @param event - the pi `error` event
 * @param code - the OpenAI error code sent to the client
 */
function logUpstreamStreamError(
  event: Extract<AssistantMessageEvent, { type: 'error' }>,
  code: string | null
): void {
  // `aborted` is the upstream call cancelled, usually because the client disconnected.
  if (event.reason === 'aborted') {
    sseLogger.warn('Upstream stream aborted', { stopReason: event.reason })
  } else {
    sseLogger.error('Upstream error inside stream ({stopReason}): {code}', {
      stopReason: event.reason,
      code
    })
  }
  const detail = event.error.errorMessage
  if (detail !== undefined) {
    sseLogger.debug('Upstream stream error detail: {detail}', { detail })
  }
}

/**
 * Builds the frames after the last upstream event.
 *
 * @param meta - the shared chunk fields
 * @param state - the final stream state
 * @param includeUsage - whether the client asked for a usage chunk
 * @param eventCount - the number of upstream events, for the log
 * @returns the finish_reason chunk (omitted without a `done` event), the usage chunk when
 *   requested and known, and the `[DONE]` frame
 */
function closingFrames(
  meta: ChunkMeta,
  state: StreamState,
  includeUsage: boolean,
  eventCount: number
): string[] {
  const frames: string[] = []
  if (state.finishReason === null) {
    sseLogger.warn('Upstream stream ended without a done event; sending no finish_reason', {
      eventCount
    })
  } else {
    frames.push(encodeChoiceChunk(meta, firstDelta(state, {}), state.finishReason))
  }

  if (includeUsage && state.finalUsage !== undefined) {
    frames.push(
      encodeSSE({
        id: meta.id,
        object: 'chat.completion.chunk',
        created: meta.created,
        model: meta.model,
        choices: [],
        usage: mapUsage(state.finalUsage),
        ...routeField(meta)
      })
    )
  }

  frames.push(encodeDone())
  return frames
}

/** What every chunk of one stream reports, besides its events. */
export interface StreamIdentity {
  /** The chunk `id`. */
  readonly requestId: string
  /** The model that answers, reported in each chunk, and the alias and attempts (#66, #67). */
  readonly route: ResponseRoute
}

/**
 * Converts a pi event stream into SSE text frames.
 *
 * @remarks
 * Stops after an upstream `error` event (its frames already end in `[DONE]`). Errors thrown by
 * `events` are rethrown after the end of the stream is logged.
 *
 * @param events - pi's event stream for one response
 * @param identity - the request ID, and the route every chunk reports
 * @param includeUsage - whether to send a final usage chunk
 * @returns an async generator of SSE frames
 * @throws whatever iterating `events` throws
 */
export async function* streamToSSE(
  events: AsyncIterable<AssistantMessageEvent>,
  identity: StreamIdentity,
  includeUsage: boolean
): AsyncGenerator<string> {
  const { requestId, route } = identity
  const model = route.model
  const meta: ChunkMeta = {
    id: requestId,
    created: Math.floor(Date.now() / MS_PER_SECOND),
    model,
    route
  }
  const state: StreamState = {
    sentFirstChunk: false,
    finishReason: null,
    finalUsage: undefined,
    terminated: false,
    toolCallIndexes: new Map<number, boolean>()
  }

  sseLogger.debug('Starting stream for {model}', { model, includeUsage })
  const startedAt = performance.now()
  let eventCount = 0
  let frameCount = 0
  let completed = false
  let failed = false

  try {
    for await (const event of events) {
      eventCount++
      sseLogger.trace('Upstream event {eventType}', { eventType: event.type })
      const frames = eventToFrames(event, meta, state)
      frameCount += frames.length
      yield* frames
      if (state.terminated) {
        completed = true
        return
      }
    }

    const frames = closingFrames(meta, state, includeUsage, eventCount)
    frameCount += frames.length
    yield* frames
    completed = true
  } catch (error) {
    failed = true
    throw error
  } finally {
    logStreamEnd(state, {
      completed,
      failed,
      eventCount,
      frameCount,
      durationMs: Math.round(performance.now() - startedAt)
    })
  }
}

/** Counters and outcome flags for {@link logStreamEnd}. */
interface StreamEndSummary {
  readonly completed: boolean
  readonly failed: boolean
  readonly eventCount: number
  readonly frameCount: number
  readonly durationMs: number
}

/**
 * Logs one line for how a stream ended: finished, failed (the caller logs the error), or
 * abandoned by the client.
 *
 * @param state - the final stream state
 * @param summary - the outcome flags and counters
 */
function logStreamEnd(state: StreamState, summary: StreamEndSummary): void {
  const { completed, failed, ...counts } = summary
  if (failed) {
    sseLogger.debug('Stream failed after {eventCount} events and {frameCount} frames', counts)
    return
  }
  if (!completed) {
    sseLogger.debug('Client closed the stream after {frameCount} frames', counts)
    return
  }
  const usage = state.finalUsage
  sseLogger.debug('Stream finished: {finishReason}, {frameCount} frames in {durationMs} ms', {
    ...counts,
    finishReason: state.finishReason,
    upstreamError: state.terminated,
    toolCallCount: state.toolCallIndexes.size,
    promptTokens: usage === undefined ? null : usage.input + usage.cacheRead + usage.cacheWrite,
    completionTokens: usage?.output ?? null,
    totalTokens: usage?.totalTokens ?? null,
    cacheReadTokens: usage?.cacheRead ?? null,
    cacheWriteTokens: usage?.cacheWrite ?? null
  })
}
