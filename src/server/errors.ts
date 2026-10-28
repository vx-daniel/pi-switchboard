/**
 * OpenAI-compatible error bodies, and the mapping from an upstream failure to the status and body
 * the client gets.
 *
 * @remarks
 * Every error body has OpenAI's shape: `{ error: { message, type, param, code } }`.
 *
 * Statuses the proxy answers with:
 * - 400: invalid JSON or request field, failed message conversion, context overflow, a request
 *   the provider refused as invalid (its 400 or 422)
 * - 401: proxy auth failure, the provider refused the client's own key
 *   (`X-Switchboard-Upstream-Api-Key`, `upstream_api_key_invalid`)
 * - 404: model not found, unsupported endpoint, any other route (`Invalid URL (<method> <path>)`)
 * - 413: request body over the size limit
 * - 422: unsupported or unknown request field, unsupported tool
 * - 429: upstream rate limit (`rate_limit`, with `retry-after` when the provider said when), or a
 *   plan's usage limit (OpenAI's `insufficient_quota`, with `x-should-retry: false`; #199)
 * - 500: anything thrown inside the proxy, an invalid model exposure config included
 *   (`internalError`, answered by `app.onError`)
 * - 502: upstream refused pi's stored credential (401, 403), pi has no credential for the model's
 *   provider (`upstream_credentials_missing`), any other upstream error
 * - 503: upstream unavailable (503), overloaded (529) or out of capacity, failed health check
 * - 504: upstream timeout (408, 504, idle timeout)
 *
 * @packageDocumentation
 */

import { type AssistantMessage, isContextOverflow } from '@earendil-works/pi-ai'
import { splitUpstreamError } from '@proxy/pi/upstream-error'
import {
  HTTP_BAD_GATEWAY,
  HTTP_BAD_REQUEST,
  HTTP_FORBIDDEN,
  HTTP_GATEWAY_TIMEOUT,
  HTTP_NOT_FOUND,
  HTTP_OVERLOADED,
  HTTP_PAYLOAD_TOO_LARGE,
  HTTP_REQUEST_TIMEOUT,
  HTTP_SERVICE_UNAVAILABLE,
  HTTP_TOO_MANY_REQUESTS,
  HTTP_UNAUTHORIZED,
  HTTP_UNPROCESSABLE_ENTITY
} from '@proxy/server/http-status'
import { parseJsonOrUndefined } from '@proxy/utils/guards'
import { MS_PER_SECOND } from '@proxy/utils/time'
import * as z from 'zod'

/** OpenAI's error response body. Documents the response; never parsed. */
export const openAIErrorSchema = z
  .object({
    error: z.object({
      message: z.string().trim().meta({ description: 'Fixed text; never quotes the provider.' }),
      type: z.string().trim().meta({ description: 'Such as `invalid_request_error`.' }),
      param: z.string().trim().nullable().meta({ description: 'The request field at fault.' }),
      code: z.string().trim().nullable().meta({ description: 'Such as `model_not_found`.' })
    })
  })
  .meta({ id: 'ErrorResponse', description: "OpenAI's error shape." })

/** OpenAI's error response body. */
export type OpenAIError = z.infer<typeof openAIErrorSchema>

/**
 * Builds an OpenAI error body.
 *
 * @param message - the human-readable message
 * @param type - OpenAI's error type, such as `invalid_request_error`
 * @param param - the request field at fault, or `null`
 * @param code - OpenAI's machine-readable code, or `null`
 * @returns the error body
 */
function makeError(
  message: string,
  type: string,
  param: string | null,
  code: string | null
): OpenAIError {
  return {
    error: { message, type, param, code }
  }
}

/**
 * Builds an `invalid_request_error` body with no code.
 *
 * @param message - the message the client sees
 * @param param - the request field at fault; `undefined` gives `param: null`
 * @returns the error body
 */
export function invalidRequest(message: string, param?: string): OpenAIError {
  return makeError(message, 'invalid_request_error', param ?? null, null)
}

/**
 * Builds OpenAI's `model_not_found` body for the `model` field.
 *
 * @param modelId - the model ID the client asked for, quoted in the message
 * @returns the error body
 */
export function modelNotFound(modelId: string): OpenAIError {
  return makeError(
    `The model '${modelId}' does not exist`,
    'invalid_request_error',
    'model',
    'model_not_found'
  )
}

/**
 * Builds the `login_not_found` body for the `provider` field: no login by that ID serves an
 * exposed model or is cooling down (#182).
 *
 * @param login - the login's provider ID the client named, quoted in the message
 * @returns the error body
 */
