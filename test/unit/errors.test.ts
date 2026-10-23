import type { AssistantMessage } from '@earendil-works/pi-ai'
import {
  forClientKey,
  invalidRequest,
  mapFailedCall,
  mapUpstreamError,
  modelNotFound,
  unsupportedParameter
} from '@proxy/server/errors'
import { describe, expect, test } from 'vite-plus/test'

describe('error helpers', () => {
  test('invalidRequest creates correct shape', () => {
    const err = invalidRequest('bad input', 'model')
    expect(err.error.message).toBe('bad input')
    expect(err.error.type).toBe('invalid_request_error')
    expect(err.error.param).toBe('model')
    expect(err.error.code).toBeNull()
  })

  test('modelNotFound creates correct shape', () => {
    const err = modelNotFound('fake/model')
    expect(err.error.message).toContain('fake/model')
    expect(err.error.code).toBe('model_not_found')
  })

  test('unsupportedParameter creates correct shape', () => {
    const err = unsupportedParameter('tools')
    expect(err.error.param).toBe('tools')
    expect(err.error.code).toBe('unsupported_parameter')
  })
})

describe('mapUpstreamError', () => {
  /** Upstream error text can quote the request, a key or an account: none may pass through. */
  const SECRET = 'notarealsecret-upstream-quoted-key'

  /**
   * Builds the fixed OpenAI-style error body the proxy answers an upstream failure with.
   *
   * @param message - the fixed client-facing message
   * @param code - the error `code`, such as `rate_limit`
   * @returns the `{ error: … }` body, with `type: 'server_error'` and `param: null`
   */
  function upstreamBody(message: string, code: string): unknown {
    return { error: { message, type: 'server_error', param: null, code } }
  }

  // Catches a branch answering with the wrong status, a body that is not the fixed text for it,
  // or the upstream message (and whatever it quotes) reaching the client.
  test.each([
    [
      'a rate limit',
      `rate limit exceeded for ${SECRET}`,
      429,
      upstreamBody('Upstream rate limit exceeded', 'rate_limit')
    ],
    [
      'a socket timeout',
      `connect ETIMEDOUT ${SECRET}`,
      504,
      upstreamBody('Upstream request timed out', 'timeout')
    ],
    [
      'the proxy’s upstream idle timeout',
      'Upstream timeout: the provider sent nothing for 120 s',
      504,
      upstreamBody('Upstream request timed out', 'timeout')
    ],
    [
      'an upstream auth failure',
      `401 Unauthorized: invalid x-api-key ${SECRET}`,
      502,
      upstreamBody('Upstream authentication failed', 'upstream_auth_error')
    ],
    [
      'an overloaded provider',
      `529 overloaded ${SECRET}`,
      503,
      upstreamBody('Upstream provider is overloaded', 'provider_overloaded')
    ],
    [
      'anything else',
      `404 {"error":"no route for ${SECRET}"}`,
      502,
      upstreamBody('Upstream provider error', 'upstream_error')
    ]
  ])('maps %s to its status and fixed text', (_case, upstreamMessage, status, body) => {
    const mapped = mapUpstreamError(new Error(upstreamMessage))

    expect(mapped).toEqual({ status, body })
    expect(JSON.stringify(mapped)).not.toContain(SECRET)
  })

  /** The provider refused the request as invalid: OpenAI's client error, fixed text (#147). */
  const REJECTED_AS_INVALID = {
    status: 400,
    body: {
      error: {
        message:
          'The provider rejected the request as invalid. Check the fields this model accepts.',
        type: 'invalid_request_error',
        param: null,
        code: 'upstream_invalid_request'
      }
    }
  }

  // Catches a request the provider refused for the client's own field answered as a server fault
  // (502), which tells the client to retry a request that cannot succeed; or the provider's text,
  // which can quote the request, reaching the client.
  test.each([
    [
      'Anthropic',
      `400 {"type":"error","error":{"type":"invalid_request_error","message":"top_p: ${SECRET}"}}`
    ],
    ['OpenAI SDK', `400 "Unsupported parameter: ${SECRET}"`],
    ['a labeled 422', `OpenAI API error (422): ${SECRET} is not a valid value`]
  ])('maps a %s rejection to 400 invalid_request_error', (_case, upstreamMessage) => {
    const mapped = mapUpstreamError(new Error(upstreamMessage))

    expect(mapped).toEqual(REJECTED_AS_INVALID)
    expect(JSON.stringify(mapped)).not.toContain(SECRET)
  })

  const RATE_LIMITED = {
    status: 429,
    body: upstreamBody('Upstream rate limit exceeded', 'rate_limit')
  }
  const TIMED_OUT = { status: 504, body: upstreamBody('Upstream request timed out', 'timeout') }
  const AUTH_FAILED = {
    status: 502,
    body: upstreamBody('Upstream authentication failed', 'upstream_auth_error')
  }
  const UNAVAILABLE = {
    status: 503,
    body: upstreamBody('Upstream provider is unavailable', 'provider_unavailable')
  }
  const PROVIDER_FAILED = {
    status: 502,
    body: upstreamBody('Upstream provider error', 'upstream_error')
  }

  // Catches a credential problem a provider reports with a 400 (Google's bad API key is
  // `400 INVALID_ARGUMENT`) blamed on the client's fields: the client cannot fix it, so it stays a
  // server-side auth failure, logged as an error.
  test.each([
    [
      'Google, bad API key',
      `{"error":{"code":400,"message":"API key not valid. Please pass a valid API key. ${SECRET}","status":"INVALID_ARGUMENT"}}`
    ],
    [
      'a labeled 400 about authentication',
      `OpenAI API error (400): Authentication failed for ${SECRET}`
    ]
  ])('maps %s to 502 upstream_auth_error', (_case, upstreamMessage) => {
    const mapped = mapUpstreamError(new Error(upstreamMessage))

    expect(mapped).toEqual(AUTH_FAILED)
    expect(JSON.stringify(mapped)).not.toContain(SECRET)
  })

  // Catches the client's own key (X-Switchboard-Upstream-Api-Key), refused by the provider,
  // answered as the proxy's fault (502) or with the provider's text, which can quote the key
  // (#128); and any other failure changed by it.
  test('answers a refused client key with 401 upstream_api_key_invalid, nothing else', () => {
    const refused = forClientKey(
      mapUpstreamError(new Error(`OpenAI API error (401): Incorrect API key ${SECRET}`))
    )

    expect(refused).toEqual({
      status: 401,
      body: {
        error: {
          message: 'The provider rejected the API key in X-Switchboard-Upstream-Api-Key.',
          type: 'authentication_error',
          param: null,
          code: 'upstream_api_key_invalid'
        }
      }
    })
    expect(JSON.stringify(refused)).not.toContain(SECRET)
    for (const other of ['OpenAI API error (429): slow down', 'OpenAI API error (500): oops']) {
      const mapped = mapUpstreamError(new Error(other))
      expect(forClientKey(mapped)).toBe(mapped)
    }
  })

  // Catches a model the provider login cannot use answered as an outage (502), which a client
  // retries forever (#156): Codex refuses a model the ChatGPT plan lacks with a stream event and no
  // status, or a 400. A refusal on other grounds is not this, and the model ID never reaches the
  // body.
  test.each([
    [
      'a stream error event, no status',
      "Codex error: The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account."
    ],
    [
      'a 400',
      `400 {"detail":"The 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account."}`
    ],
    [
      'a 400 that also mentions credentials',
      `400 {"detail":"The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account. Check your account credentials."}`
    ]
  ])('maps Codex refusing the model, %s, to 404 model_not_found', (_case, upstreamMessage) => {
    const mapped = mapUpstreamError(new Error(upstreamMessage))

    expect(mapped).toEqual({
      status: 404,
      body: {
        error: {
          message:
            'The model is not available with the provider login the proxy uses. Choose another model.',
          type: 'invalid_request_error',
          param: 'model',
          code: 'model_not_found'
        }
      }
    })
    expect(JSON.stringify(mapped)).not.toContain('gpt-5')
  })

  // Catches the wording rule outranking a status that says otherwise, or matching a model refusal
  // that is not about the login: a 503 or a plain "model not supported" keeps its own mapping.
  test.each([
    [
      'a 503 quoting the wording',
      "503: The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.",
      UNAVAILABLE
    ],
    ['a model refusal from another provider', 'Codex error: model not supported', PROVIDER_FAILED]
  ])('keeps %s as it was', (_case, upstreamMessage, expected) => {
    expect(mapUpstreamError(new Error(upstreamMessage))).toEqual(expected)
  })

  // Catches the status read from the wrong place (#42): pi 1.3.0 reports it in fixed positions per
  // SDK, and those decide over the wording; a number elsewhere in the text, or a word inside
  // another word, must not.
  test.each([
    [
      'OpenAI quota, no "rate limit" wording',
      '429: {"message":"You exceeded your current quota","type":"insufficient_quota"}',
      RATE_LIMITED
    ],
    [
      'Anthropic 429 worded "Too many requests"',
      '429 {"type":"error","error":{"type":"api_error","message":"Too many requests"}}',
      RATE_LIMITED
    ],
    [
      'a 401 whose text says "rate limit"',
      '401: {"message":"Invalid key for the rate limit tier"}',
      AUTH_FAILED
    ],
    [
      'Responses/Azure with a label',
      'OpenAI API error (429): {"message":"Slow down"}',
      RATE_LIMITED
    ],
    [
      // No wording any fallback matches: only the body's `code` can say this is an auth failure.
      'Google error body',
      '{"error":{"code":401,"message":"Request had invalid authentication credentials.","status":"UNAUTHENTICATED"}}',
      AUTH_FAILED
    ],
    [
      'Google mid-stream',
      'got status: 503. {"error":{"code":503,"message":"The model is overloaded"}}',
      UNAVAILABLE
    ],
    ['an upstream 504', '504: {"message":"Gateway Timeout"}', TIMED_OUT],
    ['an upstream 408 with no body', '408 status code (no body)', TIMED_OUT],
    ['an upstream 503 with a text body', '503 "upstream connect error"', UNAVAILABLE],
    // A message that merely starts with a number is not reporting a status (PR #56 review).
    ['a leading 429 that is a count', '429 tokens per minute exceeds your tier', PROVIDER_FAILED],
    [
      'a leading 401 that is a count',
      '401 messages were sent in this conversation',
      PROVIDER_FAILED
    ],
    // With no status, wording is checked in order: a rate limit is reported as one even when the
    // same message also says something timed out.
    ['rate limit before timeout, no status', 'Rate limit retry timed out', RATE_LIMITED],
    ['an upstream 503', '503: {"message":"Service Unavailable"}', UNAVAILABLE],
    [
      'an upstream 500 that mentions a rate limit',
      '500: {"message":"rate limiter crashed"}',
      PROVIDER_FAILED
    ],
    [
      '401 only as data, no status',
      'Invalid prompt: 401 tokens over the 200000 limit',
      PROVIDER_FAILED
    ],
    ['"generate" is not "rate"', 'Could not generate limit-compliant output', PROVIDER_FAILED],
    [
      'Bedrock throttling, no status',
      'Too many requests, please wait before trying again.',
      RATE_LIMITED
    ],
    [
      'Bedrock unavailable, no status',
      'ServiceUnavailableException: Service unavailable',
      UNAVAILABLE
    ],
    ['a dropped connection', 'terminated', PROVIDER_FAILED]
  ])('maps %s', (_case, upstreamMessage, expected) => {
    expect(mapUpstreamError(new Error(upstreamMessage))).toEqual(expected)
  })

  const OVERLOADED = {
    status: 503,
    body: upstreamBody('Upstream provider is overloaded', 'provider_overloaded')
  }

  // Catches a usage limit or a provider out of capacity answered as an outage (502), which no
  // fallback chain or cooldown acts on (#190). pi reports Codex's 429 for a ChatGPT login over its
  // limit with no status, so the words decide; a status in the message still decides over them.
  test.each([
    [
      'a Codex usage limit, with plan and wait',
      'You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min.',
      RATE_LIMITED
    ],
    ['a Codex usage limit, no plan', 'You have hit your ChatGPT usage limit.', RATE_LIMITED],
    ['a Codex stream error event', 'Codex error: usage_limit_reached', RATE_LIMITED],
    [
      'a ChatGPT Business workspace limit',
      'subscription_sharing_workplace_individual_usage_limit_exceeded',
      RATE_LIMITED
    ],
    ['"usage limitations" is not a limit', 'Read the usage limitations first', PROVIDER_FAILED],
    ['usage limits, plural', 'You have reached your usage limits for today', RATE_LIMITED],
    ['a model at capacity', 'The model is at capacity, please try again later', OVERLOADED],
    ['busy servers', 'Servers are currently busy', OVERLOADED],
    ['a server_busy code', '{"error":{"type":"server_busy"}}', OVERLOADED],
    ['high demand', 'We are currently experiencing high demand', OVERLOADED],
    // Only pi's own phrases: the words alone say nothing about the provider's load.
    ['"capacity" alone is not overload', 'Context capacity planning failed', PROVIDER_FAILED],
    [
      '"high demand" alone is not overload',
      'Feature in high demand is unavailable here',
      PROVIDER_FAILED
    ],
    [
      'a 500 that mentions a usage limit',
      '500: {"message":"usage limit lookup failed"}',
      PROVIDER_FAILED
    ],
    ['a 502 that says busy', '502: {"message":"Servers are currently busy"}', PROVIDER_FAILED]
  ])('maps %s', (_case, upstreamMessage, expected) => {
    expect(mapUpstreamError(new Error(upstreamMessage))).toEqual(expected)
  })

  test('maps a thrown value that is not an Error to the generic 502', () => {
    expect(mapUpstreamError(`string error ${SECRET}`)).toEqual({
      status: 502,
      body: upstreamBody('Upstream provider error', 'upstream_error')
    })
  })
})

