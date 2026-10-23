/**
 * Turns a Responses API request (#140) into the chat-completions request the proxy already runs,
 * plus the reasoning its `reasoning` items carry back.
 *
 * @remarks
 * The two APIs carry the same conversation in different shapes. `instructions` becomes the system
 * message, and `input` items become messages. An assistant turn is the run of `reasoning`,
 * assistant `message` and `function_call` items between two other items: it becomes one assistant
 * message with its text and tool calls, as chat holds it. The other fields map one to one
 * (`max_output_tokens` to `max_completion_tokens`, `reasoning.effort` to `reasoning_effort`,
 * `text.format` to `response_format`). Model resolution, routing, validation of tools and images,
 * and the upstream call are then the chat route's.
 *
 * A `reasoning` item's `encrypted_content` is the proxy's token (`reasoning-token.ts`): it is put
 * back as a thinking block on the turn's assistant message, which pi replays to the model that
 * produced it. A `reasoning` item without one holds only the summary the client was shown, which
 * no model can take back: it is not sent, and counted at debug.
 *
 * @packageDocumentation
 */

import type { Context } from '@earendil-works/pi-ai'
import { proxyLogger } from '@proxy/logging'
import {
  decodeReasoningToken,
  type ReasoningToken
} from '@proxy/openai/responses-api/reasoning-token'
import {
  type CreateResponseRequest,
  RESPONSES_REJECTED_FIELDS,
  type ResponsesInputItem,
  createResponseRequestSchema
} from '@proxy/openai/responses-api/request-schema'
import type { ChatCompletionRequest, OpenAIMessage } from '@proxy/openai/schemas'
import { schemaRejection, type ValidationError } from '@proxy/openai/validate'
import { isRecord } from '@proxy/utils/guards'

/** Logger for the Responses API request translation. */
const requestLogger = proxyLogger('openai', 'responses-api')

/** A Responses request as the chat route runs it. */
export interface TranslatedRequest {
  readonly chat: ChatCompletionRequest
  /** For each assistant message of `chat`, in order, the reasoning to replay before it. */
  readonly reasoning: readonly (readonly ReasoningToken[])[]
}

/** How a translation ended: the chat request, or the 400 for a token the proxy did not write. */
export type Translation =
  | { readonly ok: true; readonly value: TranslatedRequest }
  | { readonly ok: false; readonly message: string; readonly param: string }

/**
 * Says why a body that failed {@link createResponseRequestSchema} is rejected: a named 422 for a
 * field the proxy refuses (stored state, `store: true`, a tool that is not a function, an
 * `include` other than reasoning), else the first schema issue.
 *
 * @param body - the parsed JSON request body
 * @returns the rejection
 */
export function responsesRequestRejection(body: unknown): ValidationError {
  return namedRejection(body) ?? schemaRejection(createResponseRequestSchema, body)
}

/**
 * Finds the first field the proxy refuses by name.
 *
 * @param body - the parsed JSON request body
 * @returns its named 422, or `undefined` when there is none
 */
function namedRejection(body: unknown): ValidationError | undefined {
  if (!isRecord(body)) return undefined
  const named = (param: string, message: string): ValidationError => {
    requestLogger.warn('Rejected Responses request: unsupported {param}', { param })
    return { ok: false, status: 422, message, param }
  }
  const field = Object.keys(RESPONSES_REJECTED_FIELDS).find((key) => body[key] !== undefined)
  if (field !== undefined) {
    return named(field, `'${field}' is not supported: ${RESPONSES_REJECTED_FIELDS[field] ?? ''}`)
  }
  if (body['store'] === true) {
    return named('store', "'store: true' is not supported: the proxy stores nothing; send false")
  }
  const { tools, include } = body
  const tool = Array.isArray(tools)
    ? tools.findIndex((entry) => isRecord(entry) && entry['type'] !== 'function')
    : -1
  if (Array.isArray(tools) && tool >= 0) {
    const entry: unknown = tools[tool]
    const type = isRecord(entry) ? String(entry['type']) : ''
    return named(
      `tools.${String(tool)}.type`,
      `Tool type '${type}' is not supported: only function tools`
    )
  }
  const unsupported = Array.isArray(include)
    ? include.findIndex((value) => value !== 'reasoning.encrypted_content')
    : -1
  if (unsupported >= 0) {
    return named(
      `include.${String(unsupported)}`,
      "Only 'reasoning.encrypted_content' can be included"
    )
  }
  return undefined
}

/** The assistant turn being gathered from consecutive items. */
interface Turn {
  text: string[]
  toolCalls: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  reasoning: ReasoningToken[]
  /** Whether it holds anything to send. */
  open: boolean
}

/**
 * Starts an empty assistant turn.
 *
 * @returns the turn
 */
