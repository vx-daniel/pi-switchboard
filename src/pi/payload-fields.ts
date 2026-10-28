/**
 * Translation of a request's OpenAI fields into each pi API's payload: passed through for
 * OpenAI-compatible APIs, translated for Anthropic and Google, narrowed for Codex.
 *
 * @remarks
 * `src/pi/complete.ts` applies these through pi's `onPayload` hook (`passthroughHook`).
 *
 * @packageDocumentation
 */

import type { ChatCompletionRequest } from '@proxy/openai/schemas'
import { isRecord } from '@proxy/utils/guards'

/**
 * APIs that get every OpenAI passthrough field ({@link OPENAI_PASSTHROUGH_FIELDS}) verbatim, as
 * top-level payload properties.
 */
const OPENAI_FULL_PASSTHROUGH_APIS = new Set([
  'openai-completions',
  'openai-responses',
  'azure-openai-responses',
  'mistral-conversations'
])

/**
 * APIs that get only `tool_choice` and `parallel_tool_calls`.
 *
 * @remarks
 * The Codex Responses API rejects other standard fields (top_p, seed, stop, user,
 * frequency_penalty, etc.) with "Unsupported parameter". pi 1.4.0 sends
 * `tool_choice: options.toolChoice ?? "auto"` and hardcodes `parallel_tool_calls: true`;
 * onPayload overrides both when the client sends explicit values.
 */
const CODEX_APIS = new Set(['openai-codex-responses'])

/** APIs whose passthrough fields are translated to Anthropic's names and shapes. */
export const ANTHROPIC_APIS = new Set(['anthropic-messages'])

/** APIs whose passthrough fields are patched onto Google's `config` by {@link patchGooglePayload}. */
const GOOGLE_APIS = new Set(['google-generative-ai', 'google-vertex'])

// ---------------------------------------------------------------------------
// OpenAI-compatible payload fields
// ---------------------------------------------------------------------------

/** Request fields forwarded verbatim to OpenAI-compatible APIs, in payload order. */
const OPENAI_PASSTHROUGH_FIELDS = [
  'stop',
  'user',
  'top_p',
  'frequency_penalty',
  'presence_penalty',
  'seed',
  'response_format',
  'tool_choice',
  'parallel_tool_calls',
  'metadata',
  'prediction'
] as const satisfies readonly (keyof ChatCompletionRequest)[]

/**
 * Collects the OpenAI passthrough fields the request sets, for flat injection into the payload.
 *
 * @remarks
 * Exported for unit tests.
 *
 * @param request - the validated chat request
 * @returns the set fields under their OpenAI names, or `undefined` when none is set
 * @internal
 */
export function collectOpenAIPayloadFields(
  request: ChatCompletionRequest
): Record<string, unknown> | undefined {
  const fields: Record<string, unknown> = {}
  let hasFields = false

  for (const key of OPENAI_PASSTHROUGH_FIELDS) {
    const value = request[key]
    if (value !== undefined) {
      fields[key] = value
      hasFields = true
    }
  }

  return hasFields ? fields : undefined
}

// ---------------------------------------------------------------------------
// Anthropic payload translation
// ---------------------------------------------------------------------------

/**
 * Translates OpenAI `tool_choice` to Anthropic's `tool_choice` format.
 *
 * @remarks
 * - `"auto"` → `{ type: "auto" }`
 * - `"none"` → `{ type: "none" }` (Anthropic skips tool calling)
 * - `"required"` → `{ type: "any" }` (forces tool use)
 * - `{ type: "function", function: { name } }` → `{ type: "tool", name }`
 *
 * Exported for unit tests.
 *
 * @param toolChoice - the request's `tool_choice`, or `undefined` when not sent
 * @returns a new Anthropic `tool_choice` object, or `undefined` when `toolChoice` is
 * @internal
 */
export function translateToolChoiceForAnthropic(
  toolChoice: ChatCompletionRequest['tool_choice']
): Record<string, unknown> | undefined {
  if (toolChoice === undefined) {
    return undefined
  }
  if (toolChoice === 'auto') {
    return { type: 'auto' }
  }
  if (toolChoice === 'none') {
    return { type: 'none' }
  }
  if (toolChoice === 'required') {
    return { type: 'any' }
  }
  // Named function choice: { type: "function", function: { name } }
  return { type: 'tool', name: toolChoice.function.name }
}