describe('mapFailedCall', () => {
  /** Token counts and request text the provider's overflow message carries: never in the answer. */
  const QUOTED = 'notarealsecret-quoted-prompt'

  /**
   * Builds pi's final message for a call that failed with this error text.
   *
   * @param errorMessage - the error text pi recorded for the failed call
   * @param provider - the provider name on the message; `mock` when omitted
   * @returns an `openai-completions` assistant message with `stopReason: 'error'`, no content and
   *   zero usage
   */
  function failedCall(errorMessage: string, provider = 'mock'): AssistantMessage {
    return {
      role: 'assistant',
      content: [],
      api: 'openai-completions',
      provider,
      model: 'model',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      stopReason: 'error',
      errorMessage,
      timestamp: 0
    }
  }

  const CONTEXT_OVERFLOW = {
    status: 400,
    body: {
      error: {
        message:
          "The messages exceed the model's context window. Shorten or summarize them and try again.",
        type: 'invalid_request_error',
        param: 'messages',
        code: 'context_length_exceeded'
      }
    }
  }

  // Catches an overflow answered as a generic 502, which agent clients retry unchanged instead of
  // compacting the history (#40), for the providers and statuses the mock-provider tests in
  // test/integration/upstream-status.test.ts do not cover.
  test.each([
    [
      'Google, error body',
      `{"error":{"code":400,"message":"The input token count (1200000) exceeds the maximum number of tokens allowed (1048576). ${QUOTED}","status":"INVALID_ARGUMENT"}}`
    ],
    [
      'Google, mid-stream',
      `got status: 400. {"error":{"code":400,"message":"The input token count (1200000) exceeds the maximum number of tokens allowed (1048576). ${QUOTED}"}}`
    ],
    ['Bedrock, no status', `ValidationException: Input is too long for requested model. ${QUOTED}`],
    [
      'Anthropic request too large (413)',
      `413 {"type":"error","error":{"type":"request_too_large","message":"${QUOTED}"}}`
    ],
    // pi 1.4.0: a 413 is an overflow whatever its body says (a 502 on 1.3.0).
    [
      'Copilot request too large (413), no overflow wording',
      `github-copilot API error (413): {"message":"failed to parse request","code":""}`
    ],
    [
      'OpenAI Responses',
      `OpenAI API error (400): Your input exceeds the context window of this model. ${QUOTED}`
    ]
  ])('maps an overflow from %s to 400 context_length_exceeded', (_case, errorMessage) => {
    const mapped = mapFailedCall(failedCall(errorMessage))

    expect(mapped).toEqual(CONTEXT_OVERFLOW)
    expect(JSON.stringify(mapped)).not.toContain(QUOTED)
  })

  // Catches pi's overflow wording overriding a reported status: these say "too many tokens" or
  // name a limit, but a 429 is a rate limit and a 503 an unavailable provider.
  test.each([
    [
      '429 worded "too many tokens"',
      '429 {"type":"error","error":{"type":"rate_limit_error","message":"Too many tokens in the last minute"}}',
      { status: 429, code: 'rate_limit' }
    ],
    [
      '503 mentioning a token limit',
      '503: {"message":"Token limit exceeded on this shard, try again"}',
      { status: 503, code: 'provider_unavailable' }
    ],
    // Catches a 400 that is not an overflow (Claude refusing a whitespace-only stop sequence)
    // treated as one, which would tell an agent client to compact a history that is not too long.
    [
      '400 that is not an overflow',
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"stop_sequences: each stop sequence must contain non-whitespace"}}',
      { status: 400, code: 'upstream_invalid_request' }
    ]
  ])('keeps a %s as its status says', (_case, errorMessage, expected) => {
    const mapped = mapFailedCall(failedCall(errorMessage))

    expect({ status: mapped.status, code: mapped.body.error.code }).toEqual(expected)
  })
})
