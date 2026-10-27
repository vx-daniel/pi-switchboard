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
 * produced it. A `reasoning` item without one is a 400, as OpenAI refuses an echoed reasoning item
 * it has not stored: the proxy stores nothing, and the summary alone is nothing a model can take
 * back. So is reasoning that no message or function call follows, which has nothing to go on.
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
import {
  type ChatCompletionRequest,
  type OpenAIMessage,
  STORE_TRUE_REFUSAL
} from '@proxy/openai/schemas'
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
    return named('store', STORE_TRUE_REFUSAL)
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
  /** The index in `input` of the turn's last reasoning item, while nothing has followed it. */
  danglingReasoning: number | undefined
  /** Whether it holds anything to send. */
  open: boolean
}

/**
 * Starts an empty assistant turn.
 *
 * @returns the turn
 */
function emptyTurn(): Turn {
  return { text: [], toolCalls: [], reasoning: [], danglingReasoning: undefined, open: false }
}

/** The messages being built, with each assistant message's reasoning. */
interface Built {
  readonly messages: OpenAIMessage[]
  readonly reasoning: ReasoningToken[][]
}

/** A request the translation refuses: why, and the field. */
interface TranslationProblem {
  readonly message: string
  readonly param: string
}

/**
 * Ends an assistant turn: adds it as one assistant message, with its reasoning beside it.
 *
 * @param built - the messages so far; appended to
 * @param turn - the turn
 * @returns the 400 for reasoning nothing followed, else `undefined`
 */
function flush(built: Built, turn: Turn): TranslationProblem | undefined {
  if (!turn.open) return undefined
  if (turn.danglingReasoning !== undefined) {
    return {
      message:
        'A reasoning item must be followed by the message or function call it led to, as in the response it came from',
      param: `input.${String(turn.danglingReasoning)}`
    }
  }
  const text = turn.text.join('')
  built.messages.push({
    role: 'assistant',
    content: text.length > 0 ? text : null,
    ...(turn.toolCalls.length > 0 ? { tool_calls: turn.toolCalls } : {})
  })
  built.reasoning.push(turn.reasoning)
  Object.assign(turn, emptyTurn())
  return undefined
}

/**
 * Converts a function call's output into a chat `tool` message.
 *
 * @param item - the `function_call_output` item
 * @returns the chat message
 */
function toolMessage(
  item: Extract<ResponsesInputItem, { type: 'function_call_output' }>
): OpenAIMessage {
  const output =
    typeof item.output === 'string' ? item.output : item.output.map((part) => part.text).join('')
  return { role: 'tool', tool_call_id: item.call_id, content: output }
}

/**
 * Converts a user, system or developer message into a chat message.
 *
 * @param item - the message item
 * @returns the chat message
 */
function inputMessage(
  item: Extract<ResponsesInputItem, { role: 'user' | 'system' | 'developer' }>
): OpenAIMessage {
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
 * Adds a `reasoning` item to the open assistant turn, as the thinking block its token carries.
 *
 * @param turn - the open assistant turn
 * @param item - the item
 * @param position - its index in `input`
 * @returns the 400 for an item without a token, or with one the proxy did not write
 */
function addReasoning(
  turn: Turn,
  item: Extract<ResponsesInputItem, { type: 'reasoning' }>,
  position: number
): TranslationProblem | undefined {
  const param = `input.${String(position)}.encrypted_content`
  const encoded = item.encrypted_content
  if (encoded === undefined || encoded === null) {
    return {
      message:
        'A reasoning item needs its encrypted_content: the proxy stores nothing to look it up by id. Ask for it with include: ["reasoning.encrypted_content"]',
      param
    }
  }
  const token = decodeReasoningToken(encoded)
  if (token === undefined) {
    return { message: 'encrypted_content is not a reasoning token from this proxy', param }
  }
  turn.reasoning.push(token)
  turn.danglingReasoning = position
  turn.open = true
  return undefined
}

/**
 * Adds one input item to the conversation: to the open assistant turn, or as its own message.
 *
 * @param built - the messages so far
 * @param turn - the open assistant turn
 * @param indexedItem - the item and its index in `input`
 * @returns the 400 for a reasoning item the proxy can't replay, else `undefined`
 */
function addItem(
  built: Built,
  turn: Turn,
  indexedItem: readonly [number, ResponsesInputItem]
): TranslationProblem | undefined {
  const [position, item] = indexedItem
  if ('type' in item && item.type === 'reasoning') return addReasoning(turn, item, position)
  if ('type' in item && item.type === 'function_call') {
    turn.toolCalls.push({
      id: item.call_id,
      type: 'function',
      function: { name: item.name, arguments: item.arguments }
    })
  } else if ('role' in item && item.role === 'assistant') {
    turn.text.push(
      typeof item.content === 'string'
        ? item.content
        : item.content.map((part) => part.text).join('')
    )
  } else {
    const problem = flush(built, turn)
    if (problem !== undefined) return problem
    built.messages.push('role' in item ? inputMessage(item) : toolMessage(item))
    return undefined
  }
  turn.danglingReasoning = undefined
  turn.open = true
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
): { ok: true; built: Built } | ({ ok: false } & TranslationProblem) {
  const built: Built = { messages: [], reasoning: [] }
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
  const problem = flush(built, turn)
  return problem === undefined ? { ok: true, built } : { ok: false, ...problem }
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
 * Copies the sampling and length settings into chat's fields, leaving out the unset ones (absent
 * or `null`).
 *
 * @param request - the Responses request
 * @returns the chat fields
 */
function samplingOf(request: CreateResponseRequest): Partial<ChatCompletionRequest> {
  const { stream, temperature, top_p: topP, max_output_tokens: maxOutputTokens } = request
  const effort = request.reasoning?.effort
  return {
    ...(stream === undefined || stream === null ? {} : { stream }),
    ...(temperature === undefined || temperature === null ? {} : { temperature }),
    ...(topP === undefined || topP === null ? {} : { top_p: topP }),
    ...(maxOutputTokens === undefined || maxOutputTokens === null
      ? {}
      : { max_completion_tokens: maxOutputTokens }),
    ...(effort === undefined || effort === null ? {} : { reasoning_effort: effort })
  }
}

/**
 * Copies the tool-calling and request-labelling settings into chat's fields, leaving out the
 * unset ones (absent or `null`).
 *
 * @param request - the Responses request
 * @returns the chat fields
 */
function labelsOf(request: CreateResponseRequest): Partial<ChatCompletionRequest> {
  const { parallel_tool_calls: parallel, metadata, user, prompt_cache_key: cacheKey } = request
  return {
    ...(parallel === undefined || parallel === null ? {} : { parallel_tool_calls: parallel }),
    ...(metadata === undefined || metadata === null ? {} : { metadata }),
    ...(user === undefined || user === null ? {} : { user }),
    ...(cacheKey === undefined || cacheKey === null ? {} : { prompt_cache_key: cacheKey })
  }
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
  const { tool_choice: toolChoice, tools, text } = request
  const chat: ChatCompletionRequest = {
    ...samplingOf(request),
    ...labelsOf(request),
    model: request.model,
    messages: built.messages,
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
  // One pi assistant message per chat one, in order (`convertMessages`): otherwise reasoning
  // would land on another turn, so a mismatch fails the request instead.
  if (assistantIndex !== reasoning.length) {
    throw new Error(
      `Reasoning for ${String(reasoning.length)} assistant turns, but ${String(assistantIndex)} assistant messages`
    )
  }
  return { ...context, messages }
}