/**
 * Collects Anthropic-format fields translated from the OpenAI request.
 *
 * @remarks
 * Translations:
 * - `top_p` → `top_p` (same name)
 * - `stop` → `stop_sequences` (always an array)
 * - `tool_choice` → Anthropic's `tool_choice` ({@link translateToolChoiceForAnthropic})
 * - `parallel_tool_calls: false` → `disable_parallel_tool_use: true` on `tool_choice` (with
 *   `{ type: "auto" }` when the request sets no `tool_choice`)
 *
 * `user` is not here: it goes to pi as `metadata.user_id`, set in `buildStreamOptions`.
 *
 * Skipped silently, as Anthropic has no equivalent: seed, frequency_penalty, presence_penalty,
 * response_format, prediction, metadata (arbitrary keys).
 *
 * Exported for unit tests.
 *
 * @param request - the validated chat request
 * @returns the translated fields, or `undefined` when none applies
 * @internal
 */
export function collectAnthropicPayloadFields(
  request: ChatCompletionRequest
): Record<string, unknown> | undefined {
  const fields: Record<string, unknown> = {}
  let hasFields = false

  if (request.top_p !== undefined) {
    fields['top_p'] = request.top_p
    hasFields = true
  }

  if (request.stop !== undefined) {
    const sequences = Array.isArray(request.stop) ? request.stop : [request.stop]
    fields['stop_sequences'] = sequences
    hasFields = true
  }

  // Build tool_choice with optional disable_parallel_tool_use
  const toolChoice = translateToolChoiceForAnthropic(request.tool_choice)
  const disableParallel = request.parallel_tool_calls === false

  if (toolChoice !== undefined) {
    if (disableParallel) {
      toolChoice['disable_parallel_tool_use'] = true
    }
    fields['tool_choice'] = toolChoice
    hasFields = true
  } else if (disableParallel) {
    // No explicit tool_choice but parallel disabled: set auto with flag
    fields['tool_choice'] = { type: 'auto', disable_parallel_tool_use: true }
    hasFields = true
  }

  return hasFields ? fields : undefined
}

// ---------------------------------------------------------------------------
// Google payload translation
// ---------------------------------------------------------------------------

/**
 * Translates OpenAI `tool_choice` to a Google `FunctionCallingConfigMode` string.
 *
 * @remarks
 * `"auto"` → `"AUTO"`, `"none"` → `"NONE"`, `"required"` → `"ANY"`. A named function also gives
 * `"ANY"`: the name is not passed on, so the model must call a tool but may pick any.
 *
 * @param toolChoice - the request's `tool_choice`, or `undefined` when not sent
 * @returns the mode, or `undefined` when `toolChoice` is
 */
function translateToolChoiceForGoogle(
  toolChoice: ChatCompletionRequest['tool_choice']
): string | undefined {
  if (toolChoice === undefined) {
    return undefined
  }
  if (toolChoice === 'auto') {
    return 'AUTO'
  }
  if (toolChoice === 'none') {
    return 'NONE'
  }
  // "required" or named function -> force tool use
  return 'ANY'
}

/**
 * Patches the translated passthrough fields into Google's payload, in place.
 *
 * @remarks
 * pi 1.4.0 builds `{ model, contents, config }`, with its own generation fields (temperature,
 * maxOutputTokens) flat on `config` and `toolConfig` beside them (pi-ai
 * dist/api/google-generative-ai.js and google-vertex.js, `buildParams`). `@google/genai` turns
 * those flat keys into the wire request's `generationConfig`; it does not read a nested
 * `config.generationConfig` (#110). This function writes:
 * - top_p, stop, seed, frequency_penalty, presence_penalty → flat on `config`
 *   (`topP`, `stopSequences`, `seed`, `frequencyPenalty`, `presencePenalty`)
 * - tool_choice → `config.toolConfig.functionCallingConfig.mode`
 *
 * A request field overrides a same-named key pi set: the client asked for that value. pi 1.4.0
 * sets none of the generation keys, but sets `toolConfig.functionCallingConfig.mode` whenever the
 * request has tools (the proxy passes it no `toolChoice`), so `tool_choice` replaces that mode.
 *
 * Skipped silently: response_format, metadata, prediction, parallel_tool_calls, user.
 *
 * Exported for unit tests.
 *
 * @param payload - the payload pi built; changed in place
 * @param request - the validated chat request
 * @returns whether anything was patched; `false` when the payload has no `config` object
 * @internal
 */
export function patchGooglePayload(
  payload: Record<string, unknown>,
  request: ChatCompletionRequest
): boolean {
  // Without a `config` object there is nothing to patch
  const config = isRecord(payload['config']) ? payload['config'] : undefined
  if (config === undefined) {
    return false
  }

  let patched = false
  // Flat on `config`, beside pi's own fields: @google/genai builds the wire request's
  // generationConfig from these keys and never reads a `config.generationConfig` object (#110).
  const genFields = collectGoogleGenerationFields(request)
  if (Object.keys(genFields).length > 0) {
    Object.assign(config, genFields)
    patched = true
  }

  // Tool choice -> toolConfig.functionCallingConfig.mode
  const mode = translateToolChoiceForGoogle(request.tool_choice)
  if (mode !== undefined) {
    const toolConfig = isRecord(config['toolConfig']) ? config['toolConfig'] : {}
    const funcConfig = isRecord(toolConfig['functionCallingConfig'])
      ? toolConfig['functionCallingConfig']
      : {}
    funcConfig['mode'] = mode
    toolConfig['functionCallingConfig'] = funcConfig
    config['toolConfig'] = toolConfig
    patched = true
  }

  return patched
}

