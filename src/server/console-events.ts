/**
 * The proxy's lifecycle events, in memory, for the console's Requests table (#266): where it
 * listens, whether it records stats, logins added and removed, a restart. The table shows them as
 * quiet rows among the requests, in the order things happened.
 *
 * @remarks
 * Events and requests share one order ({@link takeSequence}): a request's place in it
 * (`http-requests.ts`) and an event's are numbers from the same counter, so the table merges them
 * by it, and a view pinned to a row stays on it whichever kind it is. A leaf module, so any part
 * of the proxy can record an event without an import cycle. An event's text is the proxy's own
 * wording, with names and addresses, never a credential. No HTTP route serves this.
 *
 * @packageDocumentation
 */

import { proxyLogger } from '@proxy/logging'

/** The most events kept: a lifecycle is a handful; a burst of logins can't grow it without end. */
export const EVENTS_KEPT = 100

/** Logger for a listener that throws. */
const eventsLogger = proxyLogger('server')

/** How much an event matters: shown dim, or in the warning or error color. */
export type ConsoleEventLevel = 'info' | 'warning' | 'error'

/** One lifecycle event. */
export interface ConsoleEvent {
  /** Its place in the order shared with the requests. */
  readonly sequence: number
  /** When it happened, in milliseconds since the epoch. */
  readonly at: number
  readonly level: ConsoleEventLevel
  /** What happened: `Listening on http://127.0.0.1:4141 with 58 models`. */
  readonly text: string
}

/** The events kept, oldest first. */
const events: ConsoleEvent[] = []
/** The next place in the order. */
let nextSequence = 0
/** Who is told after each event. */
const listeners = new Set<() => void>()

/**
 * Takes the next place in the order the Requests table shows its rows in.
 *
 * @returns the place
 */
export function takeSequence(): number {
  const sequence = nextSequence
  nextSequence += 1
  return sequence
}

/**
 * Records an event, dropping the oldest past {@link EVENTS_KEPT}, and tells the listeners. A
 * listener that throws is logged and skipped: what caused the event must not fail for it.
 *
 * @param text - what happened
 * @param level - how much it matters; `info` by default
 * @param now - when; now by default
 */
export function recordConsoleEvent(
  text: string,
  level: ConsoleEventLevel = 'info',
  now: number = Date.now()
): void {
  events.push({ sequence: takeSequence(), at: now, level, text })
  if (events.length > EVENTS_KEPT) events.shift()
  for (const listener of listeners) {
    try {
      listener()
    } catch (error) {
      eventsLogger.warn('A console events listener threw: {errorName}', {
        errorName: error instanceof Error ? error.name : typeof error
      })
    }
  }
}

/**
 * Returns a snapshot of the events kept.
 *
 * @returns them, oldest first
 */
export function consoleEvents(): readonly ConsoleEvent[] {
  return [...events]
}

/**
 * Subscribes to new events.
 *
 * @param listener - called after each one
 * @returns a function that unsubscribes
 */
export function onConsoleEventsChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
