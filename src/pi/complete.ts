/**
 * Pi completion integration: non-streaming and streaming.
 *
 * @remarks
 * Bridges validated OpenAI requests to pi's `streamSimple()`. A non-streaming request reads the
 * stream's final message, as pi's own `completeSimple()` does, so both modes share the upstream
 * idle timeout (`src/pi/upstream-idle.ts`).
 *
 * @packageDocumentation
 */

import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  isContextOverflow,
  type Model,
  type SimpleStreamOptions
} from '@earendil-works/pi-ai'
import { proxyLogger } from '@proxy/logging'
import { supportedReasoningEfforts, thinkingLevelFor } from '@proxy/openai/reasoning-effort'
import type { ChatCompletionRequest, ReasoningEffort } from '@proxy/openai/schemas'
import { getRuntime } from '@proxy/pi/registry'
import { relayUpstreamActivity, startUpstreamIdleTimeout } from '@proxy/pi/upstream-idle'
import { isRecord } from '@proxy/utils/guards'

/** Logger for upstream calls. */
const completeLogger = proxyLogger('pi', 'complete')

/** Codex models a temperature has been dropped for in this process; each is logged at info once. */
const modelsWithDroppedTemperature = new Set<string>()

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
 * frequency_penalty, etc.) with "Unsupported parameter". pi 1.3.0 sends
 * `tool_choice: options.toolChoice ?? "auto"` and hardcodes `parallel_tool_calls: true`;
 * onPayload overrides both when the client sends explicit values.
 */
const CODEX_APIS = new Set(['openai-codex-responses'])

/** APIs whose passthrough fields are translated to Anthropic's names and shapes. */
const ANTHROPIC_APIS = new Set(['anthropic-messages'])

/**
 * APIs whose passthrough fields are patched into Google's nested payload.
 *
 * @remarks
 * pi 1.3.0 has no `google-gemini-cli` API; that entry matches no model.
 */
