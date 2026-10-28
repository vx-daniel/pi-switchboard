/**
 * The console's lifecycle events (`src/server/console-events.ts`, #266): one order shared with the
 * HTTP requests, a bounded list, and listeners that can't break what recorded the event.
 */

import {
  type ConsoleEvent,
  consoleEvents,
  EVENTS_KEPT,
  onConsoleEventsChange,
  recordConsoleEvent
} from '@proxy/server/console-events'
import { beginHttpRequest, endHttpRequest } from '@proxy/server/http-requests'
import { describe, expect, test } from 'vite-plus/test'

/**
 * Reads the newest event.
 *
 * @returns it
 * @throws Error when there is none
 */
function newest(): ConsoleEvent {
  const last = consoleEvents().at(-1)
  if (last === undefined) throw new Error('no event recorded')
  return last
}

describe('console events', () => {
  // Catches events numbered apart from the requests: the table merges them by this order, and a
  // view pinned to a row stays on it whichever kind it is.
  test('share one order with the HTTP requests', () => {
    recordConsoleEvent('Listening on http://127.0.0.1:4141 with 0 models')
    const before = newest().sequence
    const request = beginHttpRequest({ requestId: 'piproxy-x', method: 'GET', path: '/v1/models' })
    endHttpRequest(request, 200)
    recordConsoleEvent('Recording stats to /tmp/stats.sqlite')

    expect(request).toBeGreaterThan(before)
    expect(newest().sequence).toBeGreaterThan(request)
  })

  // Catches the list growing without end, or dropping the newest rather than the oldest.
  test('keeps the newest events up to the bound', () => {
    for (let eventNumber = 0; eventNumber < EVENTS_KEPT + 5; eventNumber += 1) {
      recordConsoleEvent(`event ${String(eventNumber)}`)
    }

    const kept = consoleEvents()
    expect(kept).toHaveLength(EVENTS_KEPT)
    expect(kept.at(-1)?.text).toBe(`event ${String(EVENTS_KEPT + 4)}`)
  })

  // Catches a throwing listener failing whatever recorded the event, or keeping the others from
  // hearing of it.
  test('a listener that throws neither fails the event nor silences the others', () => {
    const heard: string[] = []
    const stopThrowing = onConsoleEventsChange(() => {
      throw new Error('listener failed')
    })
    const stopHearing = onConsoleEventsChange(() => heard.push(newest().text))

    expect(() => recordConsoleEvent('Restarting on 127.0.0.1:4142', 'info')).not.toThrow()
    expect(heard).toEqual(['Restarting on 127.0.0.1:4142'])
    stopThrowing()
    stopHearing()
  })
})