function emptyTurn(): Turn {
  return { text: [], toolCalls: [], reasoning: [], open: false }
}

/** The messages being built, with each assistant message's reasoning. */
interface Built {
  readonly messages: OpenAIMessage[]
  readonly reasoning: ReasoningToken[][]
  /** Reasoning items without a token: not sent. */
  unreplayable: number
}

/**
 * Ends an assistant turn: adds it as one assistant message, with its reasoning beside it.
 *
 * @param built - the messages so far; appended to
 * @param turn - the turn
 */
function flush(built: Built, turn: Turn): void {
  if (!turn.open) return
  if (turn.text.length === 0 && turn.toolCalls.length === 0) {
    // Reasoning alone, with nothing the model answered after it, has no message to go on.
    built.unreplayable += turn.reasoning.length
  } else {
    const text = turn.text.join('')
    built.messages.push({
      role: 'assistant',
      content: text.length > 0 ? text : null,
      ...(turn.toolCalls.length > 0 ? { tool_calls: turn.toolCalls } : {})
    })
    built.reasoning.push(turn.reasoning)
  }
  Object.assign(turn, emptyTurn())
}

/**
 * Converts one item that is not part of an assistant turn into a chat message.
 *
 * @param item - a user, system or developer message, or a function call's output
 * @returns the chat message
 */
function standaloneMessage(
  item: Extract<
    ResponsesInputItem,
    { role: 'user' | 'system' | 'developer' } | { type: 'function_call_output' }
  >
): OpenAIMessage {
  if ('type' in item && item.type === 'function_call_output') {
    const output =
      typeof item.output === 'string' ? item.output : item.output.map((part) => part.text).join('')
    return { role: 'tool', tool_call_id: item.call_id, content: output }
  }
  if (!('role' in item)) throw new Error('A standalone item is a message or an output')
  if (item.role !== 'user') {
    const content =
      typeof item.content === 'string'
        ? item.content
        : item.content.map(({ type: _type, ...part }) => ({ type: 'text' as const, ...part }))
    return { role: item.role, content }
  }
  if (typeof item.content === 'string') return { role: 'user', content: item.content }
  return {
    role: 'user',
    content: item.content.map((part) => {
      if (part.type === 'input_text') {
        const { type: _type, ...text } = part
        return { type: 'text' as const, ...text }
      }
      const { image_url: url, detail, prompt_cache_breakpoint: breakpoint } = part
      return {
        type: 'image_url' as const,
        image_url: { url, ...(detail === undefined || detail === 'original' ? {} : { detail }) },
        ...(breakpoint === undefined ? {} : { prompt_cache_breakpoint: breakpoint })
      }
    })
  }
}

/**
 * Adds one input item to the conversation: to the open assistant turn, or as its own message.
 *
 * @param built - the messages so far
 * @param turn - the open assistant turn
 * @param entry - the item and its index in `input`
 * @returns the 400 for a reasoning token the proxy did not write, else `undefined`
 */
function addItem(
  built: Built,
  turn: Turn,
  entry: readonly [number, ResponsesInputItem]
): { message: string; param: string } | undefined {
  const [position, item] = entry
  if ('type' in item && item.type === 'reasoning') {
    if (item.encrypted_content === undefined || item.encrypted_content === null) {
      built.unreplayable += 1
      return undefined
    }
    const token = decodeReasoningToken(item.encrypted_content)
    if (token === undefined) {
      return {
        message: 'encrypted_content is not a reasoning token from this proxy',
        param: `input.${String(position)}.encrypted_content`
      }
    }
    turn.reasoning.push(token)
    turn.open = true
    return undefined
  }
  if ('type' in item && item.type === 'function_call') {
    turn.toolCalls.push({
      id: item.call_id,
      type: 'function',
      function: { name: item.name, arguments: item.arguments }
    })
    turn.open = true
    return undefined
  }
  if ('role' in item && item.role === 'assistant') {
    turn.text.push(
      typeof item.content === 'string'
        ? item.content
        : item.content.map((part) => part.text).join('')
    )
    turn.open = true
    return undefined
  }
  flush(built, turn)
  built.messages.push(standaloneMessage(item))
  return undefined
}

/**
 * Builds the chat messages: `instructions` as the system message, then `input`.
 *
 * @param request - the Responses request
 * @returns the messages and each assistant message's reasoning, or the 400 for a bad token
 */
