/**
 * The chat requests in flight now, and the latest ones that finished, in memory, for the terminal
 * console's sidebar (#61).
 *
 * @remarks
 * The chat route adds a request before it dispatches; the dispatcher (`chat-dispatch.ts`) names
 * the model each attempt goes to and marks a stream's first event. The request ends, with how it
 * ended, when the dispatch returns or, for a stream, when the stream closes (finished, failed, or
 * the client left). A chat request answered before the dispatch is recorded as rejected, by
 * `rejectedChatMiddleware` (#214). The last {@link FINISHED_KEPT} finished requests that reached a
 * model are kept, and apart from them the last {@link REJECTED_KEPT} rejected ones, oldest dropped
 * first, so a flood of rejected requests can't push out the others. No HTTP route serves this.
 *
 * An entry holds the request's ID, the route and timings, never message content, the request's
 * `user`, or a credential.
 *
 * @packageDocumentation
 */

import { proxyLogger } from '@proxy/logging'
import { errorMessage } from '@proxy/utils/guards'

/** Logger for a listener that throws: the chat route's category, as the dispatcher records here. */
const activeLogger = proxyLogger('server', 'chat')

/** How many finished requests that reached a model are kept: a minute's rate on a busy proxy. */
export const FINISHED_KEPT = 500
/**
 * How many rejected requests are kept, apart from the others: a flood of them (anyone who can
 * reach the port can send one without a token) must not push out the requests that reached a
 * model.
 */
export const REJECTED_KEPT = 100

/**
 * How a request ended: answered, failed (an error answer or a failed stream), the client left, or
 * rejected (answered before the proxy called a model: auth, size, validation, an unknown model, a
 * credential pi can't resolve, a remote image or a message it can't convert).
 */
export type RequestOutcome = 'ok' | 'failed' | 'left' | 'rejected'

/** One chat request in flight. */
export interface ActiveRequest {
  /** The proxy's request ID (`X-Request-Id`). */
  readonly requestId: string
  /** The alias the request named, or `null` for a request that named a model. */
  readonly alias: string | null
  /** The canonical `provider/model-id` the current attempt goes to. */
  readonly model: string
  /** The current attempt's number, from 1. */
  readonly attempt: number
  /** Whether the client asked for a stream. */
  readonly stream: boolean
  /**
   * Whether the request sent a `prompt_cache_key` (#299): the stats count these, never the key,
   * which can be a conversation ID the client chose.
   */
  readonly promptCacheKey: boolean
  /** When the dispatch started, in milliseconds since the epoch. */
  readonly startedAt: number
  /** When a stream's first event arrived; `undefined` until then, and for a plain request. */
  readonly firstEventAt: number | undefined
}

/**
 * One request that finished. A rejected one never reached a model: its `model` is the one the
 * request named (`''` when the proxy did not read that far), its `attempt` is 0, it never
 * streamed, and it counts as sending no `prompt_cache_key`.
 */
export interface FinishedRequest extends ActiveRequest {
  readonly outcome: RequestOutcome
  /** When it ended, in milliseconds since the epoch. */
  readonly endedAt: number
  /** The HTTP status a rejected request was answered with; `undefined` for any other. */
  readonly status: number | undefined
}

/** What a rejected request is recorded with. */
export interface RejectedRequest {
  readonly requestId: string
  /** The model the request named, or `undefined` when the proxy did not read that far. */
  readonly model: string | undefined
  /** The HTTP status it was answered with. */
  readonly status: number
  /** When it arrived, in milliseconds since the epoch. */
  readonly startedAt: number
}

/** What a request starts with. */
export type ActiveRequestStart = Pick<
  ActiveRequest,
  'requestId' | 'alias' | 'model' | 'stream' | 'promptCacheKey'
>

/** The dispatcher's handle on one request in flight. */
export interface ActiveRequestHandle {
  /**
   * Names the model the next attempt goes to.
   *
   * @param model - its canonical ID
   * @param attempt - the attempt's number, from 1
   */
  attempt(model: string, attempt: number): void
  /**
   * Marks the stream's first event: the request is relaying its stream, which
   * {@link ActiveRequestHandle.settled} leaves to {@link ActiveRequestHandle.end}.
   *
   * @param now - the current time; `Date.now()` by default
   */
  streaming(now?: number): void
  /**
   * Ends the request; a second call does nothing.
   *
   * @param outcome - how it ended
   * @param now - the current time; `Date.now()` by default
   */
  end(outcome: RequestOutcome, now?: number): void
  /**
   * The dispatch returned: ends the request, unless its stream is still being relayed.
   *
   * @param outcome - how it ended, if it did
   * @param now - the current time; `Date.now()` by default
   */
  settled(outcome: RequestOutcome, now?: number): void
}

/** The requests in flight, by a key of their own: two requests can share a client's request ID. */
const requests = new Map<number, ActiveRequest>()
/**
 * A finished request as kept, with the order it finished in: many finish within one millisecond,
 * so `endedAt` alone can't order the two lists below into one.
 */
