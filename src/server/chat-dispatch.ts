/**
 * Runs a chat request on its model, or on an alias's fallback chain (#67), and answers it.
 *
 * @remarks
 * A request names one model, or an alias whose `{ targets, fallbackOn }` lists several. Each
 * candidate gets one attempt. A failure *before the response starts* moves to the next candidate
 * only when the alias's `fallbackOn` names its class ({@link failureClass}): principle VI says
 * fallback follows only the failures the configuration names. Anything else is answered as the
 * single-model path always has. That covers a 400 (the request's own fault), the client leaving, a
 * class the alias does not name, the last candidate's failure, and any failure after a stream
 * started, which ends the stream with an error event.
 *
 * Every hop is visible:
 * - a warning per failed attempt, naming the alias, the model, the class and the next model;
 * - `x_pi.attempts` on the answer, non-streamed and in every stream chunk;
 * - each attempt's alias and number on its upstream log lines, and the route's running totals
 *   (`route-totals.ts`, #70): its attempts, failures, fallbacks, tokens and cost.
 *
 * A request without an alias chain, or an alias with one target, behaves exactly as before #67.
 * With a per-request upstream key (`X-Switchboard-Upstream-Api-Key`) nothing falls back: the key is
 * one provider's, and trying another provider would send it there.
 *
 * @packageDocumentation
 */

import type { AssistantMessageEvent } from '@earendil-works/pi-ai'
import type { FailureClass, Reserve } from '@proxy/config/schema'
import { proxyLogger } from '@proxy/logging'
import type { ConversionSuccess } from '@proxy/openai/messages'
import type { ExposedModel } from '@proxy/openai/model-exposure'
import { type Attempt, buildChatCompletion, type ResponseRoute } from '@proxy/openai/responses'
import type { ChatCompletionRequest } from '@proxy/openai/schemas'
import { streamToSSE } from '@proxy/openai/sse'
import { type CompletionOptions, piComplete, piStream } from '@proxy/pi/complete'
import { clearCooldowns, loginSubject } from '@proxy/pi/cooldowns'
import { recordQuota } from '@proxy/pi/quota'
import { getRequestAuth } from '@proxy/pi/registry'
import type { FailedResponse } from '@proxy/pi/reset-time'
import { type ActiveRequestHandle, requestOutcome } from '@proxy/server/active-requests'
import { answeredEffort, withAliasEffort } from '@proxy/server/alias-effort'
import {
  CREDENTIALS_MISSING,
  forClientKey,
  type MappedUpstreamError,
  mapFailedCall,
  mapUpstreamError,
  type OpenAIError
} from '@proxy/server/errors'
import {
  HTTP_BAD_GATEWAY,
  HTTP_BAD_REQUEST,
  HTTP_GATEWAY_TIMEOUT,
  HTTP_NOT_FOUND,
  HTTP_SERVICE_UNAVAILABLE,
  HTTP_TOO_MANY_REQUESTS,
  HTTP_UNAUTHORIZED
} from '@proxy/server/http-status'
import { attemptOf, recordCooldown, skipCooling } from '@proxy/server/route-cooldowns'
import { nextFor, type RouteHops } from '@proxy/server/route-hops'
import type { ChatRoute } from '@proxy/server/route-plan'
import { skipBelowReserve } from '@proxy/server/route-reserve'
import {
  recordRouteAttempt,
  recordRouteFailure,
  recordRouteFallback,
  recordRouteUsage,
  routeKey,
  streamFailureCounter
} from '@proxy/server/route-totals'
import type { ProxyEnv } from '@proxy/server/types'
import { startingWith } from '@proxy/utils/async-iterables'
import type { Context } from 'hono'
import { stream as honoStream } from 'hono/streaming'

/** Logger for chat requests: the same category as the chat route's. */
const chatLogger = proxyLogger('server', 'chat')

/** The Hono context a route handler gets. */
type ProxyContext = Context<ProxyEnv>
/** A pi `Context`: system prompt, messages and tools. */
type PiContext = ConversionSuccess['context']

