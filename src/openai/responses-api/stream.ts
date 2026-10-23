/**
 * The Responses API's stream (#140): pi's events as `response.*` server-sent events.
 *
 * @remarks
 * Each pi content block is one output item, at the same index: thinking a `reasoning` item (its
 * text as one summary part), text a `message` with one `output_text` part, a tool call a
 * `function_call`. The order of events follows OpenAI's:
 * - `response.created` and `response.in_progress` on pi's first event;
 * - per item, `response.output_item.added`, its part or summary part added, its deltas, their
 *   `.done`, and `response.output_item.done`;
 * - `response.completed` (or `response.incomplete` for a length stop) with the whole response and
 *   its usage, or `response.failed` with the error.
 *
 * Every event carries a `sequence_number` from 0. The upstream error text never reaches the client:
 * the failure gets the fixed message chat completions give it (`mapFailedCall`).
 *
 * @packageDocumentation
 */

import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai'
import { proxyLogger } from '@proxy/logging'
import type { ResponseRoute } from '@proxy/openai/responses'
import {
  functionCallItem,
  itemId,
  messageItem,
  type OutputItem,
  outputItems,
  reasoningItem,
  type ResponseFrame,
  responseObject,
  type ResponseStatus,
  responsesUsage,
  responsesXPi
} from '@proxy/openai/responses-api/output'
import { mapFailedCall, type OpenAIError } from '@proxy/server/errors'

/** Logger for the Responses API stream. */
const streamLogger = proxyLogger('openai', 'responses-api')

/** A started stream: its frames, and the frames that end it on a failure thrown mid-stream. */
export interface ResponsesStream {
  readonly frames: AsyncGenerator<string>
  /**
   * Ends the stream with `response.failed`, for a failure the caller caught.
   *
   * @param body - the mapped OpenAI error
   * @returns the frames to send
   */
  fail(body: OpenAIError): string[]
}

/** The stream's state: its next sequence number, and the items so far. */
interface StreamState {
  sequence: number
  readonly items: OutputItem[]
  /** The model answering, for the `response.*` events. */
  readonly model: string
  /** Whether the stream ended (completed, incomplete or failed). */
  ended: boolean
  /** The items started and not yet done, by output index. */
  readonly open: Set<number>
}

/**
 * Encodes one event as a server-sent event, numbering it.
 *
 * @param state - the stream state; its sequence number moves on
 * @param type - the event type
 * @param fields - the event's other fields
 * @returns the frame
 */
function frame(state: StreamState, type: string, fields: Record<string, unknown>): string {
  const event = { type, sequence_number: state.sequence, ...fields }
  state.sequence += 1
  return `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`
}

/**
 * Encodes a `response.*` event carrying the response as it stands.
 *
 * @param state - the stream state
 * @param frameOf - the response's ID, time and echoed settings
 * @param event - the event type, status, and the usage, error and `x_pi` when known
 * @returns the frame
 */
function responseEvent(
  state: StreamState,
  frameOf: ResponseFrame,
  event: {
    readonly type: string
    readonly status: ResponseStatus
    readonly output?: readonly OutputItem[]
    readonly message?: AssistantMessage
    readonly route?: ResponseRoute
    readonly error?: { readonly code: string; readonly message: string }
    readonly xPi?: Readonly<Record<string, unknown>>
  }
): string {
  const { message, route } = event
  const response = responseObject(frameOf, {
    status: event.status,
    model: state.model,
    output: event.output ?? state.items,
    usage: message === undefined ? null : responsesUsage(message.usage),
    xPi:
      message === undefined || route === undefined
        ? (event.xPi ?? {})
        : responsesXPi(message.usage, route),
    ...(event.error === undefined ? {} : { error: event.error })
  })
  return frame(state, event.type, { response })
}

/**
 * Encodes the events of a block that starts: its item added, and its first part.
 *
 * @param state - the stream state
 * @param frameOf - the response
 * @param event - pi's `*_start` event
 * @returns the frames
 */
function startFrames(
  state: StreamState,
  frameOf: ResponseFrame,
  event: Extract<
    AssistantMessageEvent,
    { type: 'text_start' | 'thinking_start' | 'toolcall_start' }
  >
): string[] {
  const index = event.contentIndex
  const block = event.partial.content[index]
  const closed = closeOpenItems(state, frameOf, event.partial)
  state.open.add(index)
  return [...closed, ...openFrames(state, frameOf, event, block)]
}

/**
 * Ends the reasoning and text items still open when another starts, as OpenAI finishes one item
 * before it starts the next. pi can end a block after the next has started (a completions
 * adapter ends thinking once text arrives); its own `*_end` then sends nothing.
 *
 * @param state - the stream state
 * @param frameOf - the response
 * @param partial - pi's message so far, holding each open block's content
 * @returns the frames that end them
 */
