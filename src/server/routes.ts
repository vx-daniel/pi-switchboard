/**
 * Hono route handlers for the OpenAI-compatible proxy endpoints.
 *
 * @remarks
 * Endpoints:
 * - `GET  /v1/models`
 * - `GET  /v1/models/{model}` (URL-encoded IDs with slashes work)
 * - `GET  /v1/pi/models` (not OpenAI's: pi's capabilities for each exposed model)
 * - `POST /v1/chat/completions`
 * - a fixed list of OpenAI endpoints the proxy does not implement, answered with 404
 *
 * All of them sit behind proxy auth, applied to `/v1/*` in `createApp`.
 *
 * @packageDocumentation
 */

import type { AssistantMessageEvent } from '@earendil-works/pi-ai'
import type { ServerConfig } from '@proxy/config/env'
import { loadConfigFromFile } from '@proxy/config/schema'
import { proxyLogger } from '@proxy/logging'
import { type ConversionSuccess, convertMessages } from '@proxy/openai/messages'
import {
  computeModelExposure,
  type ExposedModel,
  type ModelExposureConfig,
  type ModelExposureResult,
  resolveExposedModel
} from '@proxy/openai/model-exposure'
import { buildModelList, buildPiModelList, toOpenAIModel } from '@proxy/openai/models'
import {
  type RemoteImageFetchOptions,
  STRICT_REMOTE_IMAGE_FETCH
} from '@proxy/openai/remote-image-fetch'
import { inlineRemoteImages } from '@proxy/openai/remote-images'
import { buildChatCompletion } from '@proxy/openai/responses'
import { streamToSSE } from '@proxy/openai/sse'
import { convertTools } from '@proxy/openai/tools'
import { type ValidationSuccess, validateChatRequest } from '@proxy/openai/validate'
import { type CompletionOptions, piComplete, piStream } from '@proxy/pi/complete'
import { getAvailableModels, getEnabledModels, getRequestAuth } from '@proxy/pi/registry'
import {
  authenticationError,
  invalidRequest,
  type MappedUpstreamError,
  mapFailedCall,
  mapUpstreamError,
  modelNotFound,
  unsupportedParameter
} from '@proxy/server/errors'
import {
  HTTP_BAD_REQUEST,
  HTTP_NOT_FOUND,
  HTTP_SERVICE_UNAVAILABLE,
  HTTP_TOO_MANY_REQUESTS,
  HTTP_UNAUTHORIZED,
  HTTP_UNPROCESSABLE_ENTITY
} from '@proxy/server/http-status'
import type { ProxyEnv } from '@proxy/server/types'
import { type Context, Hono } from 'hono'
import { stream as honoStream } from 'hono/streaming'

/**
 * Reads the model exposure config.
 *
 * @remarks
 * In production ({@link fileConfigReader}) this re-reads the config file and pi's settings on each
 * request (small JSON files, negligible next to upstream latency). Tests pass a reader that returns
 * fixed values.
 */
export type ExposureConfigReader = () => ModelExposureConfig | Promise<ModelExposureConfig>

/** Logger for chat and model requests. */
const chatLogger = proxyLogger('server', 'chat')
/** Logger for rejected endpoints. */
const httpLogger = proxyLogger('server', 'http')

/**
 * Reads the exposure config from the proxy's config file and pi's `enabledModels` setting.
 *
 * @returns the exposure config; `enabledModels` is `undefined` when pi's settings set none
 */
export async function fileConfigReader(): Promise<ModelExposureConfig> {
  const file = loadConfigFromFile()
  const enabledModels = await getEnabledModels()
  chatLogger.debug('Read exposure config: {modelExposureMode}, {publicModelIdMode}', {
    modelExposureMode: file.modelExposureMode,
    publicModelIdMode: file.publicModelIdMode,
    enabledModelCount: enabledModels?.length,
    customModelCount: file.customModels.length,
    providerPrefixCount: Object.keys(file.providerPrefixes).length
  })
  return {
    publicModelIdMode: file.publicModelIdMode,
    modelExposureMode: file.modelExposureMode,
    enabledModels,
    customModels: file.customModels,
    providerPrefixes: file.providerPrefixes
  }
}

/** The chat completions path. */
const CHAT_PATH = '/v1/chat/completions'
/** The prefix before the model ID in a model detail path. */
const MODELS_PREFIX = '/v1/models/'

