/**
 * OpenAI's `prompt_cache_breakpoint` content-part field, carried to the APIs that take it.
 *
 * @remarks
 * pi rebuilds each provider's request from its own context, which has no breakpoints: the leading
 * system and developer messages become one string, and user parts lose any field pi does not know.
 * So the proxy puts the client's breakpoints back into pi's payload, in `onPayload`, where the API
 * has a slot for them: OpenAI's own chat completions and Responses at `api.openai.com`. There the
 * leading instruction string is replaced by the client's parts (text joined with the same blank
 * lines the proxy joins them with), and user parts get their breakpoint back by position. Every
 * change is checked against pi's text first, so a payload pi built differently is left alone.
 *
 * Elsewhere breakpoints are dropped and logged at debug (constitution, principle I): Codex sends
 * the system prompt as a plain `instructions` string, and an OpenAI-compatible server may refuse a
 * field it does not know.
 *
 * Some models on `api.openai.com` refuse the field with a 400 too: the ChatGPT-subscription ones
 * (`gpt-6-luna` and others, #163). The first refusal is retried once without breakpoints
 * ({@link retryWithoutBreakpoints}), and the model is remembered for the life of the process, so
 * each such model costs at most one failed request per proxy start.
 *
 * @packageDocumentation
 */

import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai'
import { proxyLogger } from '@proxy/logging'
import type { OpenAIMessage, PromptCacheBreakpoint } from '@proxy/openai/schemas'
import { isRecord } from '@proxy/utils/guards'

/** Logger for upstream payload handling. */
const breakpointLogger = proxyLogger('pi', 'complete')

/** The host whose chat completions and Responses APIs take `prompt_cache_breakpoint`. */
const OPENAI_HOST = 'api.openai.com'

/** The pi APIs that can carry breakpoints, with the payload field holding their messages. */
const MESSAGE_FIELD_BY_API: ReadonlyMap<string, 'messages' | 'input'> = new Map([
  ['openai-completions', 'messages'],
  ['openai-responses', 'input']
])

/**
 * Models, as `provider/id`, that refused `prompt_cache_breakpoint` in this process: their requests
 * leave the field out (#163).
 *
 * @remarks
 * Module state with no reset, on purpose: a refusal holds until restart. Vitest gives each test
 * file its own copy, so within a file each test that triggers a refusal uses its own model ID.
 */
const modelsRefusingBreakpoints = new Set<string>()

/**
 * The start of an upstream 400 as pi's OpenAI adapters word it, the JSON error body after it:
 * `400: {…}` (chat completions) and `OpenAI API error (400): {…}` (Responses).
 */
