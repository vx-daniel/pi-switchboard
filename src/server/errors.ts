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
 * - 401: proxy auth failure, no upstream credential for the model
 * - 404: model not found, unsupported endpoint, any other route (`Invalid URL (<method> <path>)`)
 * - 413: request body over the size limit
 * - 422: unsupported or unknown request field, unsupported tool
 * - 429: upstream rate limit
 * - 500: anything thrown inside the proxy, an invalid model exposure config included
 *   (`internalError`, answered by `app.onError`)
 * - 502: upstream authentication failure (401, 403), any other upstream error
 * - 503: upstream unavailable (503) or overloaded (529), failed health check
 * - 504: upstream timeout (408, 504, idle timeout)
 *
 * @packageDocumentation
 */

import { type AssistantMessage, isContextOverflow } from '@earendil-works/pi-ai'
import { isRecord } from '@proxy/utils/guards'
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
export type UpstreamErrorStatus = 400 | 404 | 429 | 502 | 503 | 504

/** An upstream failure as the client sees it: a status and a fixed body that quotes nothing. */
export interface MappedUpstreamError {
  readonly status: UpstreamErrorStatus
  readonly body: OpenAIError
}

/** Upstream rate limit: 429 `rate_limit`. */
const RATE_LIMITED: MappedUpstreamError = {
  status: 429,
  body: upstreamError('Upstream rate limit exceeded', 'rate_limit')
}
/** Upstream timeout: 504 `timeout`. */
const TIMED_OUT: MappedUpstreamError = {
  status: 504,
  body: upstreamError('Upstream request timed out', 'timeout')
}
/** Upstream refused the proxy's credential: 502 `upstream_auth_error`. */
const AUTH_FAILED: MappedUpstreamError = {
  status: 502,
  body: upstreamError('Upstream authentication failed', 'upstream_auth_error')
}
/** Upstream unavailable: 503 `provider_unavailable`. */
const UNAVAILABLE: MappedUpstreamError = {
  status: 503,
  body: upstreamError('Upstream provider is unavailable', 'provider_unavailable')
}
/** Upstream overloaded: 503 `provider_overloaded`. */
const OVERLOADED: MappedUpstreamError = {
  status: 503,
  body: upstreamError('Upstream provider is overloaded', 'provider_overloaded')
}
/** Any other upstream failure: 502 `upstream_error`. */
const PROVIDER_FAILED: MappedUpstreamError = {
  status: 502,
  body: upstreamError('Upstream provider error')
}
/**
 * OpenAI's answer to a request longer than the model's context window, which agent clients watch
 * for to compact the history and retry (#40). Fixed text: the provider's message quotes token
 * counts and sometimes the request.
 */
const CONTEXT_OVERFLOW: MappedUpstreamError = {
  status: 400,
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
  status: 400,
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
  status: 404,
  body: makeError(
    'The model is not available with the provider login the proxy uses. Choose another model.',
    'invalid_request_error',
    'model',
    'model_not_found'
  )
}

/** HTTP 400 Bad Request. */
const HTTP_BAD_REQUEST = 400
/** HTTP 401 Unauthorized. */
const HTTP_UNAUTHORIZED = 401
/** HTTP 403 Forbidden. */
const HTTP_FORBIDDEN = 403
/** HTTP 408 Request Timeout. */
const HTTP_REQUEST_TIMEOUT = 408
/** HTTP 413 Payload Too Large. */
const HTTP_PAYLOAD_TOO_LARGE = 413
/** HTTP 422 Unprocessable Entity. */
const HTTP_UNPROCESSABLE_ENTITY = 422
/** HTTP 429 Too Many Requests. */
const HTTP_TOO_MANY_REQUESTS = 429
/** HTTP 503 Service Unavailable. */
const HTTP_SERVICE_UNAVAILABLE = 503
/** HTTP 504 Gateway Timeout. */
const HTTP_GATEWAY_TIMEOUT = 504
/** Anthropic's "overloaded". */
const HTTP_OVERLOADED = 529
/** The first error status: error statuses span 400–599. */
const FIRST_ERROR_STATUS = 400
/** The first status past the error range. */
const PAST_LAST_ERROR_STATUS = 600

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
 * Where pi 1.3.0 puts the provider's HTTP status in an error message:
 * - leading, followed by what only a status is followed by: pi's `429: {…}`, the Anthropic SDK's
 *   `429 {…}`, the OpenAI SDK's `429 "Too Many Requests"` (a text body) and `429 status code (no
 *   body)`. A message that merely starts with a number (`429 tokens over…`) does not match;
 * - after a label, from `formatProviderError` with a prefix (Responses, Azure) and Mistral:
 *   `OpenAI API error (429): …`;
 * - Google's SDK mid-stream: `got status: 429. {…}`.
 */
const STATUS_POSITIONS: readonly RegExp[] = [
  /^([45]\d\d)(?::\s| [{"]| status code\b)/,
  /^[^\n(]{1,80} \(([45]\d\d)\):/,
  /^got status: ([45]\d\d)\b/
]

/**
 * Reads the status as Google's SDK reports it: the error body itself, `{"error":{"code":429,…}}`.
 *
 * @param message - the upstream error message
 * @returns the 4xx or 5xx `error.code` when the message is such a JSON body, else `undefined`
 */
function googleBodyStatus(message: string): number | undefined {
  if (!message.startsWith('{')) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(message)
  } catch {
    return undefined
  }
  const errorBody = isRecord(parsed) ? parsed['error'] : undefined
  const code = isRecord(errorBody) ? errorBody['code'] : undefined
  return typeof code === 'number' && code >= FIRST_ERROR_STATUS && code < PAST_LAST_ERROR_STATUS
    ? code
    : undefined
}

/**
 * Reads the provider's HTTP status from an upstream error message.
 *
 * @remarks
 * Only the positions pi's messages put it in count ({@link STATUS_POSITIONS}, then Google's JSON
 * body), never a number elsewhere in the text (a token count, an ID, a quoted request).
 *
 * @param message - the upstream error message
 * @returns the status, or `undefined` when the message reports none
 */
function upstreamStatusIn(message: string): number | undefined {
  for (const position of STATUS_POSITIONS) {
    const found = position.exec(message)?.[1]
    if (found !== undefined) return Number(found)
  }
  return googleBodyStatus(message)
}

/**
 * Wording that identifies a failure when the message carries no status: Bedrock, network
 * failures, and the proxy's own upstream idle timeout. Checked in this order.
 */
const BY_WORDING: readonly (readonly [RegExp, MappedUpstreamError])[] = [
  [/\brate[\s_-]?limit|\btoo many requests\b|\bresource[\s_-]?exhausted\b/i, RATE_LIMITED],
  [/\btime[ds]?[\s_-]?out\b|\bETIMEDOUT\b/i, TIMED_OUT],
  [/\bunauthori[sz]ed\b/i, AUTH_FAILED],
  [/\boverloaded\b/i, OVERLOADED],
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
  if (status === HTTP_BAD_REQUEST && CREDENTIAL_WORDING.test(message)) return AUTH_FAILED
  const statusAllowsRefusal = status === undefined || status === HTTP_BAD_REQUEST
  if (statusAllowsRefusal && MODEL_REFUSED_WORDING.test(message)) return MODEL_UNAVAILABLE
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