const GOOGLE_APIS = new Set(['google-generative-ai', 'google-gemini-cli', 'google-vertex'])

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
 * Patches the translated passthrough fields into Google's nested payload, in place.
 *
 * @remarks
 * pi 1.3.0 builds `{ model, contents, config }`, with its own generation fields (temperature,
 * maxOutputTokens) flat on `config` and `toolConfig` beside them (pi-ai
 * dist/api/google-generative-ai.js and google-vertex.js, `buildParams`). This function writes:
 * - top_p, stop, seed, frequency_penalty, presence_penalty → `config.generationConfig`
 *   (`topP`, `stopSequences`, `seed`, `frequencyPenalty`, `presencePenalty`)
 * - tool_choice → `config.toolConfig.functionCallingConfig.mode`
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
  const genFields = collectGoogleGenerationFields(request)
  if (Object.keys(genFields).length > 0) {
    const genConfig = isRecord(config['generationConfig']) ? config['generationConfig'] : {}
    Object.assign(genConfig, genFields)
    config['generationConfig'] = genConfig
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
 * - Google: none here; the nested payload is patched in onPayload by {@link patchGooglePayload}
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
 * Reports whether an API needs Google-style nested payload patching.
 *
 * @param api - the model's pi API
 * @returns whether `api` is in {@link GOOGLE_APIS}
 */
function isGoogleApi(api: string): boolean {
  return GOOGLE_APIS.has(api)
}

/**
 * Names the payload passthrough strategy an API gets, for logging. Mirrors
 * {@link collectPayloadFields}.
 *
 * @param api - the model's pi API
 * @returns the strategy name; `none` for an API with no passthrough
 */
function passthroughStrategy(api: string): 'openai' | 'codex' | 'anthropic' | 'google' | 'none' {
  if (OPENAI_FULL_PASSTHROUGH_APIS.has(api)) return 'openai'
  if (CODEX_APIS.has(api)) return 'codex'
  if (ANTHROPIC_APIS.has(api)) return 'anthropic'
  if (GOOGLE_APIS.has(api)) return 'google'
  return 'none'
}

/** Per-request options for an upstream call, beyond the parsed request itself. */
export interface CompletionOptions {
  /** Per-request upstream API key override via X-Pi-Upstream-Api-Key header. */
  readonly upstreamApiKey?: string | undefined
  /**
   * The client's disconnect, and nothing else: the route tells a client that left from an upstream
   * failure by it. The upstream idle timeout is combined with it only for pi (combineSignals).
   */
  readonly signal?: AbortSignal | undefined
  /**
   * The longest the provider may go without sending anything, in milliseconds. Restarts on every
   * upstream event; it does not cap the call's total duration.
   */
  readonly upstreamTimeoutMs?: number | undefined
}

/**
 * Combines the client disconnect signal with the upstream idle timeout's signal.
 *
 * @param clientSignal - the client's disconnect signal, or `undefined`
 * @param idleSignal - the idle timeout's signal, or `undefined` when there is no timeout
 * @returns a signal that aborts when either does, the one given when only one is, or `undefined`
 *   when neither is
 */
function combineSignals(
  clientSignal: AbortSignal | undefined,
  idleSignal: AbortSignal | undefined
): AbortSignal | undefined {
  if (clientSignal === undefined) return idleSignal
  if (idleSignal === undefined) return clientSignal
  return AbortSignal.any([clientSignal, idleSignal])
}

/**
 * Converts `reasoning_effort` to the thinking level `model` runs at (`thinkingLevelFor`).
 *
 * @remarks
 * pi has no "off" option: an absent `reasoning` is off. pi's adapters mostly clamp too, but
 * Anthropic's does not: without this, "none" on a model that always reasons would get the
 * provider's default effort (#41), and an unsupported level the adapter's own fallback (#43). A
 * clamped level is logged at debug.
 *
 * @param model - the pi model
 * @param effort - the request's `reasoning_effort`
 * @returns the thinking level for pi's `reasoning` option, or `undefined` for off
 */
function reasoningLevel(
  model: Model<Api>,
  effort: ReasoningEffort
): SimpleStreamOptions['reasoning'] {
  const { level, clamped } = thinkingLevelFor(model, effort)
  if (clamped) {
    completeLogger.debug(
      'Clamped reasoning_effort {reasoningEffort} to thinking level {thinkingLevel} for {modelId}',
      () => ({
        reasoningEffort: effort,
        thinkingLevel: level,
        modelId: model.id,
        supportedEfforts: supportedReasoningEfforts(model)
      })
    )
  }
  return level === 'off' ? undefined : level
}

/**
 * Returns the temperature to send upstream for `model`.
 *
 * @remarks
 * The Codex backend rejects temperature ("Unsupported parameter: temperature"), though pi 1.3.0
 * forwards it. Dropped rather than refused, so clients that always send one keep working on
 * Codex models (#49). The first drop per model is logged at info so the operator sees it; the
 * rest at debug, as a client that always sends one would otherwise log a line per request.
 *
 * @param model - the pi model
 * @param temperature - the request's temperature
 * @returns `temperature`, or `undefined` when it must be dropped (Codex models)
 */
function upstreamTemperature(model: Model<Api>, temperature: number): number | undefined {
  if (model.api !== 'openai-codex-responses') return temperature
  const firstForModel = !modelsWithDroppedTemperature.has(model.id)
  modelsWithDroppedTemperature.add(model.id)
  const dropped =
    'Dropped temperature {temperature} for {modelId}: the Codex backend does not accept it'
  const properties = { temperature, modelId: model.id, api: model.api }
  if (firstForModel) completeLogger.info(dropped, properties)
  else completeLogger.debug(dropped, properties)
  return undefined
}

/**
 * Builds the `onPayload` hook that injects the request's passthrough fields for `model.api`.
 *
 * @remarks
 * Tool `strict` is not patched here: convertTools maps it to pi's constrainedSampling, which each
 * API adapter applies in its own shape.
 *
 * @param model - the pi model; its `api` picks the strategy
 * @param request - the validated chat request
 * @returns the hook, or `undefined` when there is nothing to inject: the API gets no passthrough,
 *   or (for a non-Google API) the request sets none of its fields
 */
function passthroughHook(
  model: Model<Api>,
  request: ChatCompletionRequest
): SimpleStreamOptions['onPayload'] {
  const payloadFields = collectPayloadFields(request, model.api)
  const needsGooglePatch = isGoogleApi(model.api)
  const payloadFieldNames = payloadFields === undefined ? [] : Object.keys(payloadFields)

  completeLogger.debug('Payload passthrough for {api}: {passthrough}', {
    api: model.api,
    passthrough: passthroughStrategy(model.api),
    payloadFields: payloadFieldNames,
    googlePatch: needsGooglePatch
  })

  if (payloadFields === undefined && !needsGooglePatch) return undefined
  return (payload: unknown) => {
    if (!isRecord(payload)) {
      completeLogger.warn('Upstream payload for {api} is not an object; passthrough not applied', {
        api: model.api,
        payloadType: typeof payload
      })
      return payload
    }
    // Flat field injection (OpenAI-compatible and Anthropic)
    if (payloadFields !== undefined) Object.assign(payload, payloadFields)
    // Google nested generationConfig patching
    const googlePatched = needsGooglePatch && patchGooglePayload(payload, request)
    completeLogger.debug('Patched upstream payload for {api}', {
      api: model.api,
      patchedFields: payloadFieldNames,
      googlePatched
    })
    return payload
  }
}

/**
 * Builds pi's `SimpleStreamOptions` from an OpenAI request.
 *
 * @param model - the pi model
 * @param request - the validated chat request
 * @param options - the per-request options; `upstreamApiKey` becomes `apiKey`
 * @param signal - the combined client and idle-timeout signal, or `undefined`
 * @returns the options for `streamSimple`
 */
async function buildStreamOptions(
  model: Model<Api>,
  request: ChatCompletionRequest,
  options: CompletionOptions,
  signal: AbortSignal | undefined
): Promise<SimpleStreamOptions> {
  const opts: SimpleStreamOptions = {}

  if (request.temperature !== undefined) {
    const temperature = upstreamTemperature(model, request.temperature)
    if (temperature !== undefined) opts.temperature = temperature
  }

  // Normalize max_tokens / max_completion_tokens
  const maxTokens = request.max_completion_tokens ?? request.max_tokens
  if (maxTokens !== undefined) {
    opts.maxTokens = maxTokens
  }

  if (request.reasoning_effort !== undefined) {
    const level = reasoningLevel(model, request.reasoning_effort)
    if (level !== undefined) opts.reasoning = level
  }

  // Anthropic takes OpenAI's `user` as metadata.user_id, its only metadata key. pi's Anthropic
  // adapter sends `metadata.user_id` from this option; other adapters do not read it (#48).
  if (request.user !== undefined && ANTHROPIC_APIS.has(model.api)) {
    opts.metadata = { user_id: request.user }
  }

  // The client disconnect signal combined with the upstream idle timeout
  if (signal !== undefined) {
    opts.signal = signal
  }

  // A per-request upstream key (X-Pi-Upstream-Api-Key) overrides everything. Without one, leave
  // apiKey unset: the ModelRuntime resolves request auth itself for the chosen model (API keys,
  // OAuth with refresh, model-specific headers, dynamic models.json headers).
  if (options.upstreamApiKey !== undefined) {
    opts.apiKey = options.upstreamApiKey
  }

  const onPayload = passthroughHook(model, request)
  if (onPayload !== undefined) opts.onPayload = onPayload

  return opts
}

/**
 * Tells why an upstream call was aborted.
 *
 * @param clientSignal - the client's disconnect signal
 * @param upstreamSignal - the signal pi was given (client and idle timeout combined)
 * @returns `client` when the client went away, `timeout` when the idle timeout fired, else
 *   `unknown`
 */
function abortCause(
  clientSignal: AbortSignal | undefined,
  upstreamSignal: AbortSignal | undefined
): 'client' | 'timeout' | 'unknown' {
  if (clientSignal?.aborted === true) return 'client'
  if (upstreamSignal?.aborted === true) return 'timeout'
  return 'unknown'
}

/** One upstream call, as the logging helpers below see it. */
interface UpstreamCall {
  readonly model: Model<Api>
  readonly options: CompletionOptions
  readonly opts: SimpleStreamOptions
  readonly stream: boolean
  /** `performance.now()` when the call started. */
  readonly startedAt: number
}

/**
 * Returns the properties every upstream log line carries: where the call went and how long it has
 * run.
 *
 * @param call - the upstream call
 * @returns provider, model ID, API, stream mode and duration so far in milliseconds
 */
function callProperties(call: UpstreamCall): Record<string, unknown> {
  return {
    provider: call.model.provider,
    modelId: call.model.id,
    api: call.model.api,
    stream: call.stream,
    durationMs: Math.round(performance.now() - call.startedAt)
  }
}

/**
 * Logs the start of an upstream call at debug: what is sent where, never what it says.
 *
 * @param call - the upstream call
 * @param context - pi's context, for message and tool counts
 * @param request - the validated chat request, for its reasoning effort
 */
function logUpstreamStart(
  call: UpstreamCall,
  context: Context,
  request: ChatCompletionRequest
): void {
  const { model, options, opts, stream } = call
  completeLogger.debug('Calling {provider}/{modelId} via {api}', () => ({
    provider: model.provider,
    modelId: model.id,
    api: model.api,
    stream,
    messageCount: context.messages.length,
    toolCount: context.tools?.length ?? 0,
    reasoningEffort: request.reasoning_effort,
    thinkingLevel: opts.reasoning,
    maxTokens: opts.maxTokens,
    upstreamTimeoutMs: options.upstreamTimeoutMs,
    upstreamKeyOverride: options.upstreamApiKey !== undefined
  }))
}

/**
 * Logs the provider's raw error text at debug only.
 *
 * @remarks
 * Some providers quote parts of the request back, and request content is never logged at a level
 * a default deployment writes.
 *
 * @param detail - the raw error text; nothing is logged when `undefined`
 */
function logUpstreamErrorDetail(detail: string | undefined): void {
  if (detail !== undefined) {
    completeLogger.debug('Upstream error detail: {detail}', { detail })
  }
}

/**
 * Logs how an upstream call ended: stop reason, duration and usage, or why it failed.
 *
 * @param call - the upstream call
 * @param message - the call's final assistant message
 */
function logUpstreamResult(call: UpstreamCall, message: AssistantMessage): void {
  if (message.stopReason === 'error') {
    completeLogger.warn('Upstream call to {modelId} failed after {durationMs} ms', () => ({
      ...callProperties(call),
      stopReason: message.stopReason,
      rawStopReason: message.rawStopReason
    }))
    logUpstreamErrorDetail(message.errorMessage)
    return
  }
  if (message.stopReason === 'aborted') {
    completeLogger.warn(
      'Upstream call to {modelId} aborted after {durationMs} ms ({abortCause})',
      () => ({
        ...callProperties(call),
        stopReason: message.stopReason,
        abortCause: abortCause(call.options.signal, call.opts.signal)
      })
    )
    logUpstreamErrorDetail(message.errorMessage)
    return
  }
  // A provider that accepted an over-long prompt and answered anyway (input beyond the context
  // window, or a length stop with no output) truncated it silently. The answer still goes to the
  // client: it was not an error, but the operator should know the model did not see everything.
  if (isContextOverflow(message, call.model.contextWindow)) {
    completeLogger.warn(
      'Upstream call to {modelId} looks like a silent context overflow: {inputTokens} input tokens for a {contextWindow}-token window',
      () => ({
        ...callProperties(call),
        stopReason: message.stopReason,
        inputTokens: message.usage.input + message.usage.cacheRead,
        outputTokens: message.usage.output,
        contextWindow: call.model.contextWindow
      })
    )
  }
  completeLogger.debug(
    'Upstream call to {modelId} finished in {durationMs} ms: {stopReason}',
    () => ({
      ...callProperties(call),
      stopReason: message.stopReason,
      rawStopReason: message.rawStopReason,
      responseModel: message.responseModel,
      inputTokens: message.usage.input,
      outputTokens: message.usage.output,
      cacheReadTokens: message.usage.cacheRead,
      cacheWriteTokens: message.usage.cacheWrite,
      reasoningTokens: message.usage.reasoning,
      totalTokens: message.usage.totalTokens,
      costTotal: message.usage.cost.total
    })
  )
}

/**
 * Logs an upstream call that threw instead of reporting an error message; the caller rethrows.
 *
 * @param call - the upstream call
 * @param error - what was thrown
 */
function logUpstreamThrow(call: UpstreamCall, error: unknown): void {
  const aborted = call.opts.signal?.aborted === true
  completeLogger.warn('Upstream call to {modelId} threw after {durationMs} ms', () => ({
    ...callProperties(call),
    aborted,
    abortCause: aborted ? abortCause(call.options.signal, call.opts.signal) : undefined,
    errorName: error instanceof Error ? error.name : typeof error
  }))
  logUpstreamErrorDetail(error instanceof Error ? error.message : String(error))
}

/** What one upstream call needs: the model, pi's context, the OpenAI request and its options. */
interface UpstreamInput {
  readonly model: Model<Api>
  readonly context: Context
  readonly request: ChatCompletionRequest
  readonly options: CompletionOptions
}

/**
 * Starts an upstream call: builds the options, starts the idle timeout, opens pi's event stream and
 * watches it.
 *
 * @remarks
 * The result is logged once the stream ends with done or error.
 *
 * @param input - the model, pi context, request and per-request options
 * @param stream - whether the client asked for a stream; used for logging only
 * @returns pi's event stream, relayed through the idle timeout when there is one
 * @throws whatever building the options or `streamSimple` throws, after disposing the timeout
 */
async function openUpstream(
  input: UpstreamInput,
  stream: boolean
): Promise<AssistantMessageEventStream> {
  const { model, context, request, options } = input
  const idle =
    options.upstreamTimeoutMs === undefined
      ? undefined
      : startUpstreamIdleTimeout(options.upstreamTimeoutMs)
  let opts: SimpleStreamOptions
  try {
    opts = await buildStreamOptions(
      model,
      request,
      options,
      combineSignals(options.signal, idle?.signal)
    )
  } catch (error) {
    idle?.dispose()
    throw error
  }
  // Every raw provider event restarts the wait, including those pi makes no event of (#50). The
  // event itself is not read: it carries message content.
  if (idle !== undefined) {
    opts.onProviderStreamEvent = () => {
      idle.touch()
    }
  }
  const call: UpstreamCall = { model, options, opts, stream, startedAt: performance.now() }
  logUpstreamStart(call, context, request)
  let eventStream: AssistantMessageEventStream
  try {
    eventStream = getRuntime().streamSimple(model, context, opts)
  } catch (error) {
    idle?.dispose()
    logUpstreamThrow(call, error)
    throw error
  }
  const watched =
    idle === undefined
      ? eventStream
      : relayUpstreamActivity(eventStream, idle, options.signal, model)
  // Resolves with the final message once the stream ends with done or error; it never rejects.
  void watched.result().then((message) => logUpstreamResult(call, message))
  return watched
}

/**
 * Runs a non-streaming completion.
 *
 * @remarks
 * Reads the stream's final message, which is all pi's `completeSimple()` returns, so the idle
 * timeout sees every event.
 *
 * @param model - the pi model
 * @param context - pi's context: system prompt, messages and tools
 * @param request - the validated chat request
 * @param options - the per-request options
 * @returns the final assistant message; a failed call ends with `stopReason` `error` or `aborted`
 * @throws whatever opening the upstream call throws
 */
export async function piComplete(
  model: Model<Api>,
  context: Context,
  request: ChatCompletionRequest,
  options: CompletionOptions
): Promise<AssistantMessage> {
  const eventStream = await openUpstream({ model, context, request, options }, false)
  return eventStream.result()
}

/**
 * Starts a streaming completion.
 *
 * @remarks
 * The client's `options.signal` aborts the call.
 *
 * @param model - the pi model
 * @param context - pi's context: system prompt, messages and tools
 * @param request - the validated chat request
 * @param options - the per-request options
 * @returns pi's event stream for the call
 * @throws whatever opening the upstream call throws
 */
export async function piStream(
  model: Model<Api>,
  context: Context,
  request: ChatCompletionRequest,
  options: CompletionOptions
): Promise<AssistantMessageEventStream> {
  return openUpstream({ model, context, request, options }, true)
}
