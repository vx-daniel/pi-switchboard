/**
 * The Responses API's `Response` object (#140): what a non-streamed request answers, and what the
 * stream's `response.*` events carry.
 *
 * @remarks
 * pi's answer becomes `output` items in its content order: a thinking block a `reasoning` item, a
 * text block a `message` with one `output_text` part, a tool call a `function_call` (its `call_id`
 * pi's call ID, which the client sends back in `function_call_output`). A `reasoning` item carries
 * the thinking as its `summary`, and, when `include` asks for `reasoning.encrypted_content`, the
 * token that replays it (`reasoning-token.ts`). The request's settings are echoed as OpenAI does,
 * and `store` is always `false`. Usage and pi's cost are as on chat completions, `x_pi` included.
 *
 * @packageDocumentation
 */

import type {
  AssistantMessage,
  TextContent,
  ThinkingContent,
  ToolCall,
  Usage
} from '@earendil-works/pi-ai'
import { type ResponseRoute, type RouteFields, routeFields } from '@proxy/openai/responses'
import { encodeReasoningToken } from '@proxy/openai/responses-api/reasoning-token'
import type { CreateResponseRequest } from '@proxy/openai/responses-api/request-schema'

/** Milliseconds per second, for Unix timestamps. */
const MS_PER_SECOND = 1000

/** A `message` output item. */
export interface OutputMessageItem {
  readonly type: 'message'
  readonly id: string
  readonly role: 'assistant'
  readonly status: 'in_progress' | 'completed' | 'incomplete'
  readonly content: readonly {
    readonly type: 'output_text'
    readonly text: string
    readonly annotations: readonly []
    readonly logprobs: readonly []
  }[]
}

/** A `function_call` output item. */
export interface FunctionCallItem {
  readonly type: 'function_call'
  readonly id: string
  readonly call_id: string
  readonly name: string
  readonly arguments: string
  readonly status: 'in_progress' | 'completed' | 'incomplete'
}

/** A `reasoning` output item. */
export interface ReasoningOutputItem {
  readonly type: 'reasoning'
  readonly id: string
  readonly summary: readonly { readonly type: 'summary_text'; readonly text: string }[]
  readonly encrypted_content?: string
  readonly status?: 'in_progress' | 'completed' | 'incomplete'
}

/** One `output` item. */
export type OutputItem = OutputMessageItem | FunctionCallItem | ReasoningOutputItem

/** The `usage` of a response. */
export interface ResponsesUsage {
  readonly input_tokens: number
  readonly input_tokens_details: {
    readonly cached_tokens: number
    readonly cache_write_tokens: number
  }
  readonly output_tokens: number
  readonly output_tokens_details: { readonly reasoning_tokens: number }
  readonly total_tokens: number
}

/** A response's status. */
export type ResponseStatus = 'in_progress' | 'completed' | 'incomplete' | 'failed'

/** A `Response` object. */
export interface ResponseObject {
  readonly id: string
  readonly object: 'response'
  readonly created_at: number
  readonly status: ResponseStatus
  readonly error: { readonly code: string; readonly message: string } | null
  readonly incomplete_details: { readonly reason: 'max_output_tokens' } | null
  readonly model: string
  readonly output: readonly OutputItem[]
  readonly usage: ResponsesUsage | null
  readonly x_pi?: Readonly<Record<string, unknown>>
  readonly [echoed: string]: unknown
}

/** What a response says about the request it answers, and how its items are named. */
export interface ResponseFrame {
  /** The response's ID, `resp_…`; its items' IDs derive from it. */
  readonly id: string
  readonly createdAt: number
  /** The request's settings, echoed as OpenAI does. */
  readonly echo: Readonly<Record<string, unknown>>
  /** Whether `include` asked for `reasoning.encrypted_content`. */
  readonly includeReasoning: boolean
}