/**
 * An answer the client gets when a call fails: a mapped upstream error, the 401 for a client key
 * the provider refused, or the 502 for no credential.
 */
export interface FailedAnswer {
  readonly status: MappedUpstreamError['status']
  readonly body: OpenAIError
}

/**
 * Each failed answer's class, by status. A 400 is the request's own fault, so it has none: another
 * model is not the answer to it. A 401 is the client's own key refused. A 502 is `upstream_error`
 * unless its code says the credential failed or is missing ({@link failureClass}).
 */
const FAILURE_BY_STATUS: Readonly<Record<FailedAnswer['status'], FailureClass | undefined>> = {
  [HTTP_BAD_REQUEST]: undefined,
  [HTTP_UNAUTHORIZED]: 'auth',
  [HTTP_NOT_FOUND]: 'refused',
  [HTTP_TOO_MANY_REQUESTS]: 'rate_limit',
  [HTTP_BAD_GATEWAY]: 'upstream_error',
  [HTTP_SERVICE_UNAVAILABLE]: 'unavailable',
  [HTTP_GATEWAY_TIMEOUT]: 'timeout'
}

/** The 502 codes that are a credential problem, the `auth` class: refused, or missing (#128). */
const CREDENTIAL_CODES: ReadonlySet<string | null> = new Set([
  'upstream_auth_error',
  CREDENTIALS_MISSING.body.error.code
])

/**
 * Classifies a failed answer for an alias's `fallbackOn` (#67).
 *
 * @param answer - what the client would get for the failure
 * @returns the failure class, or `undefined` for one that never falls back (a 400)
 */
export function failureClass(answer: FailedAnswer): FailureClass | undefined {
  if (answer.status === HTTP_BAD_GATEWAY && CREDENTIAL_CODES.has(answer.body.error.code)) {
    return 'auth'
  }
  return FAILURE_BY_STATUS[answer.status]
}

/**
 * Logs a failed call's raw upstream message at debug, never higher: some providers quote parts of
 * the request back.
 *
 * @param detail - the raw upstream error message, or `undefined` when there is none
 */
function logUpstreamDetail(detail: string | undefined): void {
  if (detail !== undefined) chatLogger.debug('Upstream error detail: {detail}', { detail })
}

/**
 * Logs a mapped upstream failure.
 *
 * @remarks
 * A line for the failure, plus a warning for rate limiting or overload (429, 503) so those can be
 * counted apart from real failures. A 400 is the client's doing (a field the provider refused, a
 * history too long for the model), and so is a 401 (the provider refused the client's own key),
 * so their line is a warning; any other failure is an error. The level follows the mapped status
 * on purpose: mapping decides whose fault a failure is (a credential problem a provider answers
 * with 400 maps to a 502, so it stays an error), and any future mapping to 400 is a client error
 * too. The raw upstream `detail` stays at debug ({@link logUpstreamDetail}). The request's IDs
 * come from the logging context.
 *
 * @param mapped - the status and body the client gets
 * @param detail - the raw upstream error message, or `undefined` when there is none
 * @returns `mapped`, unchanged
 */
