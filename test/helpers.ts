/**
 * Shared test helpers: type guards for the proxy's OpenAI-shaped response bodies, and a proxy app
 * built from a fixed config instead of the user's config file.
 *
 * @packageDocumentation
 */

import type { ServerConfig } from '@proxy/config/env'
import type { RemoteImageFetchOptions } from '@proxy/openai/remote-image-fetch'
import { createApp } from '@proxy/server/app'
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
 * Auth is off and agentic mode is disabled; every other setting is the default from
 * `DEFAULT_CONFIG` (`src/config/schema.ts`).
 *
 * @returns the config
 */
export function testConfig(): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 4141,
    proxyAuth: { kind: 'off' },
    agenticEnabled: false,
    remoteImagesEnabled: false,
    docsUiEnabled: false,
    statsEnabled: false,
    maxBodySize: 52428800,
    upstreamTimeoutMs: 120000,
    publicModelIdMode: 'collision-prefixed',
    modelExposureMode: 'scoped',
    customModels: [],
    providerPrefixes: {},
    aliases: {},
    accounts: {},
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