export function loginNotFound(login: string): OpenAIError {
  return makeError(
    `No login '${login}' serves an exposed model or is cooling down`,
    'invalid_request_error',
    'provider',
    'login_not_found'
  )
}

/**
 * Builds an `unsupported_parameter` body.
 *
 * @param param - the unsupported request field
 * @param message - the message the client sees; `undefined` gives
 *   `Unsupported parameter: '<param>'`
 * @returns the error body
 */
export function unsupportedParameter(param: string, message?: string): OpenAIError {
  return makeError(
    message ?? `Unsupported parameter: '${param}'`,
    'invalid_request_error',
    param,
    'unsupported_parameter'
  )
}

/**
 * Builds an `authentication_error` body.
 *
 * @param message - the message the client sees
 * @returns the error body
 */
export function authenticationError(message: string): OpenAIError {
  return makeError(message, 'authentication_error', null, null)
}

/**
 * Builds the `invalid_host` body: the host/origin guard refused a `Host` a DNS-rebinding page
 * would send (#188).
 *
 * @returns the `permission_error` body with code `invalid_host`
 */
export function invalidHost(): OpenAIError {
  return makeError(
    'The proxy refuses this Host: use an IP address, localhost, or a name with no dot (behind a reverse proxy, turn hostOriginGuard off and set a proxy token)',
    'permission_error',
    null,
    'invalid_host'
  )
}

/**
 * Builds the `invalid_origin` body: the host/origin guard refused a request from a web page on
 * another origin (#188).
 *
 * @returns the `permission_error` body with code `invalid_origin`
 */
export function invalidOrigin(): OpenAIError {
  return makeError(
    'The proxy refuses requests from web pages on other origins (behind a reverse proxy, turn hostOriginGuard off and set a proxy token)',
    'permission_error',
    null,
    'invalid_origin'
  )
}

/**
 * Builds the body for a failure inside the proxy itself: fixed text, never the thrown message,
 * which can quote a path or a config value.
 *
 * @returns the `server_error` body with code `internal_error`
 */
export function internalError(): OpenAIError {
  return makeError(
    'Internal proxy error; see the proxy log',
    'server_error',
    null,
    'internal_error'
  )
}

/**
 * Builds the body for usage that can't be read: stats are off, or the stats file won't open or
 * read.
 *
 * @param message - why, without a path or the underlying error's text
 * @returns the `server_error` body with code `stats_unavailable`
 */
export function statsUnavailable(message: string): OpenAIError {
  return makeError(message, 'server_error', null, 'stats_unavailable')
}

/**
 * Builds a `server_error` body for an upstream failure.
 *
 * @param message - the fixed message the client sees; never the upstream message
 * @param code - OpenAI-style code; `undefined` gives `upstream_error`
 * @returns the error body
 */
function upstreamError(message: string, code?: string): OpenAIError {
  return makeError(message, 'server_error', null, code ?? 'upstream_error')
}

/** The statuses an upstream failure is answered with. */
export type UpstreamErrorStatus = 400 | 401 | 404 | 429 | 502 | 503 | 504

/** An upstream failure as the client sees it: a status and a fixed body that quotes nothing. */
export interface MappedUpstreamError {
  readonly status: UpstreamErrorStatus
  readonly body: OpenAIError
}

/** Upstream rate limit: 429 `rate_limit`. */
const RATE_LIMITED: MappedUpstreamError = {
  status: HTTP_TOO_MANY_REQUESTS,
  body: upstreamError('Upstream rate limit exceeded', 'rate_limit')
}
/**
 * A plan's usage limit (#199): 429 with OpenAI's `insufficient_quota` type and code, which tells a
 * client that retrying before the reset won't help (Codex CLI stops on it). Still the `rate_limit`
 * class for routing: fallback and cooldowns go by the status.
 */
const USAGE_LIMITED: MappedUpstreamError = {
  status: HTTP_TOO_MANY_REQUESTS,
  body: makeError(
    "The provider's usage limit for this login is reached; retrying before it resets won't help",
    'insufficient_quota',
    null,
    'insufficient_quota'
  )
}
/** Upstream timeout: 504 `timeout`. */
const TIMED_OUT: MappedUpstreamError = {
  status: HTTP_GATEWAY_TIMEOUT,
  body: upstreamError('Upstream request timed out', 'timeout')
}
/** Upstream refused pi's stored credential: 502 `upstream_auth_error`. */
const AUTH_FAILED: MappedUpstreamError = {
  status: HTTP_BAD_GATEWAY,
  body: upstreamError('Upstream authentication failed', 'upstream_auth_error')
}
/**
 * Upstream refused the key the client sent in `X-Switchboard-Upstream-Api-Key` (#128): the
 * client's own credential, so a 401 tells it to fix it. Fixed text: the provider's message can
 * quote the key.
 */