/** The Hono context a route handler gets. */
type ProxyContext = Context<ProxyEnv>
/** A validated chat completion request body. */
type ChatRequest = ValidationSuccess['data']
/** A pi model, as the exposure engine resolves it. */
type PiModel = ExposedModel['model']
/** A pi `Context`: system prompt, messages and tools. */
type PiContext = ConversionSuccess['context']

/**
 * Either a successfully produced value or an early error response.
 *
 * @typeParam T - the value a successful step produces
 */
type Step<T> = { ok: true; value: T } | { ok: false; response: Response }

/**
 * Computes which models are exposed, from pi's available models and the exposure config.
 *
 * @param configReader - where the exposure config comes from
 * @returns the exposed models and their scope diagnostics
 * @throws Error when the exposure config is invalid; Hono answers it with 500
 */
async function getExposure(configReader: ExposureConfigReader): Promise<ModelExposureResult> {
  const available = getAvailableModels()
  const outcome = computeModelExposure(available, await configReader())
  if (!outcome.ok) {
    // Thrown to Hono, which answers 500: the exposure config cannot serve any request.
    chatLogger.error('Model exposure configuration error: {message}', {
      message: outcome.message,
      availableModelCount: available.length
    })
    throw new Error(`Model exposure configuration error: ${outcome.message}`)
  }
  chatLogger.debug('Exposing {exposedModelCount} of {availableModelCount} available models', {
    exposedModelCount: outcome.models.length,
    availableModelCount: available.length
  })
  return outcome
}

/**
 * Logs a mapped upstream failure.
 *
 * @remarks
 * An error line for the failure, plus a warning for rate limiting or overload (429, 503) so those
 * can be counted apart from real failures. The raw upstream `detail` stays at debug: some
 * providers quote parts of the request back. The request's IDs come from the logging context.
 *
 * @param mapped - the status and body the client gets
 * @param detail - the raw upstream error message, or `undefined` when there is none
 * @returns `mapped`, unchanged
 */
function reportUpstreamFailure(
  mapped: MappedUpstreamError,
  detail: string | undefined
): MappedUpstreamError {
  chatLogger.error('Upstream call failed with {status}: {message}', {
    status: mapped.status,
    message: mapped.body.error.message,
    code: mapped.body.error.code
  })
  if (detail !== undefined) {
    chatLogger.debug('Upstream error detail: {detail}', { detail })
  }
  if (mapped.status === HTTP_TOO_MANY_REQUESTS || mapped.status === HTTP_SERVICE_UNAVAILABLE) {
    chatLogger.warn('Upstream overloaded ({upstreamStatus}, {code})', {
      upstreamStatus: mapped.status,
      code: mapped.body.error.code ?? 'unknown'
    })
  }
  return mapped
}

/**
 * Maps and logs a thrown upstream failure, as {@link reportUpstreamFailure} does.
 *
 * @param err - the thrown value; an `Error`'s message is both mapped and logged as the detail
 * @returns the status and body the client gets
 */
function reportThrownFailure(err: unknown): MappedUpstreamError {
  return reportUpstreamFailure(
    mapUpstreamError(err),
    err instanceof Error ? err.message : undefined
  )
}

/**
 * Parses the JSON body and validates it as a chat completion request.
 *
 * @param context - the request's Hono context
 * @returns the validated request, or a 400 (invalid JSON or field) or 422 (unsupported or unknown
 *   field) response
 */
async function parseChatRequest(context: ProxyContext): Promise<Step<ChatRequest>> {
  let body: unknown
  try {
    body = await context.req.json()
  } catch {
    // Not the parser's message: newer engines quote a slice of the body in it.
    chatLogger.warn('Rejected chat request: body is not valid JSON', {
      contentLength: context.req.header('content-length')
    })
    return {
      ok: false,
      response: context.json(invalidRequest('Invalid JSON in request body'), HTTP_BAD_REQUEST)
    }
  }

  const validation = validateChatRequest(body)
  if (validation.ok) {
    return { ok: true, value: validation.data }
  }
  // The field name only: validation messages can echo request values.
  chatLogger.warn('Rejected chat request: invalid field {param} ({status})', {
    param: validation.param ?? 'unknown',
    status: validation.status
  })
  if (validation.status === HTTP_UNPROCESSABLE_ENTITY) {
    return {
      ok: false,
      response: context.json(
        unsupportedParameter(validation.param ?? 'unknown', validation.message),
        HTTP_UNPROCESSABLE_ENTITY
      )
    }
  }
  return {
    ok: false,
    response: context.json(
      invalidRequest(validation.message, validation.param ?? undefined),
      HTTP_BAD_REQUEST
    )
  }
}