interface Kept {
  readonly sequence: number
  readonly request: FinishedRequest
}
/** The finished requests that reached a model, oldest first, at most {@link FINISHED_KEPT}. */
const finished: Kept[] = []
/** The rejected requests, oldest first, at most {@link REJECTED_KEPT}. */
const rejectedKept: Kept[] = []
/** The next finished request's place in the order. */
let nextSequence = 0
/** Who is told after each change; with the request, when the change is one finishing. */
const listeners = new Set<(finishedRequest: FinishedRequest | undefined) => void>()
/** The next request's key. */
let nextKey = 0

/**
 * Tells every listener the requests changed. A listener that throws is logged and skipped: the
 * request that caused the change must not fail for it.
 *
 * @param finishedRequest - the request that just finished, when that is the change
 */
function notify(finishedRequest?: FinishedRequest): void {
  for (const listener of listeners) {
    try {
      listener(finishedRequest)
    } catch (error) {
      activeLogger.warn('An active requests listener threw: {errorName}', {
        errorName: error instanceof Error ? error.name : typeof error
      })
      activeLogger.debug('Active requests listener failure detail: {detail}', {
        detail: errorMessage(error)
      })
    }
  }
}

/**
 * Names how a request ended.
 *
 * @param failed - whether its answer was an error, or its stream failed
 * @param signal - the client's disconnect signal; aborted, the client left, whatever the answer
 * @returns the outcome
 */
export function requestOutcome(failed: boolean, signal: AbortSignal | undefined): RequestOutcome {
  if (signal?.aborted === true) return 'left'
  return failed ? 'failed' : 'ok'
}

/**
 * Keeps a finished request, dropping the oldest of its kind past its bound
 * ({@link FINISHED_KEPT}, or {@link REJECTED_KEPT} for a rejected one), and tells the listeners.
 *
 * @param request - the request
 */
function keep(request: FinishedRequest): void {
  const [kept, bound] =
    request.outcome === 'rejected' ? [rejectedKept, REJECTED_KEPT] : [finished, FINISHED_KEPT]
  kept.push({ sequence: nextSequence, request })
  nextSequence += 1
  if (kept.length > bound) kept.shift()
  notify(request)
}

/**
 * Moves a request from in flight to finished.
 *
 * @param key - its key
 * @param outcome - how it ended
 * @param now - when
 */
function finish(key: number, outcome: RequestOutcome, now: number): void {
  const request = requests.get(key)
  if (request === undefined) return
  requests.delete(key)
  keep({ ...request, outcome, endedAt: now, status: undefined })
}

/**
 * Records a chat request the proxy answered without calling a model.
 *
 * @param rejected - its ID, the model it named, its status and when it arrived
 * @param now - when it was answered; `Date.now()` by default
 */
export function recordRejectedRequest(rejected: RejectedRequest, now: number = Date.now()): void {
  keep({
    requestId: rejected.requestId,
    alias: null,
    model: rejected.model ?? '',
    attempt: 0,
    stream: false,
    promptCacheKey: false,
    startedAt: rejected.startedAt,
    firstEventAt: undefined,
    outcome: 'rejected',
    endedAt: now,
    status: rejected.status
  })
}

/**
 * Adds a request, before its first attempt.
 *
 * @param start - its ID, alias, the model its chain starts on, and whether it streams
 * @param now - the current time; `Date.now()` by default
 * @returns the handle the dispatcher updates and ends it with
 */
export function beginActiveRequest(
  start: ActiveRequestStart,
  now: number = Date.now()
): ActiveRequestHandle {
  const key = nextKey
  nextKey += 1
  requests.set(key, { ...start, attempt: 1, startedAt: now, firstEventAt: undefined })
  notify()
  /**
   * Replaces fields of the request while it is still in flight.
   *
   * @param fields - the new values
   */
  const update = (
    fields: Partial<Pick<ActiveRequest, 'model' | 'attempt' | 'firstEventAt'>>
  ): void => {
    const current = requests.get(key)
    if (current === undefined) return
    requests.set(key, { ...current, ...fields })
    notify()
  }
  return {
    attempt: (model, attempt) => update({ model, attempt }),
    streaming: (at = Date.now()) => update({ firstEventAt: at }),
    end: (outcome, at = Date.now()) => finish(key, outcome, at),
    settled: (outcome, at = Date.now()) => {
      if (requests.get(key)?.firstEventAt === undefined) finish(key, outcome, at)
    }
  }
}

/**
 * Returns a snapshot of the requests in flight.
 *
 * @returns them, oldest first
 */
export function activeRequests(): readonly ActiveRequest[] {
  return [...requests.values()].toSorted((left, right) => left.startedAt - right.startedAt)
}

/**
 * Returns a snapshot of the finished requests kept, rejected ones included.
 *
 * @returns them, newest first
 */
export function finishedRequests(): readonly FinishedRequest[] {
  return [...finished, ...rejectedKept]
    .toSorted((left, right) => right.sequence - left.sequence)
    .map((kept) => kept.request)
}

/**
 * Subscribes to changes.
 *
 * @param listener - called after every change, with the request when one finished (the stats
 *   recorder keeps those); read {@link activeRequests} and {@link finishedRequests}
 * @returns a function that unsubscribes the listener
 */
export function onActiveRequestsChange(
  listener: (finishedRequest: FinishedRequest | undefined) => void
): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