const CLIENT_KEY_REJECTED: MappedUpstreamError = {
  status: HTTP_UNAUTHORIZED,
  body: makeError(
    'The provider rejected the API key in X-Switchboard-Upstream-Api-Key.',
    'authentication_error',
    null,
    'upstream_api_key_invalid'
  )
}
/**
 * pi has no usable credential for the model's provider (#128): the proxy's own setup is missing,
 * which the client cannot fix, so it is a 502 like a refused stored credential, not the 401 a bad
 * proxy token gets. Fixed text: pi's reason can quote a key command or an install path.
 */
export const CREDENTIALS_MISSING: MappedUpstreamError = {
  status: HTTP_BAD_GATEWAY,
  body: upstreamError(
    "pi has no usable credential for the model's provider. Log in with pi on the proxy's host.",
    'upstream_credentials_missing'
  )
}
/** Upstream unavailable: 503 `provider_unavailable`. */
const UNAVAILABLE: MappedUpstreamError = {
  status: HTTP_SERVICE_UNAVAILABLE,
  body: upstreamError('Upstream provider is unavailable', 'provider_unavailable')
}
/** Upstream overloaded: 503 `provider_overloaded`. */
const OVERLOADED: MappedUpstreamError = {
  status: HTTP_SERVICE_UNAVAILABLE,
  body: upstreamError('Upstream provider is overloaded', 'provider_overloaded')
}
/** Any other upstream failure: 502 `upstream_error`. */
const PROVIDER_FAILED: MappedUpstreamError = {
  status: HTTP_BAD_GATEWAY,
  body: upstreamError('Upstream provider error')
}
/**
 * OpenAI's answer to a request longer than the model's context window, which agent clients watch
 * for to compact the history and retry (#40). Fixed text: the provider's message quotes token
 * counts and sometimes the request.
 */
const CONTEXT_OVERFLOW: MappedUpstreamError = {
  status: HTTP_BAD_REQUEST,
  body: makeError(
    "The messages exceed the model's context window. Shorten or summarize them and try again.",
    'invalid_request_error',
    'messages',
    'context_length_exceeded'
  )
}

/**
 * The provider refused the request as invalid (its 400 or 422, not a context overflow): the
 * client's own field caused it, so retrying cannot help (#147). OpenAI's error shape with fixed
 * text: the provider's message can quote the request.
 */
const REJECTED_AS_INVALID: MappedUpstreamError = {
  status: HTTP_BAD_REQUEST,
  body: makeError(
    'The provider rejected the request as invalid. Check the fields this model accepts.',
    'invalid_request_error',
    null,
    'upstream_invalid_request'
  )
}

/**
 * The provider refused the model for the login the proxy uses (#156): Codex lists models a
 * ChatGPT plan cannot run, and pi exposes them. OpenAI answers a model the account cannot use with
 * `404 model_not_found`, and agent clients pick another model on it; a 502 would read as an outage
 * and be retried. Fixed text: the request has one model, so `param` names it.
 */
const MODEL_UNAVAILABLE: MappedUpstreamError = {
  status: HTTP_NOT_FOUND,
  body: makeError(
    'The model is not available with the provider login the proxy uses. Choose another model.',
    'invalid_request_error',
    'model',
    'model_not_found'
  )
}

/** The first error status: error statuses span 400–599. */
const FIRST_ERROR_STATUS = 400
/** The first status past the error range. */
const PAST_LAST_ERROR_STATUS = 600

/** Google's error body, as its SDK puts it in a message: `{"error":{"code":429,…}}`, an error code. */
const GoogleErrorBodySchema = z.object({
  error: z.object({ code: z.number().min(FIRST_ERROR_STATUS).lt(PAST_LAST_ERROR_STATUS) })
})

/** Upstream HTTP statuses with their own answer; any other 4xx or 5xx is PROVIDER_FAILED. */
const BY_STATUS: ReadonlyMap<number, MappedUpstreamError> = new Map([
  [HTTP_BAD_REQUEST, REJECTED_AS_INVALID],
  [HTTP_UNAUTHORIZED, AUTH_FAILED],
  [HTTP_FORBIDDEN, AUTH_FAILED],
  [HTTP_REQUEST_TIMEOUT, TIMED_OUT],
  [HTTP_UNPROCESSABLE_ENTITY, REJECTED_AS_INVALID],
  [HTTP_TOO_MANY_REQUESTS, RATE_LIMITED],
  [HTTP_SERVICE_UNAVAILABLE, UNAVAILABLE],
  [HTTP_GATEWAY_TIMEOUT, TIMED_OUT],
  [HTTP_OVERLOADED, OVERLOADED]
])