/**
 * Downloads the request's remote images and puts them in as data URIs, when `remoteImages` is on.
 *
 * @remarks
 * With the setting off the request is unchanged, and message conversion rejects any remote URL.
 *
 * @param honoContext - the request's Hono context: the error response, and the client's disconnect
 *   signal, which cancels the fetches
 * @param request - the validated chat request
 * @param config - the server config; `remoteImagesEnabled` is read
 * @param remoteImageFetch - the address policy, resolver and limits of each fetch
 * @returns the request with data URIs, or a 400 at the first remote image refused
 */
async function inlineImages(
  honoContext: ProxyContext,
  request: ChatRequest,
  config: ServerConfig,
  remoteImageFetch: RemoteImageFetchOptions
): Promise<Step<ChatRequest>> {
  if (!config.remoteImagesEnabled) return { ok: true, value: request }
  const inlined = await inlineRemoteImages(
    request.messages,
    remoteImageFetch,
    honoContext.get('abortController').signal
  )
  if (inlined.ok) return { ok: true, value: { ...request, messages: inlined.messages } }
  chatLogger.warn('Rejected chat request: remote image refused at {param}', {
    param: inlined.param,
    messageCount: request.messages.length
  })
  return {
    ok: false,
    response: honoContext.json(invalidRequest(inlined.message, inlined.param), HTTP_BAD_REQUEST)
  }
}

/**
 * Converts the OpenAI messages and tools into a pi `Context`.
 *
 * @param honoContext - the request's Hono context, for the error response
 * @param request - the validated chat request
 * @returns the pi context, or a 400 (message conversion failed) or 422 (unsupported tool) response
 */
function buildPiContext(honoContext: ProxyContext, request: ChatRequest): Step<PiContext> {
  const conversion = convertMessages(request.messages)
  if (!conversion.ok) {
    chatLogger.warn('Rejected chat request: message conversion failed at {param}', {
      param: conversion.param,
      messageCount: request.messages.length
    })
    return {
      ok: false,
      response: honoContext.json(
        invalidRequest(conversion.message, conversion.param),
        HTTP_BAD_REQUEST
      )
    }
  }

  const context = conversion.context

  // Convert tools if provided
  if (request.tools !== undefined && request.tools.length > 0) {
    const toolConversion = convertTools(request.tools)
    if (!toolConversion.ok) {
      chatLogger.warn('Rejected chat request: tool conversion failed at {param}', {
        param: toolConversion.param,
        toolCount: request.tools.length
      })
      return {
        ok: false,
        response: honoContext.json(
          unsupportedParameter(toolConversion.param, toolConversion.message),
          HTTP_UNPROCESSABLE_ENTITY
        )
      }
    }
    context.tools = toolConversion.tools
  }

  chatLogger.debug('Built pi context: {messageCount} messages, {toolCount} tools', {
    messageCount: context.messages.length,
    toolCount: context.tools?.length ?? 0,
    hasSystemPrompt: context.systemPrompt !== undefined
  })
  return { ok: true, value: context }
}

/**
 * Checks that the request can authenticate upstream before calling the provider.
 *
 * @remarks
 * With no per-request key, the model's provider must have a credential pi can resolve; otherwise
 * the request is rejected early instead of letting the provider fail later with a less actionable
 * error.
 *
 * @param context - the request's Hono context
 * @param model - the resolved pi model
 * @param upstreamApiKey - the `X-Pi-Upstream-Api-Key` value, or `undefined` when not sent
 * @returns a 401 response when no upstream auth is available, else `undefined`
 */
async function checkRequestAuth(
  context: ProxyContext,
  model: PiModel,
  upstreamApiKey: string | undefined
): Promise<Response | undefined> {
  if (upstreamApiKey !== undefined) {
    chatLogger.debug('Using per-request upstream API key for {provider}', {
      provider: model.provider
    })
    return undefined
  }
  const requestAuth = await getRequestAuth(model)
  if (requestAuth.ok) {
    chatLogger.debug('Resolved upstream auth for {provider} from pi', { provider: model.provider })
    return undefined
  }
  chatLogger.warn('Rejected chat request: no upstream auth for {provider}: {reason}', {
    provider: model.provider,
    model: `${model.provider}/${model.id}`,
    reason: requestAuth.error
  })
  return context.json(
    authenticationError(
      `Could not resolve request auth for provider '${model.provider}'. ${requestAuth.error}. ` +
        "Configure credentials via 'pi /login' or pass X-Pi-Upstream-Api-Key header."
    ),
    HTTP_UNAUTHORIZED
  )
}

