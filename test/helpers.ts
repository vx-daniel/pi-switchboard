/**
 * Shared test helpers: type guards for the proxy's OpenAI-shaped response bodies, a proxy app
 * built from a fixed config instead of the user's config file, the chat route's body validation,
 * and model fixtures.
 *
 * @packageDocumentation
 */

import type { Api, Model } from '@earendil-works/pi-ai'
import type { ServerConfig } from '@proxy/config/env'
import type { ExposedModel } from '@proxy/openai/model-exposure'
import type { RemoteImageFetchOptions } from '@proxy/openai/remote-image-fetch'
import type { ChatCompletionRequest } from '@proxy/openai/schemas'
import { createApp } from '@proxy/server/app'
import { chatRequestBodySchema } from '@proxy/server/openapi'
import type { ProxyAuthSwitch } from '@proxy/server/proxy-auth'
import type { ExposureConfigReader } from '@proxy/server/routes'
import { isRecord } from '@proxy/utils/guards'

// ---------------------------------------------------------------------------
// OpenAI response body shapes and their type guards (used across unit and integration tests)
// ---------------------------------------------------------------------------

/** One model object, as `GET /v1/models` lists it and `GET /v1/models/:id` returns it. */
interface OpenAIModelObject {
  readonly id: string
  readonly object: string
  readonly created: number
  readonly owned_by: string
}

/** The body of `GET /v1/models`. */
export interface OpenAIModelListBody {
  readonly object: string
  readonly data: readonly OpenAIModelObject[]
}

/** An OpenAI error body. */
export interface OpenAIErrorBody {
  readonly error: {
    readonly message: string
    readonly type: string
    readonly code: string | null
  }
}

/**
 * Narrows an unknown JSON body to an OpenAI model list shape.
 *
 * @remarks
 * Checks `object: 'list'` and that `data` is an array; the array's items are not checked.
 *
 * @param value - the parsed response body
 * @returns whether `value` is a model list
 */
export function isModelListBody(value: unknown): value is OpenAIModelListBody {
  if (!isRecord(value)) return false
  if (!Array.isArray(value['data'])) return false
  return value['object'] === 'list'
}

/**
 * Narrows an unknown JSON body to an OpenAI error shape.
 *
 * @remarks
 * Checks that `error.message` is a string and `error.code` is a string or `null`; `error.type` is
 * not checked.
 *
 * @param value - the parsed response body
 * @returns whether `value` is an error body
 */
export function isErrorBody(value: unknown): value is OpenAIErrorBody {
  if (!isRecord(value)) return false
  const err = value['error']
  if (!isRecord(err)) return false
  if (typeof err['message'] !== 'string') return false
  // code can be string or null in OpenAI error responses
  const code = err['code']
  return typeof code === 'string' || code === null
}

/**
 * Narrows an unknown JSON body to an OpenAI model object (single model detail).
 *
 * @param value - the parsed response body
 * @returns whether `value` has a string `id` and `object: 'model'`
 */
export function isModelObject(value: unknown): value is OpenAIModelObject {
  if (!isRecord(value)) return false
  return typeof value['id'] === 'string' && value['object'] === 'model'
}

/** An error-like body with at least `error.message`; any other fields of `error` are `unknown`. */
export interface OpenAIErrorLike {
  readonly error: {
    readonly message: string
    readonly [key: string]: unknown
  }
}

/**
 * Narrows an unknown JSON body to an error-like body with at least a string `error.message`.
 *
 * @remarks
 * Looser than {@link isErrorBody}: `error.code` may be missing, so it fits bodies whose `code`
 * is not checked, and gives typed access to extra fields such as `error['param']`.
 *
 * @param value - the parsed response body
 * @returns whether `value` has a string `error.message`
 */
export function isErrorLike(value: unknown): value is OpenAIErrorLike {
  if (!isRecord(value)) return false
  const err = value['error']
  if (!isRecord(err)) return false
  return typeof err['message'] === 'string'
}

/**
 * Parses a response body as JSON for test assertions.
 *
 * @param response - the response to read
 * @returns the parsed body, as `unknown`: narrow it with a type guard
 * @throws SyntaxError when the body is not JSON
 */
export async function jsonBody(response: Response): Promise<unknown> {
  return response.json()
}

/**
 * Builds a test-safe {@link ServerConfig} that does not read the user's config file or
 * environment.
 *
 * @remarks
 * Auth is off; every other setting is the default from
 * `DEFAULT_CONFIG` (`src/config/schema.ts`).
 *
 * @returns the config
 */
export function testConfig(): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 4141,
    proxyAuth: { kind: 'off' },
    hostOriginGuardEnabled: false,
    remoteImagesEnabled: false,
    docsUiEnabled: false,
    responsesApiEnabled: false,
    statsEnabled: false,
    maxBodySize: 52428800,
    upstreamTimeoutMs: 120000,
    publicModelIdMode: 'collision-prefixed',
    modelExposureMode: 'scoped',
    customModels: [],
    providerPrefixes: {},
    aliases: {},
    logLevel: 'info'
  }
}