/**
 * Reads the status as Google's SDK reports it: the error body itself, `{"error":{"code":429,…}}`.
 *
 * @param message - the upstream error message
 * @returns the 4xx or 5xx `error.code` when the message is such a JSON body, else `undefined`
 */
function googleBodyStatus(message: string): number | undefined {
  if (!message.startsWith('{')) return undefined
  const parsed = GoogleErrorBodySchema.safeParse(parseJsonOrUndefined(message))
  return parsed.success ? parsed.data.error.code : undefined
}

/**
 * Reads the provider's HTTP status from an upstream error message.
 *
 * @remarks
 * Only the positions pi's messages put it in count (the prefixes `splitUpstreamError` knows, then
 * Google's JSON body), never a number elsewhere in the text (a token count, an ID, a quoted
 * request).
 *
 * @param message - the upstream error message
 * @returns the status, or `undefined` when the message reports none
 */
function upstreamStatusIn(message: string): number | undefined {
  return splitUpstreamError(message).status ?? googleBodyStatus(message)
}

/**
 * A plan's usage limit in a provider's words: Codex's "You have hit your ChatGPT usage limit" and
 * `usage_limit_reached` (#185). No leading word boundary, so it also matches
 * `subscription_sharing_usage_limit_exceeded`; it ends where a letter would follow, so "usage
 * limitations" is not one.
 */
const USAGE_LIMIT_WORDING = /usage[\s_-]?limits?(?![a-z])/i

/**
 * Wording that identifies a failure when the message carries no status: Bedrock, network
 * failures, the proxy's own upstream idle timeout, pi's Codex adapter, which throws a usage limit
 * as "You have hit your ChatGPT usage limit" with no status (#185), and capacity messages.
 * Checked in this order.
 *
 * @remarks
 * The capacity wordings are the ones pi's own retry classifier treats as transient
 * (`pi-ai/utils/retry`).
 */
const BY_WORDING: readonly (readonly [RegExp, MappedUpstreamError])[] = [
  [USAGE_LIMIT_WORDING, USAGE_LIMITED],
  [/\brate[\s_-]?limit|\btoo many requests\b|\bresource[\s_-]?exhausted\b/i, RATE_LIMITED],
  [/\btime[ds]?[\s_-]?out\b|\bETIMEDOUT\b/i, TIMED_OUT],
  [/\bunauthori[sz]ed\b/i, AUTH_FAILED],
  [
    /\boverloaded\b|\bmodel is at capacity\b|\bserver[\s_-]?busy\b|\bservers are currently busy\b|\bexperiencing high demand\b/i,
    OVERLOADED
  ],
  [/\bservice[\s_-]?unavailable\b/i, UNAVAILABLE]
]

/**
 * Wording that marks a provider's 400 as a credential problem, not the client's request: Google
 * answers a bad API key with `400 INVALID_ARGUMENT` "API key not valid" (#154 review). The
 * client cannot fix it, so it stays {@link AUTH_FAILED}, a server-side error, not the 400 that
 * tells the client to check its fields.
 */
const CREDENTIAL_WORDING =
  /\bapi[\s_-]?key\b|\bunauthori[sz]ed\b|\bauthenticat\w*|\bcredentials?\b|\baccess[\s_-]?token\b/i

/**
 * Codex's refusal of a model the ChatGPT login's plan does not include (#156), as pi reports it:
 * "Codex error: The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account."
 * It arrives as a WebSocket stream event, with no status, or as a 400.
 */
const MODEL_REFUSED_WORDING = /\bmodel is not supported when using codex with\b/i

/**
 * Maps an upstream failure to the status and fixed body the client gets.
 *
 * @remarks
 * The provider's HTTP status decides when pi's message reports one; its wording is consulted only
 * when it does not. The body never quotes the upstream message, which can carry the request, a key
 * or an account.
 *
 * @param err - the thrown value; only an `Error`'s message is read
 * @returns the mapped failure; {@link PROVIDER_FAILED} when nothing identifies it
 */