/**
 * Collects the Google generation fields (camelCase) translated from the request.
 *
 * @param request - the validated chat request
 * @returns `topP`, `stopSequences`, `seed`, `frequencyPenalty` and `presencePenalty`, where set;
 *   empty when none is
 */
function collectGoogleGenerationFields(request: ChatCompletionRequest): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  if (request.top_p !== undefined) {
    fields['topP'] = request.top_p
  }
  if (request.stop !== undefined) {
    fields['stopSequences'] = Array.isArray(request.stop) ? request.stop : [request.stop]
  }
  if (request.seed !== undefined) {
    fields['seed'] = request.seed
  }
  if (request.frequency_penalty !== undefined) {
    fields['frequencyPenalty'] = request.frequency_penalty
  }
  if (request.presence_penalty !== undefined) {
    fields['presencePenalty'] = request.presence_penalty
  }
  return fields
}

// ---------------------------------------------------------------------------
// Codex Responses API (restricted passthrough)
// ---------------------------------------------------------------------------

/**
 * Collects the restricted set of fields the Codex Responses API accepts.
 *
 * @remarks
 * Only tool_choice and parallel_tool_calls are supported. pi sends tool_choice "auto" unless told
 * otherwise and hardcodes parallel_tool_calls: true; these overrides let clients control tool
 * behavior explicitly (`required`, a named tool, `parallel_tool_calls: false`).
 *
 * Exported for unit tests.
 *
 * @param request - the validated chat request
 * @returns `tool_choice` and `parallel_tool_calls` where set, or `undefined` when neither is
 * @internal
 */
export function collectCodexPayloadFields(
  request: ChatCompletionRequest
): Record<string, unknown> | undefined {
  const fields: Record<string, unknown> = {}
  let hasFields = false

  if (request.tool_choice !== undefined) {
    fields['tool_choice'] = request.tool_choice
    hasFields = true
  }
  if (request.parallel_tool_calls !== undefined) {
    fields['parallel_tool_calls'] = request.parallel_tool_calls
    hasFields = true
  }

  return hasFields ? fields : undefined
}

// ---------------------------------------------------------------------------
// Unified dispatch
// ---------------------------------------------------------------------------

/**
 * Collects the flat payload fields for the target API from an OpenAI request.
 *
 * @remarks
 * Dispatches on the API:
 * - OpenAI full passthrough: every standard field, same names
 * - Codex: tool_choice and parallel_tool_calls only
 * - Anthropic: translated field names and formats
 * - Google: none here; `config` is patched in onPayload by {@link patchGooglePayload}
 * - Others (Bedrock, …): no passthrough
 *
 * Exported for unit tests.
 *
 * @param request - the validated chat request
 * @param api - the model's pi API, such as `openai-completions`
 * @returns the fields to assign onto the payload, or `undefined` when there are none
 * @internal
 */
export function collectPayloadFields(
  request: ChatCompletionRequest,
  api: string
): Record<string, unknown> | undefined {
  if (OPENAI_FULL_PASSTHROUGH_APIS.has(api)) {
    return collectOpenAIPayloadFields(request)
  }
  if (CODEX_APIS.has(api)) {
    return collectCodexPayloadFields(request)
  }
  if (ANTHROPIC_APIS.has(api)) {
    return collectAnthropicPayloadFields(request)
  }
  // Google and others: no flat field collection
  // (Google uses patchGooglePayload directly in the onPayload callback)
  return undefined
}

/**
 * Reports whether an API's payload is patched the Google way ({@link patchGooglePayload}).
 *
 * @param api - the model's pi API
 * @returns whether `api` is in {@link GOOGLE_APIS}
 */
export function isGoogleApi(api: string): boolean {
  return GOOGLE_APIS.has(api)
}

/**
 * Names the payload passthrough strategy an API gets, for logging. Mirrors
 * {@link collectPayloadFields}.
 *
 * @param api - the model's pi API
 * @returns the strategy name; `none` for an API with no passthrough
 */
export function passthroughStrategy(
  api: string
): 'openai' | 'codex' | 'anthropic' | 'google' | 'none' {
  if (OPENAI_FULL_PASSTHROUGH_APIS.has(api)) return 'openai'
  if (CODEX_APIS.has(api)) return 'codex'
  if (ANTHROPIC_APIS.has(api)) return 'anthropic'
  if (GOOGLE_APIS.has(api)) return 'google'
  return 'none'
}