function closeOpenItems(
  state: StreamState,
  frameOf: ResponseFrame,
  partial: AssistantMessage
): string[] {
  return [...state.open].flatMap((openIndex) => {
    const block = partial.content[openIndex]
    if (block?.type === 'thinking') {
      return endFrames(state, frameOf, {
        type: 'thinking_end',
        contentIndex: openIndex,
        content: block.thinking,
        partial
      })
    }
    if (block?.type === 'text') {
      return endFrames(state, frameOf, {
        type: 'text_end',
        contentIndex: openIndex,
        content: block.text,
        partial
      })
    }
    // A tool call is left to its own end, which carries its parsed arguments.
    return []
  })
}

/**
 * Encodes the events of a block that starts: its item added, and its first part.
 *
 * @param state - the stream state
 * @param frameOf - the response
 * @param event - pi's `*_start` event
 * @param block - the block, as pi's message holds it so far
 * @returns the frames
 */
function openFrames(
  state: StreamState,
  frameOf: ResponseFrame,
  event: Extract<
    AssistantMessageEvent,
    { type: 'text_start' | 'thinking_start' | 'toolcall_start' }
  >,
  block: AssistantMessage['content'][number] | undefined
): string[] {
  const index = event.contentIndex
  if (event.type === 'thinking_start') {
    const item: OutputItem = { type: 'reasoning', id: itemId(frameOf, 'rs', index), summary: [] }
    state.items[index] = item
    return [
      frame(state, 'response.output_item.added', { output_index: index, item }),
      frame(state, 'response.reasoning_summary_part.added', {
        item_id: item.id,
        output_index: index,
        summary_index: 0,
        part: { type: 'summary_text', text: '' }
      })
    ]
  }
  if (event.type === 'text_start') {
    const item: OutputItem = {
      type: 'message',
      id: itemId(frameOf, 'msg', index),
      role: 'assistant',
      status: 'in_progress',
      content: []
    }
    state.items[index] = item
    return [
      frame(state, 'response.output_item.added', { output_index: index, item }),
      frame(state, 'response.content_part.added', {
        item_id: item.id,
        output_index: index,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [], logprobs: [] }
      })
    ]
  }
  const call = block?.type === 'toolCall' ? block : undefined
  const item: OutputItem = {
    type: 'function_call',
    id: itemId(frameOf, 'fc', index),
    call_id: call?.id ?? '',
    name: call?.name ?? '',
    arguments: '',
    status: 'in_progress'
  }
  state.items[index] = item
  return [frame(state, 'response.output_item.added', { output_index: index, item })]
}

/**
 * Encodes a delta of a block.
 *
 * @param state - the stream state
 * @param frameOf - the response
 * @param event - pi's `*_delta` event
 * @returns the frame
 */
function deltaFrame(
  state: StreamState,
  frameOf: ResponseFrame,
  event: Extract<
    AssistantMessageEvent,
    { type: 'text_delta' | 'thinking_delta' | 'toolcall_delta' }
  >
): string {
  const index = event.contentIndex
  const common = { output_index: index, delta: event.delta }
  if (event.type === 'thinking_delta') {
    return frame(state, 'response.reasoning_summary_text.delta', {
      ...common,
      item_id: itemId(frameOf, 'rs', index),
      summary_index: 0
    })
  }
  if (event.type === 'text_delta') {
    return frame(state, 'response.output_text.delta', {
      ...common,
      item_id: itemId(frameOf, 'msg', index),
      content_index: 0,
      logprobs: []
    })
  }
  return frame(state, 'response.function_call_arguments.delta', {
    ...common,
    item_id: itemId(frameOf, 'fc', index)
  })
}

/**
 * Encodes the events of a block that ends: its last part done, and its item done.
 *
 * @param state - the stream state
 * @param frameOf - the response
 * @param event - pi's `*_end` event
 * @returns the frames
 */
