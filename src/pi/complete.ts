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
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  isContextOverflow,
  type Model,
  type SimpleStreamOptions
} from '@earendil-works/pi-ai'
import { firstTimeInfoLog, proxyLogger } from '@proxy/logging'
import { supportedReasoningEfforts, thinkingLevelFor } from '@proxy/openai/reasoning-effort'
import type { ChatCompletionRequest, ReasoningEffort } from '@proxy/openai/schemas'
import { breakpointPatch, retryWithoutBreakpoints } from '@proxy/pi/cache-breakpoints'
import { canonicalModelId } from '@proxy/pi/model-id'
import {
  ANTHROPIC_APIS,
  collectPayloadFields,
  isGoogleApi,
  passthroughStrategy,
  patchGooglePayload
} from '@proxy/pi/payload-fields'
import { observingFetch } from '@proxy/pi/quota'
import { getRuntime } from '@proxy/pi/registry'
import { capturingFetch, type FailedResponse } from '@proxy/pi/reset-time'
import { upstreamTemperature } from '@proxy/pi/temperature'
import { relayUpstreamActivity, startUpstreamIdleTimeout } from '@proxy/pi/upstream-idle'
import { errorMessage, isRecord } from '@proxy/utils/guards'

/** Logger for upstream calls. */
const completeLogger = proxyLogger('pi', 'complete')

/** Per-request options for an upstream call, beyond the parsed request itself. */
export interface CompletionOptions {
  /** Per-request upstream API key override via the X-Switchboard-Upstream-Api-Key header. */
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
  /**
   * Receives a copy of the call's 429, 503 or 529 response (status, headers, body), for its reset
   * time (#68). pi's `onResponse` only sees successes, so this goes through pi's `fetch` option.
   */
  readonly onFailedResponse?: ((response: FailedResponse) => void) | undefined
  /** Which route and attempt the call is, for its upstream log lines (#70). */
  readonly route?: UpstreamRoute | undefined
  /**
   * Receives each upstream call's final message once it ends, streamed or not, for the route's
   * usage totals (#70). A call that refuses `prompt_cache_breakpoint` and is retried (#163) ends
   * twice.
   */
  readonly onResult?: ((message: AssistantMessage) => void) | undefined
  /** Receives every response's headers, for the quota they report (#69). */
  readonly onResponseHeaders?: ((headers: Headers) => void) | undefined
}