/**
 * Echoes the request's function tools as OpenAI does, unset fields as `null`.
 *
 * @param request - the validated Responses request
 * @returns the tools
 */
function toolsEcho(request: CreateResponseRequest): Record<string, unknown>[] {
  return (request.tools ?? []).map((tool) => ({
    ...tool,
    description: tool.description ?? null,
    parameters: tool.parameters ?? null,
    strict: tool.strict ?? null
  }))
}

/**
 * Echoes the request's `reasoning`, unset fields as `null`.
 *
 * @param request - the validated Responses request
 * @returns the setting, or `null` when the request set none
 */
function reasoningEcho(request: CreateResponseRequest): Record<string, unknown> | null {
  const { reasoning } = request
  if (reasoning === undefined || reasoning === null) return null
  return { effort: reasoning.effort ?? null, summary: reasoning.summary ?? null }
}

/**
 * Builds what every response to a request repeats: its ID, its time, and the request's settings.
 *
 * @param requestId - the proxy's request ID
 * @param request - the validated Responses request
 * @returns the frame
 */
export function responseFrame(requestId: string, request: CreateResponseRequest): ResponseFrame {
  return {
    id: `resp_${requestId}`,
    createdAt: Math.floor(Date.now() / MS_PER_SECOND),
    includeReasoning: request.include?.includes('reasoning.encrypted_content') === true,
    echo: {
      instructions: request.instructions ?? null,
      metadata: request.metadata ?? {},
      parallel_tool_calls: request.parallel_tool_calls ?? true,
      temperature: request.temperature ?? null,
      top_p: request.top_p ?? null,
      tool_choice: request.tool_choice ?? 'auto',
      tools: toolsEcho(request),
      max_output_tokens: request.max_output_tokens ?? null,
      reasoning: reasoningEcho(request),
      text: { format: request.text?.format ?? { type: 'text' } },
      user: request.user ?? null,
      prompt_cache_key: request.prompt_cache_key ?? null,
      store: false,
      access_programs: null
    }
  }
}

/**
 * Converts pi's usage into the Responses form.
 *
 * @param usage - pi's usage
 * @returns the usage
 */
export function responsesUsage(usage: Usage): ResponsesUsage {
  const input = usage.input + usage.cacheRead + usage.cacheWrite
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: usage.cacheRead, cache_write_tokens: usage.cacheWrite },
    output_tokens: usage.output,
    output_tokens_details: { reasoning_tokens: usage.reasoning ?? 0 },
    total_tokens: usage.totalTokens
  }
}

/**
 * Builds the `x_pi` of a response: pi's cost and cache counts, and the route.
 *
 * @param usage - pi's usage
 * @param route - how the request got to the model that answered
 * @returns the fields
 */
export function responsesXPi(
  usage: Usage,
  route: ResponseRoute
): Readonly<Record<string, unknown>> & RouteFields {
  return {
    cost: usage.cost,
    cache_read_tokens: usage.cacheRead,
    cache_write_tokens: usage.cacheWrite,
    ...routeFields(route)
  }
}

/**
 * Names an output item: the response's ID with the item's kind and place.
 *
 * @param frame - the response
 * @param prefix - the item kind's prefix, as OpenAI's (`msg`, `fc`, `rs`)
 * @param index - the item's index in `output`
 * @returns the item ID
 */
export function itemId(frame: ResponseFrame, prefix: string, index: number): string {
  return `${prefix}_${frame.id.slice('resp_'.length)}_${String(index)}`
}

/**
 * Builds a `reasoning` item from a thinking block.
 *
 * @param frame - the response
 * @param index - the item's index in `output`
 * @param block - the thinking block, and the model that produced it
 * @returns the item, with the replay token when the request asked for it
 */