export function mapUpstreamError(err: unknown): MappedUpstreamError {
  const message = err instanceof Error ? err.message : ''
  const status = upstreamStatusIn(message)
  // Codex's model refusal first: its phrase is specific, the credential words are not, so a
  // refusal that also mentions an account's credentials is still about the model.
  const statusAllowsRefusal = status === undefined || status === HTTP_BAD_REQUEST
  if (statusAllowsRefusal && MODEL_REFUSED_WORDING.test(message)) return MODEL_UNAVAILABLE
  if (status === HTTP_BAD_REQUEST && CREDENTIAL_WORDING.test(message)) return AUTH_FAILED
  if (status === HTTP_TOO_MANY_REQUESTS && USAGE_LIMIT_WORDING.test(message)) return USAGE_LIMITED
  if (status !== undefined) {
    return BY_STATUS.get(status) ?? PROVIDER_FAILED
  }
  for (const [wording, mapped] of BY_WORDING) {
    if (wording.test(message)) return mapped
  }
  return PROVIDER_FAILED
}

/** The statuses a provider reports a context overflow with: 400, and 413 for a too-large body. */
const OVERFLOW_STATUSES: ReadonlySet<number> = new Set([HTTP_BAD_REQUEST, HTTP_PAYLOAD_TOO_LARGE])

/**
 * Maps a failed pi call to the status and fixed body the client gets.
 *
 * @remarks
 * A context overflow, as pi recognizes it across providers (`isContextOverflow`), is OpenAI's 400
 * `context_length_exceeded`; anything else maps as {@link mapUpstreamError} does. A reported
 * status other than 400 or 413 rules overflow out: a 429 that says "too many tokens" is a rate
 * limit.
 *
 * @param message - the call's final assistant message, with `stopReason` `error` or `aborted`
 * @returns the mapped failure
 */
export function mapFailedCall(message: AssistantMessage): MappedUpstreamError {
  const errorText = message.errorMessage ?? ''
  const status = upstreamStatusIn(errorText)
  const statusAllowsOverflow = status === undefined || OVERFLOW_STATUSES.has(status)
  if (statusAllowsOverflow && isContextOverflow(message)) {
    return CONTEXT_OVERFLOW
  }
  return mapUpstreamError(new Error(errorText))
}

/**
 * Answers a failure for a request that sent its own key in `X-Switchboard-Upstream-Api-Key`.
 *
 * @remarks
 * A refused credential is then the client's key, so it gets 401 `upstream_api_key_invalid`
 * instead of the 502 pi's stored credential gets (#128). Any other failure is unchanged.
 *
 * @param mapped - the failure as {@link mapUpstreamError} or {@link mapFailedCall} mapped it
 * @returns the 401 for a refused credential, else `mapped`
 */
export function forClientKey(mapped: MappedUpstreamError): MappedUpstreamError {
  return mapped.body.error.code === AUTH_FAILED.body.error.code ? CLIENT_KEY_REJECTED : mapped
}

/**
 * A wait at least this long makes a 429 a usage limit (#199): past what a client's own retries
 * span (the OpenAI SDKs wait seconds), so retrying before then only fails again.
 */
export const USAGE_LIMIT_MIN_WAIT_MS = 300_000

/** A 429 as the client gets it: the body and status, and the headers that say when to retry. */
export interface LimitAnswer {
  readonly answer: MappedUpstreamError
  readonly headers: Readonly<Record<string, string>>
}

/**
 * Shapes a failure the client gets with how long the provider said to wait (#199).
 *
 * @remarks
 * Only a 429 changes. A usage limit (its wording, or a wait of at least
 * {@link USAGE_LIMIT_MIN_WAIT_MS}) is {@link USAGE_LIMITED} with `x-should-retry: false`, which the
 * OpenAI SDKs obey, and no `retry-after`: a client that honors a wait of days would sit idle
 * instead of failing. A rate limit with a known wait gets `retry-after` (seconds) and
 * `retry-after-ms`, as OpenAI sends them, so the client waits that long rather than its own
 * backoff.
 *
 * @param mapped - the failure as mapped
 * @param waitMs - how long the provider said to wait, or `undefined` when it said nothing readable
 * @returns the answer and its headers
 */
export function limitAnswer(mapped: MappedUpstreamError, waitMs: number | undefined): LimitAnswer {
  if (mapped.status !== HTTP_TOO_MANY_REQUESTS) return { answer: mapped, headers: {} }
  const usageLimit =
    mapped.body.error.code === USAGE_LIMITED.body.error.code ||
    (waitMs !== undefined && waitMs >= USAGE_LIMIT_MIN_WAIT_MS)
  if (usageLimit) return { answer: USAGE_LIMITED, headers: { 'x-should-retry': 'false' } }
  if (waitMs === undefined) return { answer: mapped, headers: {} }
  return {
    answer: mapped,
    headers: {
      'retry-after': String(Math.ceil(waitMs / MS_PER_SECOND)),
      'retry-after-ms': String(Math.ceil(waitMs))
    }
  }
}