/** Everything needed to run an upstream completion for one request. */
interface CompletionJob {
  readonly requestId: string
  readonly canonicalModelId: string
  readonly model: PiModel
  readonly context: PiContext
  readonly request: ChatRequest
  readonly options: CompletionOptions
}

/**
 * Joins the first result of an event iterator and the rest of it into one async iterable.
 *
 * @remarks
 * Ending it early (the client left mid-stream) ends the rest too.
 *
 * @typeParam T - the event type
 * @param first - the result already read from `rest`
 * @param rest - the iterator `first` came from
 * @returns a generator that yields `first`'s value (unless it is done), then the rest
 */
async function* startingWith<T>(
  first: IteratorResult<T>,
  rest: AsyncIterator<T>
): AsyncGenerator<T> {
  try {
    if (first.done === true) return
    yield first.value
    for (let next = await rest.next(); next.done !== true; next = await rest.next()) {
      yield next.value
    }
  } finally {
    await rest.return?.()
  }
}

/**
 * Streams a completion as SSE.
 *
 * @remarks
 * Nothing is sent until pi's first event: every pi adapter emits `start` only once the provider
 * has accepted the request, so a failure before it (an overflow, a rate limit, bad credentials, a
 * provider that never answers) still gets its HTTP status and JSON body, as OpenAI answers a
 * streaming request it refuses. Once the stream has started, a failure can only be an SSE error
 * event with the same body.
 *
 * @param honoContext - the request's Hono context
 * @param job - the resolved model, pi context, request and call options
 * @returns the SSE response, a mapped upstream error response, or an empty response when the
 *   client left before the stream started
 */
async function streamChat(honoContext: ProxyContext, job: CompletionJob): Promise<Response> {
  const { requestId, canonicalModelId, model, context, request, options } = job
  const includeUsage =
    request.stream_options !== null &&
    request.stream_options !== undefined &&
    request.stream_options.include_usage === true
  const start = performance.now()
  // The client's own departure aborts the call, which then fails: not an upstream failure, and
  // nobody is waiting for the answer.
  const answerClientLeft = (): Response => {
    chatLogger.debug('Client left before the stream started, after {durationMs} ms', {
      durationMs: Math.round(performance.now() - start)
    })
    return honoContext.body(null)
  }

  let events: AsyncIterator<AssistantMessageEvent>
  let first: IteratorResult<AssistantMessageEvent>
  try {
    events = (await piStream(model, context, request, options))[Symbol.asyncIterator]()
    first = await events.next()
  } catch (err: unknown) {
    if (options.signal?.aborted === true) return answerClientLeft()
    const mapped = reportThrownFailure(err)
    return honoContext.json(mapped.body, mapped.status)
  }
  if (first.done !== true && first.value.type === 'error') {
    if (options.signal?.aborted === true) return answerClientLeft()
    const failed = first.value.error
    const mapped = reportUpstreamFailure(mapFailedCall(failed), failed.errorMessage)
    chatLogger.debug('Upstream failed before the stream started; answering {status}', {
      status: mapped.status
    })
    return honoContext.json(mapped.body, mapped.status)
  }

  honoContext.header('content-type', 'text/event-stream')
  honoContext.header('cache-control', 'no-cache')
  honoContext.header('connection', 'keep-alive')
  chatLogger.debug('Streaming {model} with includeUsage={includeUsage}', {
    model: canonicalModelId,
    includeUsage
  })

  return honoStream(honoContext, async (stream) => {
    let frameCount = 0
    try {
      for await (const frame of streamToSSE(
        startingWith(first, events),
        requestId,
        canonicalModelId,
        includeUsage
      )) {
        await stream.write(frame)
        frameCount += 1
      }
      chatLogger.debug('Stream finished: {frameCount} frames in {durationMs} ms', {
        frameCount,
        durationMs: Math.round(performance.now() - start),
        aborted: stream.aborted
      })
    } catch (err: unknown) {
      const mapped = reportThrownFailure(err)
      chatLogger.debug('Ending stream with an error event after {frameCount} frames', {
        frameCount,
        durationMs: Math.round(performance.now() - start)
      })
      await stream.write(`data: ${JSON.stringify(mapped.body)}\n\n`)
      await stream.write('data: [DONE]\n\n')
    }
  })
}

