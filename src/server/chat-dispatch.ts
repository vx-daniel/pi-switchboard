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
import type { FailureClass } from '@proxy/config/schema'
import { proxyLogger } from '@proxy/logging'
import type { ConversionSuccess } from '@proxy/openai/messages'
import type { ExposedModel } from '@proxy/openai/model-exposure'
import { type Attempt, buildChatCompletion, type ResponseRoute } from '@proxy/openai/responses'
import type { ChatCompletionRequest } from '@proxy/openai/schemas'
import { streamToSSE } from '@proxy/openai/sse'
import { type CompletionOptions, piComplete, piStream } from '@proxy/pi/complete'
import { clearCooldowns } from '@proxy/pi/cooldowns'
import { getRequestAuth } from '@proxy/pi/registry'
import type { FailedResponse } from '@proxy/pi/reset-time'
import {
  authenticationError,
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
import { cooldownSkip, recordCooldown } from '@proxy/server/route-cooldowns'
import {
  recordRouteAttempt,
  recordRouteFailure,
  recordRouteFallback,
  recordRouteUsage,
  type RouteKey
} from '@proxy/server/route-totals'
import type { ProxyEnv } from '@proxy/server/types'
import type { Context } from 'hono'
import { stream as honoStream } from 'hono/streaming'

/** Logger for chat requests: the same category as the chat route's. */
const chatLogger = proxyLogger('server', 'chat')

/** The Hono context a route handler gets. */
type ProxyContext = Context<ProxyEnv>
/** A pi `Context`: system prompt, messages and tools. */
type PiContext = ConversionSuccess['context']

/** An answer the client gets when a call fails: a mapped upstream error, or the 401 for no credential. */
export interface FailedAnswer {
  readonly status: MappedUpstreamError['status'] | typeof HTTP_UNAUTHORIZED
  readonly body: OpenAIError
}

/**
 * Each failed answer's class, by status. A 400 is the request's own fault, so it has none: another
 * model is not the answer to it. A 502 is `upstream_error` unless its code says the credential
 * failed ({@link failureClass}).
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

/**
 * Classifies a failed answer for an alias's `fallbackOn` (#67).
 *
 * @param answer - what the client would get for the failure
 * @returns the failure class, or `undefined` for one that never falls back (a 400)
 */
export function failureClass(answer: FailedAnswer): FailureClass | undefined {
  if (answer.status === HTTP_BAD_GATEWAY && answer.body.error.code === 'upstream_auth_error') {
    return 'auth'
  }
  return FAILURE_BY_STATUS[answer.status]
}

/**
 * Names the route an attempt runs on, for its totals (#70).
 *
 * @param alias - the alias the request named, or `undefined`
 * @param candidate - the model the attempt goes to
 * @returns the alias (`null` for none), the provider and the canonical model ID
 */
function routeKey(alias: string | undefined, candidate: ExposedModel): RouteKey {
  return { alias: alias ?? null, provider: candidate.model.provider, model: candidate.canonicalId }
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
 * history too long for the model), so its line is a warning; any other failure is an error. The
 * level follows the mapped status on purpose: mapping decides whose fault a failure is (a
 * credential problem a provider answers with 400 maps to a 502, so it stays an error), and any
 * future mapping to 400 is a client error too. The raw upstream `detail` stays at debug
 * ({@link logUpstreamDetail}). The request's IDs come from the logging context.
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
  if (mapped.status === HTTP_BAD_REQUEST) {
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
 * the request is refused early instead of letting the provider fail later with a less actionable
 * error.
 *
 * @param model - the pi model
 * @param upstreamApiKey - the `X-Switchboard-Upstream-Api-Key` value, or `undefined` when not sent
 * @returns the 401 answer when no upstream auth is available, else `undefined`
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
  return {
    status: HTTP_UNAUTHORIZED,
    body: authenticationError(
      `Could not resolve request auth for provider '${model.provider}'. ${requestAuth.error}. ` +
        "Configure credentials via 'pi /login' or pass X-Switchboard-Upstream-Api-Key header."
    )
  }
}

/** The models a request may run on, in order, and the failures that move between them. */
export interface ChatRoute {
  readonly candidates: readonly ExposedModel[]
  readonly fallbackOn: ReadonlySet<FailureClass>
}

/**
 * Says whether a request carries an image.
 *
 * @param request - the validated request
 * @returns whether any message has an `image_url` part
 */
function hasImage(request: ChatCompletionRequest): boolean {
  return request.messages.some(
    (message) =>
      Array.isArray(message.content) && message.content.some((part) => part.type === 'image_url')
  )
}

/**
 * Plans the models a request may run on: the resolved model alone, or an alias's chain.
 *
 * @remarks
 * An image request skips the chain's text-only models when another one takes images; with none,
 * the request goes to the first candidate as it always has. A per-request upstream key keeps the
 * first candidate only (see the module notes).
 *
 * @param resolved - the exposed model or alias the request named
 * @param request - the validated request
 * @param upstreamApiKey - the `X-Switchboard-Upstream-Api-Key` value, or `undefined`
 * @returns the candidates, never empty, and the failures that move between them
 */
export function planRoute(
  resolved: ExposedModel,
  request: ChatCompletionRequest,
  upstreamApiKey: string | undefined
): ChatRoute {
  const chain = resolved.route
  if (chain === undefined) return { candidates: [resolved], fallbackOn: new Set() }
  const [first] = chain.candidates
  if (upstreamApiKey !== undefined && first !== undefined) {
    chatLogger.debug('No fallback for {alias}: the request carries its own upstream key', {
      alias: resolved.alias
    })
    return { candidates: [first], fallbackOn: new Set() }
  }
  const imageCapable = chain.candidates.filter((candidate) =>
    candidate.model.input.includes('image')
  )
  const skipTextOnly = hasImage(request) && imageCapable.length > 0
  if (skipTextOnly && imageCapable.length < chain.candidates.length) {
    chatLogger.debug('Skipping {skippedCount} text-only models of {alias} for an image request', {
      alias: resolved.alias,
      skippedCount: chain.candidates.length - imageCapable.length
    })
  }
  return {
    candidates: skipTextOnly ? imageCapable : chain.candidates,
    fallbackOn: new Set(chain.fallbackOn)
  }
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
 * Logs one failed attempt the chain moves on from.
 *
 * @param alias - the alias whose chain it is
 * @param hop - the model that failed, the next one, the class and the attempt number
 */
function logFallback(alias: string | undefined, hop: FallbackHop): void {
  chatLogger.warn('Alias {alias}: {model} failed ({failure}); trying {nextModel}', {
    alias,
    model: hop.failed.canonicalId,
    failure: hop.failure,
    nextModel: hop.next.canonicalId,
    attempt: hop.attempt
  })
}

/** Where the chain starts: the first candidate whose credential resolves, or the 401 answer. */
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
 * @returns the candidates from that one on, with the attempts skipped, or the last 401 answer
 */
export async function findCredentialedStart(
  route: ChatRoute,
  upstreamApiKey: string | undefined,
  alias: string | undefined
): Promise<CredentialedStart> {
  const attempts: Attempt[] = []
  for (const [position, candidate] of route.candidates.entries()) {
    if (skipCooling({ ...route, alias }, position, attempts)) continue
    const refused = await checkCredential(candidate.model, upstreamApiKey)
    if (refused === undefined) {
      return { kind: 'ready', candidates: route.candidates.slice(position), attempts }
    }
    // A refused credential is an attempt that failed `auth`, as `x_pi.attempts` lists it.
    const key = routeKey(alias, candidate)
    recordRouteAttempt(key)
    recordRouteFailure(key, failureClass(refused))
    const next = route.candidates[position + 1]
    if (next === undefined || !route.fallbackOn.has('auth')) {
      return { kind: 'refused', answer: refused }
    }
    recordRouteFallback(key)
    logFallback(alias, { failed: candidate, next, failure: 'auth', attempt: attempts.length + 1 })
    attempts.push({ model: candidate.canonicalId, reason: 'auth' })
  }
  throw new Error('A chat route has at least one candidate')
}

/** Everything a chat request needs to run on its candidates. */
export interface DispatchJob {
  readonly requestId: string
  /** The alias the request named (#66): reported as `x_pi.alias`. */
  readonly alias: string | undefined
  /** The candidates in order. The first one's credential was already checked. */
  readonly candidates: readonly ExposedModel[]
  readonly fallbackOn: ReadonlySet<FailureClass>
  /** Attempts already failed, before the first candidate (credential checks). */
  readonly attempts: readonly Attempt[]
  readonly context: PiContext
  readonly request: ChatCompletionRequest
  readonly options: CompletionOptions
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
 * @returns the outcome, logging the failure only if the client gets it
 */
function upstreamFailure(mapped: MappedUpstreamError, detail: string | undefined): AttemptOutcome {
  return {
    kind: 'failed',
    answer: mapped,
    detail,
    report: () => reportUpstreamFailure(mapped, detail)
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
 * Relays a started stream's events, counting a failure on the route for an `error` event the
 * client did not cause (#70): the attempt was answered, but the answer broke off.
 *
 * @param events - the stream's events, from its first
 * @param key - the attempt's route
 * @param signal - the client's disconnect signal
 * @returns a generator that yields every event unchanged
 */
async function* countingFailures(
  events: AsyncIterable<AssistantMessageEvent>,
  key: RouteKey,
  signal: AbortSignal | undefined
): AsyncGenerator<AssistantMessageEvent> {
  for await (const event of events) {
    if (event.type === 'error' && signal?.aborted !== true) {
      recordRouteFailure(key, failureClass(mapFailedCall(event.error)))
    }
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
  const { requestId, context, request, options } = job
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
    return upstreamFailure(mapUpstreamError(err), err instanceof Error ? err.message : undefined)
  }
  const { first, events } = started
  if (first.done !== true && first.value.type === 'error') {
    if (options.signal?.aborted === true) return clientLeft()
    const failed = first.value.error
    return upstreamFailure(mapFailedCall(failed), failed.errorMessage)
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
      let frameCount = 0
      try {
        for await (const frame of streamToSSE(
          countingFailures(startingWith(first, events), key, options.signal),
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
        if (options.signal?.aborted !== true) recordRouteFailure(key, failureClass(mapped))
        chatLogger.debug('Ending stream with an error event after {frameCount} frames', {
          frameCount,
          durationMs: Math.round(performance.now() - start)
        })
        await stream.write(`data: ${JSON.stringify(mapped.body)}\n\n`)
        await stream.write('data: [DONE]\n\n')
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
      return final(upstreamFailure(mapFailedCall(message), message.errorMessage))
    }
    return {
      kind: 'answered',
      respond: (route) => honoContext.json(buildChatCompletion(requestId, message, route))
    }
  } catch (err: unknown) {
    return final(
      upstreamFailure(mapUpstreamError(err), err instanceof Error ? err.message : undefined)
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
      }
    }
  }
  const outcome = await (job.request.stream === true
    ? attemptStream(honoContext, candidate, capturing)
    : attemptComplete(honoContext, candidate, capturing))
  return { outcome, captured }
}

/**
 * Skips a candidate while it cools down (#68), when the chain names its class: logs the skip and
 * lists it in `attempts`.
 *
 * @param chain - the candidates, the classes the alias names, and the alias
 * @param chain.candidates - the chain's candidates
 * @param chain.fallbackOn - the failure classes the alias names
 * @param chain.alias - the alias whose chain it is
 * @param position - the candidate's index in `chain.candidates`
 * @param attempts - the attempts so far; a skip is added to them
 * @returns whether the candidate is skipped
 */
function skipCooling(
  chain: Pick<ChatRoute, 'candidates' | 'fallbackOn'> & { alias: string | undefined },
  position: number,
  attempts: Attempt[]
): boolean {
  const cooldown = cooldownSkip(chain.candidates, position, chain.fallbackOn)
  const candidate = chain.candidates[position]
  if (cooldown === undefined || candidate === undefined) return false
  chatLogger.info('Alias {alias}: skipping {model}, cooling down after {reason} until {until}', {
    alias: chain.alias,
    model: candidate.canonicalId,
    reason: cooldown.reason,
    until: new Date(cooldown.until).toISOString(),
    scope: cooldown.scope
  })
  attempts.push({ model: candidate.canonicalId, reason: cooldown.reason, skipped: true })
  return true
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
    chatLogger.info('Alias {alias} answered by {model} after {failedCount} failed attempts', {
      alias: job.alias,
      model: candidate.canonicalId,
      failedCount: attempts.length,
      attempts
    })
  }
  return respond({
    model: candidate.canonicalId,
    ...(job.alias === undefined ? {} : { alias: job.alias }),
    attempts
  })
}

/**
 * Decides whether a failed attempt moves to the next candidate: only when there is one and the
 * alias's `fallbackOn` names the failure's class.
 *
 * @param answer - what the client would get for the failure
 * @param next - the next candidate, or `undefined` after the last
 * @param fallbackOn - the classes the alias names
 * @returns the class to move on for, or `undefined` to answer with the failure
 */
function fallbackFor(
  answer: FailedAnswer,
  next: ExposedModel | undefined,
  fallbackOn: ReadonlySet<FailureClass>
): FailureClass | undefined {
  const failure = failureClass(answer)
  return next !== undefined && failure !== undefined && fallbackOn.has(failure)
    ? failure
    : undefined
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
  // A request with its own upstream key isn't using the proxy's login, so its 429s and successes
  // say nothing about the login other clients share (#181 review).
  const sharedLogin = job.options.upstreamApiKey === undefined
  for (const [position, candidate] of job.candidates.entries()) {
    if (skipCooling(job, position, attempts)) continue
    const sentAt = Date.now()
    const key = routeKey(job.alias, candidate)
    recordRouteAttempt(key)
    const { outcome, captured } = await runAttempt(honoContext, candidate, job, {
      checkFirst: position > 0,
      attempt: attempts.length + 1
    })
    if (outcome.kind === 'final') return outcome.response
    if (outcome.kind === 'answered') {
      if (sharedLogin) clearCooldowns(candidate, sentAt)
      return answerWith(outcome.respond, candidate, job, attempts)
    }
    const failed = failureClass(outcome.answer)
    recordRouteFailure(key, failed)
    if (sharedLogin) recordCooldown(candidate, failed, captured)
    const next = job.candidates[position + 1]
    const failure = fallbackFor(outcome.answer, next, job.fallbackOn)
    if (failure === undefined || next === undefined) {
      outcome.report()
      return honoContext.json(outcome.answer.body, outcome.answer.status)
    }
    recordRouteFallback(key)
    logUpstreamDetail(outcome.detail)
    logFallback(job.alias, { failed: candidate, next, failure, attempt: attempts.length + 1 })
    attempts.push({ model: candidate.canonicalId, reason: failure })
  }
  throw new Error('A chat route has at least one candidate')
}