/** The route an upstream call is an attempt of: what its log lines are grouped by (#70). */
export interface UpstreamRoute {
  /** The alias the request named, or `null` for a request that named a model. */
  readonly alias: string | null
  /**
   * The attempt's number in the request's chain, from 1; cooldown skips and credential refusals
   * before it count, as in `x_pi.attempts`.
   */
  readonly attempt: number
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
 * Logs a clamped `reasoning_effort`: at info the first time per model (as `provider/id`) in this
 * process (#175), then at debug, as dropped temperatures are.
 */
const logClampedEffort = firstTimeInfoLog(completeLogger)

/**
 * Converts `reasoning_effort` to the thinking level `model` runs at (`thinkingLevelFor`).
 *
 * @remarks
 * pi has no "off" option: an absent `reasoning` is off. pi's adapters mostly clamp too, but
 * Anthropic's does not: without this, "none" on a model that always reasons would get the
 * provider's default effort (#41), and an unsupported level the adapter's own fallback (#43). A
 * clamped level is logged at info the first time per model, then at debug; the client sees it in
 * `x_pi.reasoning_effort`.
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
    logClampedEffort(
      canonicalModelId(model),
      'Clamped reasoning_effort {reasoningEffort} to thinking level {thinkingLevel} for {modelId}',
      {
        reasoningEffort: effort,
        thinkingLevel: level,
        modelId: model.id,
        supportedEfforts: supportedReasoningEfforts(model)
      }
    )
  }
  return level === 'off' ? undefined : level
}

/**
 * Builds the `onPayload` hook that injects the request's passthrough fields for `model.api`, and
 * puts the client's `prompt_cache_breakpoint`s back where the API takes them
 * (`@proxy/pi/cache-breakpoints`).
 *
 * @remarks
 * Tool `strict` is not patched here: convertTools maps it to pi's constrainedSampling, which each
 * API adapter applies in its own shape.
 *
 * @param model - the pi model; its `api` picks the strategy
 * @param request - the validated chat request
 * @returns the hook, or `undefined` when there is nothing to inject: the API gets no passthrough
 *   and no breakpoints, or (for a non-Google API) the request sets none of its fields
 */
function passthroughHook(
  model: Model<Api>,
  request: ChatCompletionRequest
): SimpleStreamOptions['onPayload'] {
  const payloadFields = collectPayloadFields(request, model.api)
  const needsGooglePatch = isGoogleApi(model.api)
  const placeBreakpoints = breakpointPatch(model, request.messages)
  const payloadFieldNames = payloadFields === undefined ? [] : Object.keys(payloadFields)

  completeLogger.debug('Payload passthrough for {api}: {passthrough}', {
    api: model.api,
    passthrough: passthroughStrategy(model.api),
    payloadFields: payloadFieldNames,
    googlePatch: needsGooglePatch
  })

  if (payloadFields === undefined && !needsGooglePatch && placeBreakpoints === undefined) {
    return undefined
  }
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
    // Google: fields set on the payload's `config` object
    const googlePatched = needsGooglePatch && patchGooglePayload(payload, request)
    placeBreakpoints?.(payload)
    completeLogger.debug('Patched upstream payload for {api}', {
      api: model.api,
      patchedFields: payloadFieldNames,
      googlePatched
    })
    return payload
  }
}

/**
 * Returns the `fetch` option that copies a failed response to `options.onFailedResponse` (#68)
 * and every response's headers to `options.onResponseHeaders` (#69).
 *
 * @param model - the pi model; pi's Google adapters refuse a custom fetch, so their 429s cool
 *   down for the default time instead, and they report no quota
 * @param options - the per-request options
 * @returns `{ fetch }`, or nothing to add
 */
function captureOptions(
  model: Model<Api>,
  options: CompletionOptions
): Pick<SimpleStreamOptions, 'fetch'> {
  const { onFailedResponse, onResponseHeaders } = options
  if (isGoogleApi(model.api)) return {}
  let fetch: typeof globalThis.fetch | undefined
  if (onFailedResponse !== undefined) fetch = capturingFetch(onFailedResponse)
  if (onResponseHeaders !== undefined) {
    fetch = observingFetch(onResponseHeaders, fetch ?? globalThis.fetch)
  }
  return fetch === undefined ? {} : { fetch }
}

/**
 * Returns the transport option: SSE for Codex (#185).
 *
 * @remarks
 * pi's Codex adapter tries a WebSocket first, and `fetch` sees nothing of it: a usage limit's
 * reset time and Codex's quota headers never reach the proxy. Over SSE they do. Measured live on
 * 2026-10-21 (`gpt-6-luna`): SSE was faster to the first event on short calls (median 954 ms vs
 * 1,522 ms) and even at a 31k-token history (1,071 ms vs 1,049 ms), where the WebSocket sends
 * only the new turns. PLAN "Cooldowns (#68)" has the numbers.
 *
 * @param model - the pi model
 * @returns `{ transport: 'sse' }` for Codex, or nothing to add
 */
function transportOptions(model: Model<Api>): Pick<SimpleStreamOptions, 'transport'> {
  return model.api === 'openai-codex-responses' ? { transport: 'sse' } : {}
}

/**
 * Takes the request's generation settings: reasoning level, temperature and output token limit.
 *
 * @param model - the pi model
 * @param request - the validated chat request
 * @returns the options it sets, each only when the request asks for it and the model takes it
 */
function generationOptions(
  model: Model<Api>,
  request: ChatCompletionRequest
): Pick<SimpleStreamOptions, 'reasoning' | 'temperature' | 'maxTokens'> {
  const opts: Pick<SimpleStreamOptions, 'reasoning' | 'temperature' | 'maxTokens'> = {}

  if (request.reasoning_effort !== undefined) {
    const level = reasoningLevel(model, request.reasoning_effort)
    if (level !== undefined) opts.reasoning = level
  }

  if (request.temperature !== undefined) {
    const temperature = upstreamTemperature(
      model,
      request.temperature,
      opts.reasoning !== undefined
    )
    if (temperature !== undefined) opts.temperature = temperature
  }

  // Normalize max_tokens / max_completion_tokens
  const maxTokens = request.max_completion_tokens ?? request.max_tokens
  if (maxTokens !== undefined) {
    opts.maxTokens = maxTokens
  }
  return opts
}

/**
 * Takes the request's `user` and `prompt_cache_key`, where pi has a place to send them.
 *
 * @param model - the pi model
 * @param request - the validated chat request
 * @returns `metadata` for an Anthropic model with a `user`, and `sessionId` for a cache key
 */
function userAndCacheKeyOptions(
  model: Model<Api>,
  request: ChatCompletionRequest
): Pick<SimpleStreamOptions, 'metadata' | 'sessionId'> {
  const opts: Pick<SimpleStreamOptions, 'metadata' | 'sessionId'> = {}

  // Anthropic takes OpenAI's `user` as metadata.user_id, its only metadata key. pi's Anthropic
  // adapter sends `metadata.user_id` from this option; other adapters do not read it (#48).
  if (request.user !== undefined && ANTHROPIC_APIS.has(model.api)) {
    opts.metadata = { user_id: request.user }
  }

  // pi sends the session ID as the provider's cache or session key where the API has one: OpenAI
  // Responses and Codex as `prompt_cache_key` (Codex over SSE here, so every request still sends
  // the whole conversation), chat completions on api.openai.com as `prompt_cache_key`, Anthropic as
  // a session-affinity header only with `compat.sendSessionAffinityHeaders` and never for an OAuth
  // login. Elsewhere it is unused. `null` is the same as no key (#39).
  if (request.prompt_cache_key !== undefined && request.prompt_cache_key !== null) {
    opts.sessionId = request.prompt_cache_key
  }
  return opts
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
  const opts: SimpleStreamOptions = {
    ...generationOptions(model, request),
    ...userAndCacheKeyOptions(model, request)
  }

  // The client disconnect signal combined with the upstream idle timeout
  if (signal !== undefined) {
    opts.signal = signal
  }

  // A per-request upstream key (X-Switchboard-Upstream-Api-Key) overrides everything. Without
  // one, leave apiKey unset: the ModelRuntime resolves request auth itself for the chosen model
  // (API keys, OAuth with refresh, model-specific headers, dynamic models.json headers).
  if (options.upstreamApiKey !== undefined) {
    opts.apiKey = options.upstreamApiKey
  }

  const onPayload = passthroughHook(model, request)
  if (onPayload !== undefined) opts.onPayload = onPayload

  // Last, so nothing set above can put Codex back on the WebSocket (#185).
  return { ...opts, ...captureOptions(model, options), ...transportOptions(model) }
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
 * Returns the properties every upstream log line carries: where the call went, the route it is an
 * attempt of, and how long it has run.
 *
 * @param call - the upstream call
 * @returns provider, model ID, API, stream mode, alias and attempt (when the caller named them) and
 *   duration so far in milliseconds
 */
function callProperties(call: UpstreamCall): Record<string, unknown> {
  return {
    provider: call.model.provider,
    modelId: call.model.id,
    api: call.model.api,
    stream: call.stream,
    alias: call.options.route?.alias,
    attempt: call.options.route?.attempt,
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
    alias: options.route?.alias,
    attempt: options.route?.attempt,
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
  logUpstreamErrorDetail(errorMessage(error))
}

/** What one upstream call needs: the model, pi's context, the OpenAI request and its options. */
interface UpstreamInput {
  readonly model: Model<Api>
  readonly context: Context
  readonly request: ChatCompletionRequest
  readonly options: CompletionOptions
}

/**
 * Handles an upstream call's end: logs its result and hands the final message to the caller's
 * `onResult`, for the route's usage totals (#70).
 *
 * @param call - the upstream call
 * @param message - the call's final assistant message
 */
function endUpstream(call: UpstreamCall, message: AssistantMessage): void {
  logUpstreamResult(call, message)
  call.options.onResult?.(message)
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
  void watched.result().then((message) => endUpstream(call, message))
  return watched
}

/**
 * Runs a non-streaming completion.
 *
 * @remarks
 * Reads the stream's final message, which is all pi's `completeSimple()` returns, so the idle
 * timeout sees every event. A model that refuses `prompt_cache_breakpoint` gets the request once
 * more without it, unless the client has left (#163, {@link retryWithoutBreakpoints}).
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
  const input: UpstreamInput = { model, context, request, options }
  const message = await (await openUpstream(input, false)).result()
  if (options.signal?.aborted === true) return message
  if (!retryWithoutBreakpoints(model, request.messages, message)) return message
  return (await openUpstream(input, false)).result()
}

/** A streaming call with its first event read: how the route tells a failure from a stream. */
export interface StartedStream {
  /** The call's first event, or the end of a stream that had none. */
  readonly first: IteratorResult<AssistantMessageEvent>
  /** The rest of the call's events, after {@link StartedStream.first}. */
  readonly events: AsyncIterator<AssistantMessageEvent>
}

/**
 * Opens a streaming call and reads its first event.
 *
 * @param input - the model, context, request and options
 * @returns the first event and the rest
 * @throws whatever opening the upstream call or reading its first event throws
 */
async function startStream(input: UpstreamInput): Promise<StartedStream> {
  const events = (await openUpstream(input, true))[Symbol.asyncIterator]()
  return { first: await events.next(), events }
}

/**
 * Starts a streaming completion and reads its first event.
 *
 * @remarks
 * The client's `options.signal` aborts the call. pi emits `start` only once the provider has
 * accepted the request, so a refusal is the first event: a model that refuses the request's
 * `prompt_cache_breakpoint` gets the request once more without them, before the client sees
 * anything (#163, {@link retryWithoutBreakpoints}).
 *
 * @param model - the pi model
 * @param context - pi's context: system prompt, messages and tools
 * @param request - the validated chat request
 * @param options - the per-request options
 * @returns the call's first event and the rest of its events
 * @throws whatever opening the upstream call throws
 */
export async function piStream(
  model: Model<Api>,
  context: Context,
  request: ChatCompletionRequest,
  options: CompletionOptions
): Promise<StartedStream> {
  const input: UpstreamInput = { model, context, request, options }
  const started = await startStream(input)
  const refused =
    options.signal?.aborted !== true &&
    started.first.done !== true &&
    started.first.value.type === 'error' &&
    retryWithoutBreakpoints(model, request.messages, started.first.value.error)
  // A refused stream is finished: pi ends it with the error event, `first` here, so there is
  // nothing left to drain or close before the retry replaces it.
  return refused ? startStream(input) : started
}