/**
 * Runs a non-streaming completion and answers it as an OpenAI chat completion.
 *
 * @param honoContext - the request's Hono context
 * @param job - the resolved model, pi context, request and call options
 * @returns the chat completion, or a mapped upstream error response when the call fails or ends
 *   with `stopReason` `error` or `aborted`
 */
async function completeChat(honoContext: ProxyContext, job: CompletionJob): Promise<Response> {
  const { requestId, canonicalModelId, model, context, request, options } = job
  const start = performance.now()
  try {
    const message = await piComplete(model, context, request, options)
    chatLogger.debug('Completion for {model} finished: {stopReason} in {durationMs} ms', {
      model: canonicalModelId,
      stopReason: message.stopReason,
      durationMs: Math.round(performance.now() - start)
    })

    // Detect upstream errors reported via stopReason
    if (message.stopReason === 'error' || message.stopReason === 'aborted') {
      const mapped = reportUpstreamFailure(mapFailedCall(message), message.errorMessage)
      return honoContext.json(mapped.body, mapped.status)
    }

    return honoContext.json(buildChatCompletion(requestId, canonicalModelId, message))
  } catch (err: unknown) {
    const mapped = reportThrownFailure(err)
    return honoContext.json(mapped.body, mapped.status)
  }
}

/**
 * Handles `POST /v1/chat/completions`: parses, resolves the model, inlines remote images, builds
 * the pi context, checks upstream auth, then streams or completes.
 *
 * @param context - the request's Hono context
 * @param config - the server config; `upstreamTimeoutMs` and `remoteImagesEnabled` are read
 * @param configReader - where the exposure config comes from
 * @param remoteImageFetch - how remote images are fetched, when `remoteImagesEnabled` is on
 * @returns the completion, or the first error response a step produces
 * @throws Error when the exposure config is invalid (from {@link getExposure})
 */
async function handleChatCompletion(
  context: ProxyContext,
  config: ServerConfig,
  configReader: ExposureConfigReader,
  remoteImageFetch: RemoteImageFetchOptions
): Promise<Response> {
  const requestId = context.get('requestId')
  const upstreamApiKey = context.get('upstreamApiKey')

  const parsed = await parseChatRequest(context)
  if (!parsed.ok) return parsed.response
  const request = parsed.value

  // Resolve model through the exposure engine
  const exposure = await getExposure(configReader)
  const resolved = resolveExposedModel(exposure, request.model)
  if (resolved === undefined) {
    chatLogger.warn('Rejected chat request: model {requestedModel} is not exposed', {
      requestedModel: request.model,
      exposedModelCount: exposure.models.length
    })
    return context.json(modelNotFound(request.model), HTTP_NOT_FOUND)
  }

  const model = resolved.model
  const canonicalModelId = resolved.canonicalId

  // The request and response lines carry no model, so this one ties the call to the model that
  // served it. Ids only, never message content or credentials.
  chatLogger.info('Chat request for {requestedModel} resolved to {model}', {
    requestedModel: request.model,
    model: canonicalModelId,
    provider: model.provider,
    stream: request.stream === true
  })

  // Upstream credentials first: a request that cannot reach the provider must not make the proxy
  // fetch anything on its behalf (#109 review).
  const authFailure = await checkRequestAuth(context, model, upstreamApiKey)
  if (authFailure !== undefined) return authFailure

  const prepared = await inlineImages(context, request, config, remoteImageFetch)
  if (!prepared.ok) return prepared.response

  const built = buildPiContext(context, prepared.value)
  if (!built.ok) return built.response

  const job: CompletionJob = {
    requestId,
    canonicalModelId,
    model,
    context: built.value,
    request,
    options: {
      upstreamApiKey,
      // The client's disconnect only. streamChat reads it to tell a client that left from an
      // upstream failure; the upstream timeout gets its own signal in pi/complete.ts.
      signal: context.get('abortController').signal,
      upstreamTimeoutMs: config.upstreamTimeoutMs
    }
  }

  chatLogger.debug('Dispatching {model} as {mode}', {
    model: canonicalModelId,
    mode: request.stream === true ? 'stream' : 'complete',
    upstreamTimeoutMs: config.upstreamTimeoutMs
  })
  return request.stream === true ? streamChat(context, job) : completeChat(context, job)
}