/**
 * Creates a proxy app that uses one config for both server settings and model exposure. Never
 * reads the user's config file or pi's `enabledModels` setting.
 *
 * @param config - the config to serve with; {@link testConfig} when omitted
 * @param remoteImageFetch - how remote images are fetched when the config enables them; the
 *   strict production policy when omitted
 * @param proxyAuth - the app's proxy auth switch, to change auth after the app is built; one made
 *   from `config.proxyAuth` when omitted
 * @returns the Hono app; drive it with `app.request(…)`
 */
export function testApp(
  config?: ServerConfig,
  remoteImageFetch?: RemoteImageFetchOptions,
  proxyAuth?: ProxyAuthSwitch
): ReturnType<typeof createApp> {
  const serverConfig = config ?? testConfig()
  const reader: ExposureConfigReader = () => ({
    publicModelIdMode: serverConfig.publicModelIdMode,
    modelExposureMode: serverConfig.modelExposureMode,
    enabledModels: undefined,
    customModels: serverConfig.customModels,
    providerPrefixes: serverConfig.providerPrefixes,
    aliases: serverConfig.aliases
  })
  return createApp(serverConfig, reader, remoteImageFetch, proxyAuth)
}

/**
 * Returns `value`, or fails the test when it is missing. Use instead of
 * `if (value === undefined) return`, which passes a test that checked nothing.
 *
 * @typeParam T - the value's type when present
 * @param value - the value to check
 * @param what - what the value is, for the error message
 * @returns `value`, when it is not `undefined`
 * @throws Error when `value` is `undefined`
 */
export function present<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`expected ${what}, got nothing`)
  return value
}

// ---------------------------------------------------------------------------
// The chat route's body validation
// ---------------------------------------------------------------------------

/** How the chat route answered a request body: the status, and its error's `param` and `message`. */
export interface ChatRouteAnswer {
  readonly status: number
  /** The error's `param`; `undefined` when the answer is not an error. */
  readonly param: unknown
  /** The error's `message`; `undefined` when the answer is not an error. */
  readonly message: unknown
}

/**
 * Posts a body to `POST /v1/chat/completions` on a {@link testApp}, which serves no model.
 *
 * @remarks
 * A body the route's validator refuses gets its 400 or 422; one it accepts reaches model
 * resolution and gets a 404 at `model`, as no model is exposed.
 *
 * @param body - the request body, sent as JSON
 * @returns the status, and the error's `param` and `message`
 */
export async function postChatBody(body: unknown): Promise<ChatRouteAnswer> {
  const response = await testApp().request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  const answer = await jsonBody(response)
  const error = isRecord(answer) && isRecord(answer['error']) ? answer['error'] : {}
  return { status: response.status, param: error['param'], message: error['message'] }
}

/**
 * Parses a chat body with the schema the chat route's validator runs (`chatRequestBodySchema`),
 * giving the request the route's handler gets.
 *
 * @param body - the request body
 * @returns the parsed request
 * @throws Error when the schema refuses the body
 */
export function parseChatBody(body: unknown): ChatCompletionRequest {
  const result = chatRequestBodySchema.safeParse(body)
  if (!result.success) throw new Error(`request did not validate: ${result.error.message}`)
  return result.data
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/**
 * Builds a text-only, zero-cost model on the `openai-completions` API.
 *
 * @param provider - the provider name; also forms the base URL host
 * @param id - the model ID, used as its name too
 * @returns the model
 */
export function makeModel(provider: string, id: string): Model<Api> {
  return {
    id,
    name: id,
    api: 'openai-completions',
    provider,
    baseUrl: `https://${provider}.example.com`,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096
  }
}

/**
 * Builds an exposed {@link makeModel} model, listed by its bare ID and served by its provider's
 * base login.
 *
 * @param provider - the provider
 * @param id - the model ID
 * @returns the exposed model
 */
export function exposed(provider: string, id: string): ExposedModel {
  return {
    publicId: id,
    canonicalId: `${provider}/${id}`,
    model: makeModel(provider, id),
    provider,
    login: provider
  }
}

// ---------------------------------------------------------------------------
// Chat answers
// ---------------------------------------------------------------------------

/**
 * Parses a chat answer's `x_pi`: the body's, or each stream chunk's.
 *
 * @param text - the response body
 * @param stream - whether it is a stream
 * @returns every `x_pi` found, in order; `undefined` entries where a chunk or body had none
 */
export function xPi(text: string, stream: boolean): unknown[] {
  if (!stream) {
    const body: unknown = JSON.parse(text)
    return [isRecord(body) ? body['x_pi'] : undefined]
  }
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line) => {
      const chunk: unknown = JSON.parse(line.slice('data: '.length))
      return isRecord(chunk) ? chunk['x_pi'] : undefined
    })
}