const BAD_REQUEST_PREFIX = /^(?:400: |[^\n(]{1,80} \(400\): )/

/** The separator the proxy joins instruction text with (`convertMessages`). */
const INSTRUCTION_SEPARATOR = '\n\n'

/** One part of a client message, as far as breakpoints are concerned. */
interface PlannedPart {
  /** `text` for a text part, `image` for an image part. */
  readonly kind: 'text' | 'image'
  /** A text part's text; empty for an image. */
  readonly text: string
  /** The part's breakpoint, when the client set one. */
  readonly breakpoint: PromptCacheBreakpoint | undefined
}

/** Where the client's breakpoints are, read from its messages. */
interface BreakpointPlan {
  /** The leading system and developer text as parts, when any of them has a breakpoint. */
  readonly instructions: readonly PlannedPart[] | undefined
  /** Every user message in order: its parts, or `undefined` for string content. */
  readonly users: readonly (readonly PlannedPart[] | undefined)[]
  /** How many breakpoints the request carries. */
  readonly count: number
}

/**
 * Reads a content part for its breakpoint.
 *
 * @param part - a text or image part of a client message
 * @returns the planned part
 */
function plannedPart(
  part:
    | { type: 'text'; text: string; prompt_cache_breakpoint?: PromptCacheBreakpoint | undefined }
    | { type: 'image_url'; prompt_cache_breakpoint?: PromptCacheBreakpoint | undefined }
): PlannedPart {
  return {
    kind: part.type === 'text' ? 'text' : 'image',
    text: part.type === 'text' ? part.text : '',
    breakpoint: part.prompt_cache_breakpoint
  }
}

/**
 * Collects the leading system and developer text as parts, blank ones left out, as
 * `convertMessages` joins them into pi's system prompt.
 *
 * @param messages - the request's messages
 * @returns the parts, in order
 */
function leadingInstructionParts(messages: readonly OpenAIMessage[]): PlannedPart[] {
  const parts: PlannedPart[] = []
  for (const message of messages) {
    if (message.role !== 'system' && message.role !== 'developer') break
    const content: PlannedPart[] =
      typeof message.content === 'string'
        ? [{ kind: 'text', text: message.content, breakpoint: undefined }]
        : message.content.map(plannedPart)
    parts.push(...content.filter((part) => part.text.trim().length > 0))
  }
  return parts
}

/**
 * Reads where the request's breakpoints are.
 *
 * @param messages - the request's messages
 * @returns the plan, or `undefined` when no part carries a breakpoint
 */
function breakpointPlan(messages: readonly OpenAIMessage[]): BreakpointPlan | undefined {
  const instructionParts = leadingInstructionParts(messages)
  const users = messages
    .filter((message) => message.role === 'user')
    .map((message) =>
      typeof message.content === 'string' ? undefined : message.content.map(plannedPart)
    )
  const all = [...instructionParts, ...users.flatMap((parts) => parts ?? [])]
  const count = all.filter((part) => part.breakpoint !== undefined).length
  if (count === 0) return undefined
  const instructions = instructionParts.some((part) => part.breakpoint !== undefined)
    ? instructionParts
    : undefined
  return { instructions, users, count }
}

/**
 * Says whether the model's API takes `prompt_cache_breakpoint`: OpenAI's own chat completions or
 * Responses, at `api.openai.com`.
 *
 * @param model - the pi model
 * @returns the payload field holding the messages, or `undefined` when breakpoints are dropped
 */
function messageField(model: Model<Api>): 'messages' | 'input' | undefined {
  const field = MESSAGE_FIELD_BY_API.get(model.api)
  if (field === undefined) return undefined
  try {
    return new URL(model.baseUrl).hostname === OPENAI_HOST ? field : undefined
  } catch {
    return undefined
  }
}

/**
 * The key a model is remembered by: `provider/id`, as two providers can serve one model ID.
 *
 * @param model - the pi model
 * @returns the model's `provider/id`
 */
function modelKey(model: Model<Api>): string {
  return `${model.provider}/${model.id}`
}

/**
 * Reads which request field an upstream 400 names, from the JSON body pi puts after the status.
 *
 * @param errorMessage - the failed call's error message, as pi's OpenAI adapters word it
 * @returns the body's `param` (also under `error`, as some bodies nest it), or `undefined` when the
 *   message is not a 400 with a JSON body
 */
function badRequestParam(errorMessage: string): unknown {
  const prefix = BAD_REQUEST_PREFIX.exec(errorMessage)?.[0]
  if (prefix === undefined) return undefined
  let body: unknown
  try {
    body = JSON.parse(errorMessage.slice(prefix.length))
  } catch {
    return undefined
  }
  if (!isRecord(body)) return undefined
  return isRecord(body['error']) ? body['error']['param'] : body['param']
}

/**
 * Turns planned instruction parts into the API's content parts, joined as the proxy joins them.
 *
 * @param parts - the leading instruction parts
 * @param textType - the API's text part type: `text` or `input_text`
 * @returns the content parts
 */
function instructionContent(parts: readonly PlannedPart[], textType: string): unknown[] {
  return parts.map((part, partIndex) => ({
    type: textType,
    text: partIndex < parts.length - 1 ? `${part.text}${INSTRUCTION_SEPARATOR}` : part.text,
    ...(part.breakpoint === undefined ? {} : { prompt_cache_breakpoint: part.breakpoint })
  }))
}

/**
 * Replaces the payload's leading instruction string with the client's parts, when it is exactly
 * their text.
 *
 * @param messages - the payload's messages
 * @param parts - the leading instruction parts
 * @param textType - the API's text part type
 * @returns how many breakpoints were placed
 */
function placeInstructions(
  messages: unknown[],
  parts: readonly PlannedPart[],
  textType: string
): number {
  const first = messages[0]
  if (!isRecord(first) || (first['role'] !== 'system' && first['role'] !== 'developer')) return 0
  const joined = parts.map((part) => part.text).join(INSTRUCTION_SEPARATOR)
  if (first['content'] !== joined) return 0
  first['content'] = instructionContent(parts, textType)
  return parts.filter((part) => part.breakpoint !== undefined).length
}

/**
 * Says whether a payload part is the planned one: the same kind and, for text, the same text.
 *
 * @param payloadPart - the part pi built
 * @param planned - the client's part
 * @returns whether the breakpoint may go on it
 */
function samePart(
  payloadPart: unknown,
  planned: PlannedPart
): payloadPart is Record<string, unknown> {
  if (!isRecord(payloadPart)) return false
  const type = payloadPart['type']
  // An image is matched by kind alone: its URL is rewritten on the way (a remote one inlined as
  // base64), so it cannot be compared. The caller has already lined up the message and its part
  // count, so the position identifies it.
  if (planned.kind === 'image') return type === 'image_url' || type === 'input_image'
  return (type === 'text' || type === 'input_text') && payloadPart['text'] === planned.text
}

/**
 * Puts user parts' breakpoints back on the parts pi built, matched by position.
 *
 * @param messages - the payload's messages
 * @param users - the client's user messages, in order
 * @returns how many breakpoints were placed
 */
function placeUserBreakpoints(
  messages: unknown[],
  users: readonly (readonly PlannedPart[] | undefined)[]
): number {
  const payloadUsers = messages.filter((message) => isRecord(message) && message['role'] === 'user')
  // pi built a different number of user messages: positions do not line up, so place none.
  if (payloadUsers.length !== users.length) return 0
  let placed = 0
  for (const [userIndex, planned] of users.entries()) {
    const content = isRecord(payloadUsers[userIndex])
      ? payloadUsers[userIndex]['content']
      : undefined
    if (planned === undefined || !Array.isArray(content) || content.length !== planned.length) {
      continue
    }
    for (const [partIndex, part] of planned.entries()) {
      const payloadPart: unknown = content[partIndex]
      if (part.breakpoint === undefined || !samePart(payloadPart, part)) continue
      payloadPart['prompt_cache_breakpoint'] = part.breakpoint
      placed++
    }
  }
  return placed
}

/**
 * Builds the payload patch that carries the request's breakpoints to the model's API, or logs
 * that they are dropped there.
 *
 * @param model - the pi model
 * @param messages - the request's messages
 * @returns the patch, or `undefined` when there is nothing to place (no breakpoints, or an API
 *   with no slot for them)
 */
export function breakpointPatch(
  model: Model<Api>,
  messages: readonly OpenAIMessage[]
): ((payload: Record<string, unknown>) => void) | undefined {
  const plan = breakpointPlan(messages)
  if (plan === undefined) return undefined
  const field = messageField(model)
  if (field === undefined) {
    breakpointLogger.debug(
      'Dropped {count} prompt_cache_breakpoint(s) for {modelId}: {api} has no slot for them',
      { count: plan.count, modelId: model.id, api: model.api }
    )
    return undefined
  }
  if (modelsRefusingBreakpoints.has(modelKey(model))) {
    breakpointLogger.debug(
      'Dropped {count} prompt_cache_breakpoint(s) for {modelId}: the model refused them earlier',
      { count: plan.count, modelId: model.id, api: model.api }
    )
    return undefined
  }
  const textType = field === 'input' ? 'input_text' : 'text'
  return (payload) => {
    const payloadMessages = payload[field]
    if (!Array.isArray(payloadMessages)) return
    const placed =
      (plan.instructions === undefined
        ? 0
        : placeInstructions(payloadMessages, plan.instructions, textType)) +
      placeUserBreakpoints(payloadMessages, plan.users)
    const properties = { placed, count: plan.count, modelId: model.id }
    // None placed on an API that takes them means pi built a payload this code does not recognize
    // (a pi change): the client's caching hints are lost, so it is a warning, not a debug line.
    if (placed === 0) {
      breakpointLogger.warn(
        'Placed none of {count} prompt_cache_breakpoint(s) for {modelId}: the upstream payload did not match the request',
        properties
      )
      return
    }
    breakpointLogger.debug(
      'Placed {placed} of {count} prompt_cache_breakpoint(s) for {modelId}',
      properties
    )
  }
}

/**
 * Decides whether a failed call is the model refusing the request's `prompt_cache_breakpoint`,
 * and if so remembers the model, so the caller can retry once without them (#163).
 *
 * @remarks
 * A refusal is an upstream 400 whose body names `prompt_cache_breakpoint` as its `param`, for a
 * request that sent breakpoints. Any other 400 is left as it is. A refusal that names the field
 * proves this request carried it, even when the model is already remembered: requests in flight
 * together all send it before the first refusal comes back, and each is retried (#166 review).
 * The retry is built after the model is remembered, so it cannot be refused for the field again.
 * The first refusal per model is logged at info; later requests drop the field at debug.
 *
 * @param model - the pi model
 * @param messages - the request's messages
 * @param failed - the call's final message
 * @returns whether to retry without breakpoints
 */
export function retryWithoutBreakpoints(
  model: Model<Api>,
  messages: readonly OpenAIMessage[],
  failed: AssistantMessage
): boolean {
  if (failed.stopReason !== 'error') return false
  if (badRequestParam(failed.errorMessage ?? '') !== 'prompt_cache_breakpoint') return false
  if (breakpointPlan(messages) === undefined || messageField(model) === undefined) return false
  const key = modelKey(model)
  if (modelsRefusingBreakpoints.has(key)) return true
  modelsRefusingBreakpoints.add(key)
  breakpointLogger.info(
    '{modelId} refused prompt_cache_breakpoint: retrying without it, and leaving it out for this model until the proxy restarts',
    { provider: model.provider, modelId: model.id, api: model.api }
  )
  return true
}
