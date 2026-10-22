/**
 * The chat requests in flight now, in memory, for the terminal console's sidebar (#61).
 *
 * @remarks
 * The chat dispatcher (`chat-dispatch.ts`) adds a request when it starts on its chain, names the
 * model each attempt goes to, and removes the request when it ends: for a non-streamed request when
 * the dispatch returns, for a streamed one when the stream closes (finished, failed, or the client
 * left). No HTTP route serves this.
 *
 * An entry holds the request's ID, the route and timings, never message content, the request's
 * `user`, or a credential.
 *
 * @packageDocumentation
 */

import { proxyLogger } from '@proxy/logging'

/** Logger for a listener that throws: the chat route's category, as the dispatcher records here. */
const activeLogger = proxyLogger('server', 'chat')

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
  /** `waiting` until the model answers, `streaming` while a stream is relayed. */
  readonly phase: 'waiting' | 'streaming'
  /** When the dispatch started, in milliseconds since the epoch. */
  readonly startedAt: number
}

/** What a request starts with. */
export type ActiveRequestStart = Pick<ActiveRequest, 'requestId' | 'alias' | 'model' | 'stream'>

/** The dispatcher's handle on one request in flight. */
export interface ActiveRequestHandle {
  /**
   * Names the model the next attempt goes to.
   *
   * @param model - its canonical ID
   * @param attempt - the attempt's number, from 1
   */
  attempt(model: string, attempt: number): void
  /** Marks the request as relaying its stream: {@link ActiveRequestHandle.settled} keeps it. */
  streaming(): void
  /** Removes the request; a second call does nothing. */
  end(): void
  /** The dispatch returned: removes the request, unless its stream is still being relayed. */
  settled(): void
}

/** The requests in flight, by a key of their own: two requests can share a client's request ID. */
const requests = new Map<number, ActiveRequest>()
/** Who is told after each change. */
const listeners = new Set<() => void>()
/** The next request's key. */
let nextKey = 0

/**
 * Tells every listener the requests changed. A listener that throws is logged and skipped: the
 * request that caused the change must not fail for it.
 */
function notify(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch (error) {
      activeLogger.warn('An active requests listener threw: {errorName}', {
        errorName: error instanceof Error ? error.name : typeof error
      })
    }
  }
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
  requests.set(key, { ...start, attempt: 1, phase: 'waiting', startedAt: now })
  notify()
  /**
   * Replaces fields of the request while it is still in flight.
   *
   * @param fields - the new values
   */
  const update = (fields: Partial<Pick<ActiveRequest, 'model' | 'attempt' | 'phase'>>): void => {
    const current = requests.get(key)
    if (current === undefined) return
    requests.set(key, { ...current, ...fields })
    notify()
  }
  return {
    attempt: (model, attempt) => update({ model, attempt, phase: 'waiting' }),
    streaming: () => update({ phase: 'streaming' }),
    end: () => {
      if (requests.delete(key)) notify()
    },
    settled: () => {
      if (requests.get(key)?.phase !== 'streaming' && requests.delete(key)) notify()
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
 * Subscribes to changes.
 *
 * @param listener - called after every change, with no arguments; read {@link activeRequests}
 * @returns a function that unsubscribes the listener
 */
export function onActiveRequestsChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