export function reasoningItem(
  frame: ResponseFrame,
  index: number,
  block: { readonly thinking: ThinkingContent; readonly message: AssistantMessage }
): ReasoningOutputItem {
  const { thinking, message } = block
  const summary =
    thinking.redacted === true || thinking.thinking.length === 0
      ? []
      : [{ type: 'summary_text' as const, text: thinking.thinking }]
  return {
    type: 'reasoning',
    id: itemId(frame, 'rs', index),
    summary,
    ...(frame.includeReasoning
      ? {
          encrypted_content: encodeReasoningToken({
            provider: message.provider,
            api: message.api,
            model: message.model,
            thinking
          })
        }
      : {})
  }
}

/**
 * Builds a `message` item from a text block.
 *
 * @param frame - the response
 * @param index - the item's index in `output`
 * @param text - the text block
 * @param status - the item's status
 * @returns the item
 */
export function messageItem(
  frame: ResponseFrame,
  index: number,
  text: TextContent,
  status: OutputMessageItem['status']
): OutputMessageItem {
  return {
    type: 'message',
    id: itemId(frame, 'msg', index),
    role: 'assistant',
    status,
    content: [{ type: 'output_text', text: text.text, annotations: [], logprobs: [] }]
  }
}

/**
 * Builds a `function_call` item from a tool call.
 *
 * @param frame - the response
 * @param index - the item's index in `output`
 * @param call - the tool call
 * @returns the item
 */
export function functionCallItem(
  frame: ResponseFrame,
  index: number,
  call: ToolCall
): FunctionCallItem {
  return {
    type: 'function_call',
    id: itemId(frame, 'fc', index),
    call_id: call.id,
    name: call.name,
    arguments: JSON.stringify(call.arguments),
    status: 'completed'
  }
}

/**
 * Builds the `output` items of a finished answer, in content order.
 *
 * @param frame - the response
 * @param message - pi's answer
 * @returns the items
 */
export function outputItems(frame: ResponseFrame, message: AssistantMessage): OutputItem[] {
  const status = message.stopReason === 'length' ? 'incomplete' : 'completed'
  return message.content.map((block, index): OutputItem => {
    if (block.type === 'thinking') return reasoningItem(frame, index, { thinking: block, message })
    if (block.type === 'text') return messageItem(frame, index, block, status)
    return functionCallItem(frame, index, block)
  })
}

/**
 * Assembles a `Response` object.
 *
 * @param frame - the response's ID, time and echoed settings
 * @param state - its status, model, items, usage, error and `x_pi`
 * @param state.status - the status
 * @param state.model - the canonical ID of the model answering
 * @param state.output - the items so far
 * @param state.usage - the usage, or `null` before the end
 * @param state.error - the error, for a failed response
 * @param state.xPi - the `x_pi` fields
 * @returns the object
 */
export function responseObject(
  frame: ResponseFrame,
  state: {
    readonly status: ResponseStatus
    readonly model: string
    readonly output: readonly OutputItem[]
    readonly usage: ResponsesUsage | null
    readonly error?: { readonly code: string; readonly message: string }
    readonly xPi: Readonly<Record<string, unknown>>
  }
): ResponseObject {
  return {
    ...frame.echo,
    id: frame.id,
    object: 'response',
    created_at: frame.createdAt,
    status: state.status,
    error: state.error ?? null,
    incomplete_details: state.status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
    model: state.model,
    output: state.output,
    usage: state.usage,
    x_pi: state.xPi
  }
}

/**
 * Builds the answer to a non-streamed request.
 *
 * @param frame - the response's ID, time and echoed settings
 * @param message - pi's answer
 * @param route - how the request got to the model that answered
 * @returns the `Response` object
 */
export function buildResponse(
  frame: ResponseFrame,
  message: AssistantMessage,
  route: ResponseRoute
): ResponseObject {
  return responseObject(frame, {
    status: message.stopReason === 'length' ? 'incomplete' : 'completed',
    model: route.model,
    output: outputItems(frame, message),
    usage: responsesUsage(message.usage),
    xPi: responsesXPi(message.usage, route)
  })
}