function endFrames(
  state: StreamState,
  frameOf: ResponseFrame,
  event: Extract<AssistantMessageEvent, { type: 'text_end' | 'thinking_end' | 'toolcall_end' }>
): string[] {
  const index = event.contentIndex
  const message = event.partial
  // Already ended when a later item started: see `closeOpenItems`.
  if (!state.open.delete(index)) return []
  if (event.type === 'thinking_end') {
    const block = message.content[index]
    const thinking =
      block?.type === 'thinking' ? block : { type: 'thinking' as const, thinking: event.content }
    const item = reasoningItem(frameOf, index, { thinking, message })
    state.items[index] = { ...item, status: 'completed' }
    const part = { type: 'summary_text', text: event.content }
    const common = { item_id: item.id, output_index: index, summary_index: 0 }
    return [
      frame(state, 'response.reasoning_summary_text.done', { ...common, text: event.content }),
      frame(state, 'response.reasoning_summary_part.done', { ...common, part }),
      frame(state, 'response.output_item.done', { output_index: index, item: state.items[index] })
    ]
  }
  if (event.type === 'text_end') {
    const item = messageItem(frameOf, index, { type: 'text', text: event.content }, 'completed')
    state.items[index] = item
    const part = item.content[0]
    const common = { item_id: item.id, output_index: index, content_index: 0 }
    return [
      frame(state, 'response.output_text.done', { ...common, text: event.content, logprobs: [] }),
      frame(state, 'response.content_part.done', { ...common, part }),
      frame(state, 'response.output_item.done', { output_index: index, item })
    ]
  }
  const item = functionCallItem(frameOf, index, event.toolCall)
  state.items[index] = item
  return [
    frame(state, 'response.function_call_arguments.done', {
      item_id: item.id,
      output_index: index,
      arguments: item.arguments
    }),
    frame(state, 'response.output_item.done', { output_index: index, item })
  ]
}

/**
 * Encodes the `response.failed` event that ends a stream.
 *
 * @param state - the stream state
 * @param frameOf - the response
 * @param body - the mapped OpenAI error
 * @returns the frame
 */
function failedFrame(state: StreamState, frameOf: ResponseFrame, body: OpenAIError): string {
  state.ended = true
  const { code, message } = body.error
  return responseEvent(state, frameOf, {
    type: 'response.failed',
    status: 'failed',
    // OpenAI's response error codes are a closed list: a rate limit is one, any other failure is
    // `server_error`. The proxy's own code, as chat completions give it, goes under `x_pi`.
    error: { code: code === 'rate_limit_exceeded' ? code : 'server_error', message },
    xPi: { error_code: code }
  })
}

/**
 * Maps one pi event to the events it produces.
 *
 * @param state - the stream state
 * @param frameOf - the response
 * @param event - pi's event, and the route it came by
 * @param route - how the request got to the model answering
 * @returns the frames
 */
function eventFrames(
  state: StreamState,
  frameOf: ResponseFrame,
  event: AssistantMessageEvent,
  route: ResponseRoute
): string[] {
  switch (event.type) {
    case 'start':
      return [
        responseEvent(state, frameOf, { type: 'response.created', status: 'in_progress' }),
        responseEvent(state, frameOf, { type: 'response.in_progress', status: 'in_progress' })
      ]
    case 'text_start':
    case 'thinking_start':
    case 'toolcall_start':
      return startFrames(state, frameOf, event)
    case 'text_delta':
    case 'thinking_delta':
    case 'toolcall_delta':
      return [deltaFrame(state, frameOf, event)]
    case 'text_end':
    case 'thinking_end':
    case 'toolcall_end':
      return endFrames(state, frameOf, event)
    case 'done': {
      state.ended = true
      const incomplete = event.reason === 'length'
      return [
        responseEvent(state, frameOf, {
          type: incomplete ? 'response.incomplete' : 'response.completed',
          status: incomplete ? 'incomplete' : 'completed',
          output: outputItems(frameOf, event.message),
          message: event.message,
          route
        })
      ]
    }
    case 'error': {
      const { body } = mapFailedCall(event.error)
      streamLogger.debug('Upstream error in a Responses stream: {code}', {
        code: body.error.code,
        stopReason: event.reason
      })
      return [failedFrame(state, frameOf, body)]
    }
  }
  // An event pi adds later maps to nothing until it is handled here.
  return []
}

/**
 * Turns pi's event stream into the Responses API's server-sent events.
 *
 * @param events - pi's events, from the first
 * @param frameOf - the response's ID, time and echoed settings
 * @param route - how the request got to the model answering
 * @returns the frames, and how to end them on a failure thrown mid-stream
 */
export function streamResponses(
  events: AsyncIterable<AssistantMessageEvent>,
  frameOf: ResponseFrame,
  route: ResponseRoute
): ResponsesStream {
  const state: StreamState = {
    sequence: 0,
    items: [],
    model: route.model,
    ended: false,
    open: new Set()
  }
  /**
   * Yields each event's frames until the stream ends.
   *
   * @returns the frames
   */
  async function* frames(): AsyncGenerator<string> {
    for await (const event of events) {
      yield* eventFrames(state, frameOf, event, route)
      if (state.ended) return
    }
  }
  return {
    frames: frames(),
    fail: (body) => (state.ended ? [] : [failedFrame(state, frameOf, body)])
  }
}
