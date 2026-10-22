/**
 * Hono route handlers for the OpenAI-compatible proxy endpoints.
 *
 * @remarks
 * Endpoints:
 * - `GET  /v1/models`
 * - `GET  /v1/models/{model}` (URL-encoded IDs with slashes work)
 * - `GET  /v1/switchboard/models` (not OpenAI's: pi's capabilities for each exposed model)
 * - `POST /v1/chat/completions`
 * - a fixed list of OpenAI endpoints the proxy does not implement, answered with 404
 *
 * All of them sit behind proxy auth, applied to `/v1/*` in `createApp`. Each documented one
 * carries its OpenAPI description (`@proxy/server/openapi`).
 *
 * @packageDocumentation
 */

import type { ServerConfig } from '@proxy/config/env'
import { loadConfigFromFile } from '@proxy/config/schema'
import { proxyLogger } from '@proxy/logging'
import { type ConversionSuccess, convertMessages } from '@proxy/openai/messages'
import {
  computeModelExposure,
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
import type { ChatCompletionRequest } from '@proxy/openai/schemas'
import { convertTools } from '@proxy/openai/tools'
import { chatRequestRejection, logValidatedChatRequest } from '@proxy/openai/validate'
import { getAvailableModels, getEnabledModels } from '@proxy/pi/registry'
import { dispatchChat, findCredentialedStart, planRoute } from '@proxy/server/chat-dispatch'
import { invalidRequest, modelNotFound, unsupportedParameter } from '@proxy/server/errors'
import {
  HTTP_BAD_REQUEST,
  HTTP_NOT_FOUND,
  HTTP_UNPROCESSABLE_ENTITY
} from '@proxy/server/http-status'
import { jsonBodyMiddleware } from '@proxy/server/middleware'
import {
  chatHeadersSchema,
  chatRequestBodySchema,
  createChatCompletionDescription,
  listModelCapabilitiesDescription,
  listModelsDescription,
  modelPathSchema,
  retrieveModelDescription,
  SWITCHBOARD_PREFIX,
  UNSUPPORTED_ENDPOINTS
} from '@proxy/server/openapi'
import type { Reserve } from '@proxy/server/route-reserve'
import type { ProxyEnv } from '@proxy/server/types'
import { type Context, Hono } from 'hono'
import { describeRoute, validator } from 'hono-openapi'

/**
 * What a request reads from the config: the model exposure config, and the quota reserve per
 * provider that fallback chains keep (`routing.reserve`, #69; none when left out).
 */
export interface RequestConfig extends ModelExposureConfig {
  readonly reserve?: Reserve | undefined
}

/**
 * Reads the config a request needs.
 *
 * @remarks
 * In production ({@link fileConfigReader}) this re-reads the config file and pi's settings on each
 * request (small JSON files, negligible next to upstream latency). Tests pass a reader that returns
 * fixed values.
 */
export type ExposureConfigReader = () => RequestConfig | Promise<RequestConfig>

/** Logger for chat and model requests. */
const chatLogger = proxyLogger('server', 'chat')
/** Logger for rejected endpoints. */
const httpLogger = proxyLogger('server', 'http')

/**
 * Reads the request config from the proxy's config file and pi's `enabledModels` setting.
 *
 * @returns the config; `enabledModels` is `undefined` when pi's settings set none
 */
export async function fileConfigReader(): Promise<RequestConfig> {
  const file = loadConfigFromFile()
  const enabledModels = await getEnabledModels()
  chatLogger.debug('Read exposure config: {modelExposureMode}, {publicModelIdMode}', {
    modelExposureMode: file.modelExposureMode,
    publicModelIdMode: file.publicModelIdMode,
    enabledModelCount: enabledModels?.length,
    customModelCount: file.customModels.length,
    providerPrefixCount: Object.keys(file.providerPrefixes).length,
    aliasCount: Object.keys(file.aliases).length
  })
  return {
    publicModelIdMode: file.publicModelIdMode,
    modelExposureMode: file.modelExposureMode,
    enabledModels,
    customModels: file.customModels,
    providerPrefixes: file.providerPrefixes,
    aliases: file.aliases,
    reserve: file.routing.reserve
  }
}

/** The chat completions path. */
const CHAT_PATH = '/v1/chat/completions'

/** The Hono context a route handler gets. */
type ProxyContext = Context<ProxyEnv>
/** A validated chat completion request body. */
type ChatRequest = ChatCompletionRequest
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
 * @param config - the exposure config
 * @returns the exposed models and their scope diagnostics
 * @throws Error when the exposure config is invalid; Hono answers it with 500
 */
function exposureFrom(config: ModelExposureConfig): ModelExposureResult {
  const available = getAvailableModels()
  const outcome = computeModelExposure(available, config)
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
 * Computes which models are exposed, reading the exposure config.
 *
 * @param configReader - where the exposure config comes from
 * @returns the exposed models and their scope diagnostics
 * @throws Error when the exposure config is invalid; Hono answers it with 500
 */
async function getExposure(configReader: ExposureConfigReader): Promise<ModelExposureResult> {
  return exposureFrom(await configReader())
}

/**
 * Answers a chat request body that failed validation, as the chat route's `validator('json')`
 * hook: a named 422 for an unsupported or unknown field, a 400 for any other invalid value.
 *
 * @remarks
 * A body that is not JSON never gets here: the validator throws for it, and `app.onError`
 * answers 400.
 *
 * @param context - the request's Hono context
 * @param body - the parsed JSON body that failed the schema
 * @returns the error response
 */
function rejectChatRequest(context: Context, body: unknown): Response {
  const rejection = chatRequestRejection(body)
  // The field name only: validation messages can echo request values.
  chatLogger.warn('Rejected chat request: invalid field {param} ({status})', {
    param: rejection.param ?? 'unknown',
    status: rejection.status
  })
  if (rejection.status === HTTP_UNPROCESSABLE_ENTITY) {
    return context.json(
      unsupportedParameter(rejection.param ?? 'unknown', rejection.message),
      HTTP_UNPROCESSABLE_ENTITY
    )
  }
  return context.json(
    invalidRequest(rejection.message, rejection.param ?? undefined),
    HTTP_BAD_REQUEST
  )
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

/** What the chat handler needs from the app beyond the request: set once when routes are built. */
interface ChatRouteSettings {
  /** The server config; `upstreamTimeoutMs` and `remoteImagesEnabled` are read. */
  readonly config: ServerConfig
  /** Where the exposure config comes from. */
  readonly configReader: ExposureConfigReader
  /** How remote images are fetched, when `remoteImagesEnabled` is on. */
  readonly remoteImageFetch: RemoteImageFetchOptions
}

/**
 * Handles `POST /v1/chat/completions` for a validated request: resolves the model or alias, checks
 * upstream auth, inlines remote images, builds the pi context, then runs it on the model or the
 * alias's fallback chain (`chat-dispatch.ts`, #67).
 *
 * @param context - the request's Hono context
 * @param request - the request body, as the route's `validator('json')` parsed it
 * @param settings - the server config, exposure config reader and remote image policy
 * @returns the completion, or the first error response a step produces
 * @throws Error when the exposure config is invalid (from {@link getExposure})
 */
async function handleChatCompletion(
  context: ProxyContext,
  request: ChatRequest,
  settings: ChatRouteSettings
): Promise<Response> {
  const { config, configReader, remoteImageFetch } = settings
  const requestId = context.get('requestId')
  const upstreamApiKey = context.get('upstreamApiKey')
  logValidatedChatRequest(request)

  // Resolve model through the exposure engine. The config is read once: the reserve comes with it.
  const requestConfig = await configReader()
  const exposure = exposureFrom(requestConfig)
  const resolved = resolveExposedModel(exposure, request.model)
  if (resolved === undefined) {
    chatLogger.warn('Rejected chat request: model {requestedModel} is not exposed', {
      requestedModel: request.model,
      exposedModelCount: exposure.models.length
    })
    return context.json(modelNotFound(request.model), HTTP_NOT_FOUND)
  }

  const route = planRoute(resolved, request, upstreamApiKey)
  const [first = resolved] = route.candidates

  // The request and response lines carry no model, so this one ties the call to the model that
  // serves it first, and to the alias it was asked for by. Ids only, never message content or
  // credentials.
  chatLogger.info('Chat request for {requestedModel} resolved to {model}', {
    requestedModel: request.model,
    model: first.canonicalId,
    provider: first.provider,
    stream: request.stream === true,
    ...(resolved.alias === undefined ? {} : { alias: resolved.alias }),
    ...(route.candidates.length > 1
      ? { fallbackModels: route.candidates.slice(1).map((candidate) => candidate.canonicalId) }
      : {})
  })

  // Upstream credentials first: a request that cannot reach any provider must not make the proxy
  // fetch anything on its behalf (#109 review).
  const start = await findCredentialedStart(route, upstreamApiKey, resolved.alias)
  if (start.kind === 'refused') return context.json(start.answer.body, start.answer.status)

  const prepared = await inlineImages(context, request, config, remoteImageFetch)
  if (!prepared.ok) return prepared.response

  const built = buildPiContext(context, prepared.value)
  if (!built.ok) return built.response

  return dispatchChat(context, {
    requestId,
    alias: resolved.alias,
    candidates: start.candidates,
    fallbackOn: route.fallbackOn,
    reserve: requestConfig.reserve ?? {},
    attempts: start.attempts,
    context: built.value,
    request,
    options: {
      upstreamApiKey,
      // The client's disconnect only. The dispatch reads it to tell a client that left from an
      // upstream failure; the upstream timeout gets its own signal in pi/complete.ts.
      signal: context.get('abortController').signal,
      upstreamTimeoutMs: config.upstreamTimeoutMs
    }
  })
}

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
  routes.get('/v1/models', describeRoute(listModelsDescription), async (context) => {
    const exposure = await getExposure(configReader)
    chatLogger.debug('Listing {modelCount} models and {aliasCount} aliases', {
      modelCount: exposure.models.length,
      aliasCount: exposure.aliases.length
    })
    return context.json(buildModelList([...exposure.models, ...exposure.aliases]))
  })

  // --- GET /v1/switchboard/models ---
  // Not OpenAI's: pi's capabilities for each exposed model, which PLAN keeps off /v1/models.
  routes.get(
    `${SWITCHBOARD_PREFIX}/models`,
    describeRoute(listModelCapabilitiesDescription),
    async (context) => {
      const exposure = await getExposure(configReader)
      chatLogger.debug('Listing capabilities of {modelCount} models and {aliasCount} aliases', {
        modelCount: exposure.models.length,
        aliasCount: exposure.aliases.length
      })
      return context.json(buildPiModelList([...exposure.models, ...exposure.aliases]))
    }
  )

  // --- GET /v1/models/:model ---
  // `{.+}` lets the ID span slashes (`/v1/models/org/model` as well as `org%2Fmodel`); Hono
  // decodes it once, and a malformed escape is left as is rather than thrown.
  routes.get('/v1/models/', (context) => {
    // A trailing slash and no ID: the exact /v1/models route does not match it.
    chatLogger.debug('Model detail request without a model ID: {path}', { path: context.req.path })
    return context.json(modelNotFound(''), HTTP_NOT_FOUND)
  })
  routes.get(
    '/v1/models/:model{.+}',
    describeRoute(retrieveModelDescription),
    validator('param', modelPathSchema),
    async (context) => {
      const modelId = context.req.valid('param').model

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
    }
  )

  // --- POST /v1/chat/completions ---
  routes.post(
    CHAT_PATH,
    describeRoute(createChatCompletionDescription),
    validator('header', chatHeadersSchema),
    jsonBodyMiddleware(),
    validator('json', chatRequestBodySchema, (result, context) =>
      result.success ? undefined : rejectChatRequest(context, result.data)
    ),
    (context) =>
      handleChatCompletion(context, context.req.valid('json'), {
        config,
        configReader,
        remoteImageFetch
      })
  )

  // --- Unsupported endpoints: clear errors (documented by hand in `@proxy/server/openapi`) ---
  for (const path of UNSUPPORTED_ENDPOINTS) {
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