function reportUpstreamFailure(
  mapped: MappedUpstreamError,
  detail: string | undefined
): MappedUpstreamError {
  const properties = {
    status: mapped.status,
    message: mapped.body.error.message,
    code: mapped.body.error.code
  }
  if (mapped.status === HTTP_BAD_REQUEST || mapped.status === HTTP_UNAUTHORIZED) {
    chatLogger.warn('Upstream refused the request with {status}: {message}', properties)
  } else {
    chatLogger.error('Upstream call failed with {status}: {message}', properties)
  }
  logUpstreamDetail(detail)
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
 * Checks that a model's provider can be authenticated before it is called.
 *
 * @remarks
 * With no per-request key, the model's provider must have a credential pi can resolve; otherwise
 * the request is refused early, with 502 `upstream_credentials_missing` (#128): the fix is a pi
 * login on the proxy's host, which the client cannot do. pi's reason is logged, never answered: it
 * can quote a key command or an install path.
 *
 * @param model - the pi model
 * @param upstreamApiKey - the `X-Switchboard-Upstream-Api-Key` value, or `undefined` when not sent
 * @returns the 502 answer when no upstream auth is available, else `undefined`
 */
async function checkCredential(
  model: ExposedModel['model'],
  upstreamApiKey: string | undefined
): Promise<FailedAnswer | undefined> {
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
  return CREDENTIALS_MISSING
}

/** One hop of a fallback chain: the model that failed, the next one, and why (#67). */
interface FallbackHop {
  readonly failed: ExposedModel
  readonly next: ExposedModel
  /** The failure class, which the alias's `fallbackOn` names. */
  readonly failure: FailureClass
  /** The attempt number, from 1. */
  readonly attempt: number
}

/**
 * Logs one failed attempt the route moves on from.
 *
 * @param alias - the alias whose chain it is, if any
 * @param hop - the model that failed, the next one, the class and the attempt number
 */
function logFallback(alias: string | undefined, hop: FallbackHop): void {
  chatLogger.warn(
    'Alias {alias}: {model} on {login} failed ({failure}); trying {nextModel} on {nextLogin}',
    {
      alias,
      model: hop.failed.canonicalId,
      login: hop.failed.login,
      failure: hop.failure,
      nextModel: hop.next.canonicalId,
      nextLogin: hop.next.login,
      attempt: hop.attempt
    }
  )
}

/** Where the chain starts: the first candidate whose credential resolves, or the 502 answer. */
export type CredentialedStart =
  | {
      readonly kind: 'ready'
      readonly candidates: readonly ExposedModel[]
      readonly attempts: readonly Attempt[]
    }
  | { readonly kind: 'refused'; readonly answer: FailedAnswer }

/**
 * Finds the first candidate whose credential resolves, moving past the others when the alias's
 * `fallbackOn` names `auth`. Run before remote images are fetched, so a request no provider can
 * take fetches nothing (#109 review).
 *
 * @param route - the planned candidates and fallback classes
 * @param upstreamApiKey - the `X-Switchboard-Upstream-Api-Key` value, or `undefined`
 * @param alias - the alias whose chain it is, for the log
 * @returns the candidates from that one on, with the attempts skipped, or the last 502 answer
 */
export async function findCredentialedStart(
  route: ChatRoute,
  upstreamApiKey: string | undefined,
  alias: string | undefined
): Promise<CredentialedStart> {
  const attempts: Attempt[] = []
  let position = 0
  while (position < route.candidates.length) {
    const candidate = route.candidates[position]
    if (candidate === undefined) break
    if (skipCooling({ ...route, alias }, position, attempts)) {
      position += 1
      continue
    }
    const refused = await checkCredential(candidate.model, upstreamApiKey)
    if (refused === undefined) {
      return { kind: 'ready', candidates: route.candidates.slice(position), attempts }
    }
    // A refused credential is an attempt that failed `auth`, as `x_pi.attempts` lists it.
    const key = routeKey(alias, candidate)
    recordRouteAttempt(key)
    recordRouteFailure(key, failureClass(refused))
    const nextPosition = nextFor(route.candidates, position, route, 'auth')
    const next = nextPosition === undefined ? undefined : route.candidates[nextPosition]
    if (nextPosition === undefined || next === undefined) {
      return { kind: 'refused', answer: refused }
    }
    recordRouteFallback(key)
    logFallback(alias, { failed: candidate, next, failure: 'auth', attempt: attempts.length + 1 })
    attempts.push({ ...attemptOf(candidate), reason: 'auth' })
    position = nextPosition
  }
  throw new Error('A chat route has at least one candidate')
}

/** Everything a chat request needs to run on its candidates. */
export interface DispatchJob extends RouteHops {
  readonly requestId: string
  /** The alias the request named (#66): reported as `x_pi.alias`. */
  readonly alias: string | undefined
  /** The candidates in order. The first one's credential was already checked. */
  readonly candidates: readonly ExposedModel[]
  /** The quota reserve per login (`routing.reserve`, #69). */
  readonly reserve: Reserve
  /** Attempts already failed, before the first candidate (credential checks). */
  readonly attempts: readonly Attempt[]
  readonly context: PiContext
  readonly request: ChatCompletionRequest
  readonly options: CompletionOptions
  /**
   * The request's entry among those in flight (the console's sidebar): told each attempt's model,
   * and ended by a stream when it closes. The caller ends it otherwise, once this returns.
   */
  readonly active: ActiveRequestHandle
}

/** How one attempt ended. */
type AttemptOutcome =
  /** The model accepted the request: answer the client with it. */
  | { readonly kind: 'answered'; readonly respond: (route: ResponseRoute) => Response }
  /** Failed before the response started: the chain may move on. */
  | {
      readonly kind: 'failed'
      readonly answer: FailedAnswer
      readonly detail: string | undefined
      /** Logs the failure when it is the one the client gets. */
      readonly report: () => void
    }
  /** Ended for good: the client left, or the response is already decided. */
  | { readonly kind: 'final'; readonly response: Response }

/**
 * An attempt that failed with an upstream error.
 *
 * @param mapped - the mapped error
 * @param detail - the raw upstream message, or `undefined`
 * @param options - the call's options: with the client's own upstream key, a refused credential
 *   is answered as that key's ({@link forClientKey})
 * @returns the outcome, logging the failure only if the client gets it
 */
function upstreamFailure(
  mapped: MappedUpstreamError,
  detail: string | undefined,
  options: CompletionOptions
): AttemptOutcome {
  const answer = options.upstreamApiKey === undefined ? mapped : forClientKey(mapped)
  return {
    kind: 'failed',
    answer,
    detail,
    report: () => reportUpstreamFailure(answer, detail)
  }
}

/**
 * Reads whether the request asked for a final usage chunk.
 *
 * @param request - the validated request
 * @returns whether `stream_options.include_usage` is true
 */
function wantsUsage(request: ChatCompletionRequest): boolean {
  return (
    request.stream_options !== null &&
    request.stream_options !== undefined &&
    request.stream_options.include_usage === true
  )
}

/**
 * Relays a started stream's events, counting a failure for an `error` event: the attempt was
 * answered, but the answer broke off.
 *
 * @param events - the stream's events, from its first
 * @param countFailure - the stream's {@link streamFailureCounter}
 * @returns a generator that yields every event unchanged
 */
async function* countingFailures(
  events: AsyncIterable<AssistantMessageEvent>,
  countFailure: (failure: FailureClass | undefined) => void
): AsyncGenerator<AssistantMessageEvent> {
  for await (const event of events) {
    if (event.type === 'error') countFailure(failureClass(mapFailedCall(event.error)))
    yield event
  }
}

/**
 * Tries a streamed completion on one model.
 *
 * @remarks
 * Nothing is sent until pi's first event: every pi adapter emits `start` only once the provider
 * has accepted the request, so a failure before it (an overflow, a rate limit, bad credentials, a
 * provider that never answers) still gets its HTTP status and JSON body, as OpenAI answers a
 * streaming request it refuses, and can move to the next candidate. Once the stream has started,
 * a failure can only be an SSE error event with the same body.
 *
 * @param honoContext - the request's Hono context
 * @param candidate - the model to call
 * @param job - the pi context, request and call options
 * @returns the outcome: a stream to answer with, a failure before it started, or the client left
 */
async function attemptStream(
  honoContext: ProxyContext,
  candidate: ExposedModel,
  job: DispatchJob
): Promise<AttemptOutcome> {
  const { requestId, context, request, options, active } = job
  const start = performance.now()
  // The client's own departure aborts the call, which then fails: not an upstream failure, and
  // nobody is waiting for the answer.
  const clientLeft = (): AttemptOutcome => {
    chatLogger.debug('Client left before the stream started, after {durationMs} ms', {
      durationMs: Math.round(performance.now() - start)
    })
    return { kind: 'final', response: honoContext.body(null) }
  }

  let started: Awaited<ReturnType<typeof piStream>>
  try {
    started = await piStream(candidate.model, context, request, options)
  } catch (err: unknown) {
    if (options.signal?.aborted === true) return clientLeft()
    return upstreamFailure(
      mapUpstreamError(err),
      err instanceof Error ? err.message : undefined,
      options
    )
  }
  const { first, events } = started
  if (first.done !== true && first.value.type === 'error') {
    if (options.signal?.aborted === true) return clientLeft()
    const failed = first.value.error
    return upstreamFailure(mapFailedCall(failed), failed.errorMessage, options)
  }

  const key = routeKey(job.alias, candidate)
  const respond = (route: ResponseRoute): Response => {
    const includeUsage = wantsUsage(request)
    honoContext.header('content-type', 'text/event-stream')
    honoContext.header('cache-control', 'no-cache')
    honoContext.header('connection', 'keep-alive')
    chatLogger.debug('Streaming {model} with includeUsage={includeUsage}', {
      model: route.model,
      includeUsage
    })
    return honoStream(honoContext, async (stream) => {
      // Hono starts this before `honoStream` returns, so the dispatch's `settled` sees the stream
      // and leaves its end to the `finally` below; were it never to run, `settled` ends it.
      active.streaming()
      let frameCount = 0
      let failed = false
      const countFailure = streamFailureCounter(key, options.signal)
      try {
        for await (const frame of streamToSSE(
          countingFailures(startingWith(first, events), (failure) => {
            failed = true
            countFailure(failure)
          }),
          { requestId, route },
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
        failed = true
        countFailure(failureClass(mapped))
        chatLogger.debug('Ending stream with an error event after {frameCount} frames', {
          frameCount,
          durationMs: Math.round(performance.now() - start)
        })
        await stream.write(`data: ${JSON.stringify(mapped.body)}\n\n`)
        await stream.write('data: [DONE]\n\n')
      } finally {
        active.end(requestOutcome(failed, options.signal))
      }
    })
  }
  return { kind: 'answered', respond }
}

/**
 * Tries a non-streaming completion on one model.
 *
 * @param honoContext - the request's Hono context
 * @param candidate - the model to call
 * @param job - the pi context, request and call options
 * @returns the outcome: a completion to answer with, a failure, or the answer for a client that
 *   left (the failure, as before #67)
 */
async function attemptComplete(
  honoContext: ProxyContext,
  candidate: ExposedModel,
  job: DispatchJob
): Promise<AttemptOutcome> {
  const { requestId, context, request, options } = job
  const start = performance.now()
  // A client that left gets no fallback. pi ends the call `aborted` (or the SDK throws), which
  // maps to a failure; it is logged and answered as the single-model path always did, though
  // nobody reads the answer. Without the abort, a failure is returned for `dispatchChat` to
  // decide on. (The streamed path answers a client that left with an empty body instead.)
  const final = (outcome: AttemptOutcome): AttemptOutcome => {
    if (outcome.kind !== 'failed' || options.signal?.aborted !== true) return outcome
    outcome.report()
    return { kind: 'final', response: honoContext.json(outcome.answer.body, outcome.answer.status) }
  }
  try {
    const message = await piComplete(candidate.model, context, request, options)
    chatLogger.debug('Completion for {model} finished: {stopReason} in {durationMs} ms', {
      model: candidate.canonicalId,
      stopReason: message.stopReason,
      durationMs: Math.round(performance.now() - start)
    })
    if (message.stopReason === 'error' || message.stopReason === 'aborted') {
      return final(upstreamFailure(mapFailedCall(message), message.errorMessage, options))
    }
    return {
      kind: 'answered',
      respond: (route) => honoContext.json(buildChatCompletion(requestId, message, route))
    }
  } catch (err: unknown) {
    return final(
      upstreamFailure(
        mapUpstreamError(err),
        err instanceof Error ? err.message : undefined,
        options
      )
    )
  }
}

/** Where an attempt sits in the request's chain. */
interface AttemptStep {
  /** Whether to check the candidate's credential before calling it (the first's already was). */
  readonly checkFirst: boolean
  /** The attempt's number, from 1, counting the skips and refusals in `x_pi.attempts` before it. */
  readonly attempt: number
}

/**
 * Runs one candidate: its credential check (the first's was done before images were fetched),
 * then the streamed or non-streamed call, keeping a copy of a 429 or 503 response for its reset
 * time (#68) and adding each upstream call's usage to the route's totals (#70).
 *
 * @param honoContext - the request's Hono context
 * @param candidate - the model to call
 * @param job - the pi context, request and call options
 * @param step - whether to check the credential first, and the attempt's number
 * @returns how the attempt ended, and the failed response the provider sent, if any
 */
async function runAttempt(
  honoContext: ProxyContext,
  candidate: ExposedModel,
  job: DispatchJob,
  step: AttemptStep
): Promise<{ outcome: AttemptOutcome; captured: FailedResponse | undefined }> {
  chatLogger.debug('Dispatching {model} as {mode}', {
    model: candidate.canonicalId,
    mode: job.request.stream === true ? 'stream' : 'complete',
    upstreamTimeoutMs: job.options.upstreamTimeoutMs
  })
  const refused = step.checkFirst
    ? await checkCredential(candidate.model, job.options.upstreamApiKey)
    : undefined
  if (refused !== undefined) {
    // checkCredential already logged why.
    const outcome: AttemptOutcome = {
      kind: 'failed',
      answer: refused,
      detail: undefined,
      report: () => undefined
    }
    return { outcome, captured: undefined }
  }
  let captured: FailedResponse | undefined
  const key = routeKey(job.alias, candidate)
  const capturing: DispatchJob = {
    ...job,
    request: withAliasEffort(job.request, job.alias, candidate),
    options: {
      ...job.options,
      // pi makes one call per attempt (its retries are off, PLAN "Cooldowns"); were it to retry,
      // the last failure is the one that says when to come back.
      onFailedResponse: (response) => {
        captured = response
      },
      route: { alias: key.alias, attempt: step.attempt },
      onResult: (message) => {
        recordRouteUsage(key, message.usage)
      },
      // A request with its own key reports that key's account, not the login others share.
      onResponseHeaders:
        job.options.upstreamApiKey === undefined
          ? (headers) => {
              recordQuota(candidate.login, headers)
            }
          : undefined
    }
  }
  const outcome = await (job.request.stream === true
    ? attemptStream(honoContext, candidate, capturing)
    : attemptComplete(honoContext, candidate, capturing))
  return { outcome, captured }
}

/**
 * Answers with the candidate that accepted the request, logging the chain that led to it.
 *
 * @param respond - the accepted attempt's responder
 * @param candidate - the model that answered
 * @param job - the alias, for the route
 * @param attempts - the failed attempts before it
 * @returns the response
 */
function answerWith(
  respond: (route: ResponseRoute) => Response,
  candidate: ExposedModel,
  job: DispatchJob,
  attempts: readonly Attempt[]
): Response {
  if (attempts.length > 0) {
    chatLogger.info(
      'Alias {alias} answered by {model} on {login} after {failedCount} failed attempts',
      {
        alias: job.alias,
        model: candidate.canonicalId,
        login: candidate.login,
        failedCount: attempts.length,
        attempts
      }
    )
  }
  const { login } = attemptOf(candidate)
  return respond({
    model: candidate.canonicalId,
    ...(login === undefined ? {} : { login }),
    ...(job.alias === undefined ? {} : { alias: job.alias }),
    attempts,
    reasoningEffort: answeredEffort(job.request, candidate)
  })
}

/**
 * Skips a candidate the chain does not call: cooling down (#68) or below its quota reserve (#69).
 *
 * @param job - the chain
 * @param position - the candidate's index in `job.candidates`
 * @param attempts - the attempts so far; a skip is added to them
 * @returns whether the candidate is skipped
 */
function skipsCandidate(job: DispatchJob, position: number, attempts: Attempt[]): boolean {
  return skipCooling(job, position, attempts) || skipBelowReserve(job, position, attempts)
}

/**
 * Moves a failed attempt on to the next candidate its failure is named for: records the
 * fallback, logs the hop and lists the attempt.
 *
 * @param job - the route
 * @param position - the failed candidate's index
 * @param failure - the failure's class, or `undefined` for one that never moves on, and the raw
 *   upstream message, logged at debug
 * @param attempts - the attempts so far; the failed one is added when the request moves on
 * @returns the next candidate's index, or `undefined` to answer with the failure
 */
function moveOn(
  job: DispatchJob,
  position: number,
  failure: { readonly failed: FailureClass | undefined; readonly detail: string | undefined },
  attempts: Attempt[]
): number | undefined {
  const { failed, detail } = failure
  const candidate = job.candidates[position]
  const nextPosition = nextFor(job.candidates, position, job, failed)
  const next = nextPosition === undefined ? undefined : job.candidates[nextPosition]
  if (candidate === undefined || next === undefined || failed === undefined) return undefined
  recordRouteFallback(routeKey(job.alias, candidate))
  logUpstreamDetail(detail)
  logFallback(job.alias, { failed: candidate, next, failure: failed, attempt: attempts.length + 1 })
  attempts.push({ ...attemptOf(candidate), reason: failed })
  return nextPosition
}

/** How one tried candidate ended: the response to send, or the next candidate to try. */
type TriedCandidate = { readonly response: Response } | { readonly next: number }

/**
 * Tries one candidate: calls it, records its cooldown and totals, and either answers or moves on.
 *
 * @param honoContext - the request's Hono context
 * @param job - the route
 * @param position - the candidate's index
 * @param attempts - the attempts so far; a failure the request moves on from is added
 * @returns the response, or the next candidate's index
 */
async function tryCandidate(
  honoContext: ProxyContext,
  job: DispatchJob,
  position: number,
  attempts: Attempt[]
): Promise<TriedCandidate> {
  const candidate = job.candidates[position]
  if (candidate === undefined) throw new Error('A chat route has at least one candidate')
  // A request with its own upstream key isn't using the proxy's login, so its 429s and successes
  // say nothing about the login other clients share (#181 review).
  const sharedLogin = job.options.upstreamApiKey === undefined
  const sentAt = Date.now()
  const key = routeKey(job.alias, candidate)
  job.active.attempt(candidate.canonicalId, attempts.length + 1)
  recordRouteAttempt(key)
  const { outcome, captured } = await runAttempt(honoContext, candidate, job, {
    checkFirst: position > 0,
    attempt: attempts.length + 1
  })
  if (outcome.kind === 'final') return { response: outcome.response }
  if (outcome.kind === 'answered') {
    if (sharedLogin) clearCooldowns(loginSubject(candidate), sentAt)
    return { response: answerWith(outcome.respond, candidate, job, attempts) }
  }
  const failed = failureClass(outcome.answer)
  recordRouteFailure(key, failed)
  if (sharedLogin) recordCooldown(candidate, failed, captured)
  const next = moveOn(job, position, { failed, detail: outcome.detail }, attempts)
  if (next !== undefined) return { next }
  outcome.report()
  return { response: honoContext.json(outcome.answer.body, outcome.answer.status) }
}

/**
 * Runs the request on its candidates in turn and answers with the first that accepts it.
 *
 * @param honoContext - the request's Hono context
 * @param job - the candidates, fallback classes, pi context, request and call options
 * @returns the answer, or the failure the client gets
 */
export async function dispatchChat(honoContext: ProxyContext, job: DispatchJob): Promise<Response> {
  const attempts = [...job.attempts]
  let position = 0
  while (position < job.candidates.length) {
    if (skipsCandidate(job, position, attempts)) {
      position += 1
      continue
    }
    const tried = await tryCandidate(honoContext, job, position, attempts)
    if ('response' in tried) return tried.response
    position = tried.next
  }
  throw new Error('A chat route has at least one candidate')
}