/** OpenAI endpoints the proxy does not implement; each answers 404 with a clear message. */
const unsupportedEndpoints = [
  '/v1/completions',
  '/v1/embeddings',
  '/v1/audio/*',
  '/v1/images/*',
  '/v1/assistants',
  '/v1/assistants/*',
  '/v1/threads',
  '/v1/threads/*',
  '/v1/files',
  '/v1/files/*',
  '/v1/batches',
  '/v1/batches/*',
  '/v1/fine_tuning/*'
]

/**
 * Builds the OpenAI-compatible routes.
 *
 * @param config - the server config, passed to the chat handler
 * @param configReader - where the exposure config comes from; defaults to
 *   {@link fileConfigReader}
 * @param remoteImageFetch - how remote images are fetched when `remoteImagesEnabled` is on;
 *   defaults to {@link STRICT_REMOTE_IMAGE_FETCH}. Only tests pass another, to reach a local server
 * @returns a Hono app to mount at `/`
 */
export function createRoutes(
  config: ServerConfig,
  configReader: ExposureConfigReader = fileConfigReader,
  remoteImageFetch: RemoteImageFetchOptions = STRICT_REMOTE_IMAGE_FETCH
): Hono<ProxyEnv> {
  const routes = new Hono<ProxyEnv>()

  // --- GET /v1/models ---
  routes.get('/v1/models', async (context) => {
    const exposure = await getExposure(configReader)
    chatLogger.debug('Listing {modelCount} models', { modelCount: exposure.models.length })
    return context.json(buildModelList(exposure.models))
  })

  // --- GET /v1/pi/models ---
  // Not OpenAI's: pi's capabilities for each exposed model, which PLAN keeps off /v1/models.
  routes.get('/v1/pi/models', async (context) => {
    const exposure = await getExposure(configReader)
    chatLogger.debug('Listing capabilities of {modelCount} models', {
      modelCount: exposure.models.length
    })
    return context.json(buildPiModelList(exposure.models))
  })

  // --- GET /v1/models/:model ---
  // Use a wildcard to capture slash-containing model IDs
  routes.get('/v1/models/*', async (context) => {
    const rawPath = context.req.path
    // Strip the "/v1/models/" prefix to get the full (possibly multi-segment) model ID
    if (!rawPath.startsWith(MODELS_PREFIX)) {
      chatLogger.debug('Model detail request without a model ID: {path}', { path: rawPath })
      return context.json(modelNotFound(''), HTTP_NOT_FOUND)
    }
    const modelIdEncoded = rawPath.slice(MODELS_PREFIX.length)
    if (modelIdEncoded.length === 0) {
      // `/v1/models/` with a trailing slash: the exact /v1/models route does not match it
      chatLogger.debug('Model detail request without a model ID: {path}', { path: rawPath })
      return context.json(modelNotFound(''), HTTP_NOT_FOUND)
    }
    const modelId = decodeURIComponent(modelIdEncoded)

    const exposure = await getExposure(configReader)
    const resolved = resolveExposedModel(exposure, modelId)
    if (resolved === undefined) {
      chatLogger.debug('Model detail for {modelId}: not exposed', {
        modelId,
        exposedModelCount: exposure.models.length
      })
      return context.json(modelNotFound(modelId), HTTP_NOT_FOUND)
    }

    chatLogger.debug('Model detail for {modelId} resolved to {model}', {
      modelId,
      model: resolved.canonicalId
    })
    return context.json(toOpenAIModel(resolved))
  })

  // --- POST /v1/chat/completions ---
  routes.post(CHAT_PATH, (context) =>
    handleChatCompletion(context, config, configReader, remoteImageFetch)
  )

  // --- Unsupported endpoints: clear errors ---
  for (const path of unsupportedEndpoints) {
    routes.all(path, (context) => {
      httpLogger.warn('Rejected {method} {path}: endpoint not supported', {
        method: context.req.method,
        path: context.req.path
      })
      return context.json(
        invalidRequest(`Endpoint '${context.req.path}' is not supported by this proxy`, undefined),
        HTTP_NOT_FOUND
      )
    })
  }

  return routes
}
