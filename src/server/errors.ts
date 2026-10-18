/**
 * OpenAI-compatible error response helpers.
 *
 * Phase 0 contract: Error shape is:
 * { error: { message, type, param, code } }
 *
 * Status code mapping:
 * - 400: invalid request, ambiguous shorthand
 * - 401: proxy auth failure, missing upstream credential
 * - 404: model not found
 * - 422: unsupported parameter, unsupported content
 * - 429: upstream rate limit
 * - 500: internal proxy failure
 * - 502: malformed upstream response
 * - 503: provider unavailable
 * - 504: upstream timeout
 */

import { type AssistantMessage, isContextOverflow } from '@earendil-works/pi-ai'
import { isRecord } from '@proxy/utils/guards'

export interface OpenAIError {
  readonly error: {
    readonly message: string
    readonly type: string
    readonly param: string | null
    readonly code: string | null
  }
}

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

export function invalidRequest(message: string, param?: string): OpenAIError {
  return makeError(message, 'invalid_request_error', param ?? null, null)
}

export function modelNotFound(modelId: string): OpenAIError {
  return makeError(
    `The model '${modelId}' does not exist`,
    'invalid_request_error',
    'model',
    'model_not_found'
  )
}

export function unsupportedParameter(param: string, message?: string): OpenAIError {
  return makeError(
    message ?? `Unsupported parameter: '${param}'`,
    'invalid_request_error',
    param,
    'unsupported_parameter'
  )
}

export function authenticationError(message: string): OpenAIError {
  return makeError(message, 'authentication_error', null, null)
}

function upstreamError(message: string, code?: string): OpenAIError {
  return makeError(message, 'server_error', null, code ?? 'upstream_error')
}

/** The statuses an upstream failure is answered with. */
export type UpstreamErrorStatus = 400 | 429 | 502 | 503 | 504

/** An upstream failure as the client sees it: a status and a fixed body that quotes nothing. */
export interface MappedUpstreamError {
  readonly status: UpstreamErrorStatus
  readonly body: OpenAIError
}

const RATE_LIMITED: MappedUpstreamError = {
  status: 429,
  body: upstreamError('Upstream rate limit exceeded', 'rate_limit')
}
const TIMED_OUT: MappedUpstreamError = {
  status: 504,
  body: upstreamError('Upstream request timed out', 'timeout')
}
const AUTH_FAILED: MappedUpstreamError = {
  status: 502,
  body: upstreamError('Upstream authentication failed', 'upstream_auth_error')
}
const UNAVAILABLE: MappedUpstreamError = {
  status: 503,
  body: upstreamError('Upstream provider is unavailable', 'provider_unavailable')
}
const OVERLOADED: MappedUpstreamError = {
  status: 503,
  body: upstreamError('Upstream provider is overloaded', 'provider_overloaded')
}
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

const HTTP_BAD_REQUEST = 400
const HTTP_UNAUTHORIZED = 401
const HTTP_FORBIDDEN = 403
const HTTP_REQUEST_TIMEOUT = 408
const HTTP_PAYLOAD_TOO_LARGE = 413
const HTTP_TOO_MANY_REQUESTS = 429
const HTTP_SERVICE_UNAVAILABLE = 503
const HTTP_GATEWAY_TIMEOUT = 504
/** Anthropic's "overloaded". */
const HTTP_OVERLOADED = 529
/** Error statuses span 400–599. */
const FIRST_ERROR_STATUS = 400
const PAST_LAST_ERROR_STATUS = 600

/** Upstream HTTP statuses with their own answer; any other 4xx or 5xx is PROVIDER_FAILED. */
const BY_STATUS: ReadonlyMap<number, MappedUpstreamError> = new Map([
  [HTTP_UNAUTHORIZED, AUTH_FAILED],
  [HTTP_FORBIDDEN, AUTH_FAILED],
  [HTTP_REQUEST_TIMEOUT, TIMED_OUT],
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

/** The status as Google's SDK reports it: the error body itself, `{"error":{"code":429,…}}`. */
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
 * The provider's HTTP status, read only from the positions pi's messages put it in, never from a
 * number elsewhere in the text (a token count, an ID, a quoted request).
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
 * Map an upstream failure to the status and fixed body the client gets. The provider's HTTP status
 * decides when pi's message reports one; its wording is consulted only when it does not. The body
 * never quotes the upstream message, which can carry the request, a key or an account.
 */
export function mapUpstreamError(err: unknown): MappedUpstreamError {
  const message = err instanceof Error ? err.message : ''
  const status = upstreamStatusIn(message)
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
 * Map a failed pi call, given its final message. A context overflow, as pi recognizes it across
 * providers (`isContextOverflow`), is OpenAI's 400 `context_length_exceeded`; anything else maps
 * as mapUpstreamError does. A reported status other than 400 or 413 rules overflow out: a 429 that
 * says "too many tokens" is a rate limit.
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