function messagesOf(
  request: CreateResponseRequest
): { ok: true; built: Built } | { ok: false; message: string; param: string } {
  const built: Built = { messages: [], reasoning: [], unreplayable: 0 }
  const { instructions, input } = request
  if (instructions !== undefined && instructions !== null) {
    built.messages.push({ role: 'system', content: instructions })
  }
  if (typeof input === 'string') {
    built.messages.push({ role: 'user', content: input })
    return { ok: true, built }
  }
  const turn = emptyTurn()
  for (const indexedItem of input.entries()) {
    const problem = addItem(built, turn, indexedItem)
    if (problem !== undefined) return { ok: false, ...problem }
  }
  flush(built, turn)
  return { ok: true, built }
}

/**
 * Converts `text.format` into chat's `response_format`.
 *
 * @param format - the Responses format
 * @returns the chat format
 */
function responseFormatOf(
  format: NonNullable<NonNullable<CreateResponseRequest['text']>['format']>
): NonNullable<ChatCompletionRequest['response_format']> {
  if (format.type !== 'json_schema') return { type: format.type }
  const { name, description, schema, strict } = format
  return {
    type: 'json_schema',
    json_schema: {
      name,
      schema,
      ...(description === undefined ? {} : { description }),
      ...(strict === undefined ? {} : { strict })
    }
  }
}

/**
 * Converts the function tools into chat's form.
 *
 * @param tools - the Responses tools
 * @returns the chat tools
 */
function toolsOf(
  tools: NonNullable<CreateResponseRequest['tools']>
): NonNullable<ChatCompletionRequest['tools']> {
  return tools.map(({ name, description, parameters, strict }) => ({
    type: 'function',
    function: {
      name,
      ...(description === undefined || description === null ? {} : { description }),
      ...(parameters === undefined || parameters === null ? {} : { parameters }),
      ...(strict === undefined ? {} : { strict })
    }
  }))
}

/**
 * Copies a field into the chat request when it is set (neither absent nor `null`).
 *
 * @typeParam Value - the field's value
 * @param key - the chat field
 * @param value - the value
 * @returns the field, or nothing
 */
function setField<Value>(
  key: string,
  value: Value | null | undefined
): Record<string, NonNullable<Value>> {
  return value === undefined || value === null ? {} : { [key]: value }
}

/**
 * Translates a Responses request into the chat request the proxy runs, with the reasoning to
 * replay.
 *
 * @param request - the validated Responses request
 * @returns the chat request and reasoning, or the 400 for a reasoning token the proxy did not
 *   write
 */
export function toChatRequest(request: CreateResponseRequest): Translation {
  const messages = messagesOf(request)
  if (!messages.ok) return messages
  const { built } = messages
  if (built.unreplayable > 0) {
    requestLogger.debug('Not sending {itemCount} reasoning items without encrypted_content', {
      itemCount: built.unreplayable
    })
  }
  const { tool_choice: toolChoice, tools, text } = request
  const chat: ChatCompletionRequest = {
    model: request.model,
    messages: built.messages,
    ...setField('stream', request.stream),
    ...setField('temperature', request.temperature),
    ...setField('top_p', request.top_p),
    ...setField('max_completion_tokens', request.max_output_tokens),
    ...setField('reasoning_effort', request.reasoning?.effort),
    ...setField('parallel_tool_calls', request.parallel_tool_calls),
    ...setField('metadata', request.metadata),
    ...setField('user', request.user),
    ...setField('prompt_cache_key', request.prompt_cache_key),
    ...(tools === undefined ? {} : { tools: toolsOf(tools) }),
    ...(toolChoice === undefined
      ? {}
      : {
          tool_choice:
            typeof toolChoice === 'string'
              ? toolChoice
              : { type: 'function', function: { name: toolChoice.name } }
        }),
    ...(text?.format === undefined ? {} : { response_format: responseFormatOf(text.format) })
  }
  return { ok: true, value: { chat, reasoning: built.reasoning } }
}

/**
 * Puts each assistant turn's reasoning back as thinking blocks, on the model that produced it, so
 * pi replays it to that model (and drops it for any other).
 *
 * @param context - the pi context built from the chat messages
 * @param reasoning - each assistant message's reasoning, in order
 * @returns the context with the thinking blocks
 */
export function withReplayedReasoning(
  context: Context,
  reasoning: readonly (readonly ReasoningToken[])[]
): Context {
  let assistantIndex = 0
  const messages = context.messages.map((message) => {
    if (message.role !== 'assistant') return message
    const tokens = reasoning[assistantIndex] ?? []
    assistantIndex += 1
    const [first] = tokens
    if (first === undefined) return message
    // One assistant message has one model; reasoning from another could never be replayed.
    const own = tokens.filter(
      (token) =>
        token.provider === first.provider && token.api === first.api && token.model === first.model
    )
    return {
      ...message,
      provider: first.provider,
      api: first.api,
      model: first.model,
      content: [...own.map((token) => token.thinking), ...message.content]
    }
  })
  return { ...context, messages }
}
