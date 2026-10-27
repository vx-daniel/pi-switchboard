/**
 * Tests that a console listener which throws leaves its error message in a debug record (#250).
 *
 * @packageDocumentation
 */
import { resetSync } from '@logtape/logtape'
import { configureLogging } from '@proxy/logging'
import { beginActiveRequest, onActiveRequestsChange } from '@proxy/server/active-requests'
import { beginHttpRequest, onHttpRequestsChange } from '@proxy/server/http-requests'
import { onRouteTotalsChange, recordRouteAttempt } from '@proxy/server/route-totals'
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test'

/** The JSON Lines the logger wrote during one test. */
let lines: string[] = []

beforeEach(() => {
  lines = []
  configureLogging({ level: 'trace', format: 'json', write: (line) => lines.push(line) })
})

afterEach(() => {
  resetSync()
})

/**
 * Subscribes a listener that throws a recognisable message.
 *
 * @param subscribe - the registry's subscribe function
 * @returns the unsubscribe function
 */
function throwing(subscribe: (listener: () => void) => () => void): () => void {
  return subscribe(() => {
    throw new Error('listener detail 250')
  })
}

describe('a listener that throws (#250)', () => {
  // Catches the listener failure being logged by error name only, losing the message.
  test.each([
    [
      'active requests',
      onActiveRequestsChange,
      () => {
        beginActiveRequest({ requestId: 'r-250', alias: null, model: 'p/m', stream: false })
      }
    ],
    [
      'route totals',
      onRouteTotalsChange,
      () => {
        recordRouteAttempt({ alias: null, provider: 'p', model: 'p/m' })
      }
    ],
    [
      'HTTP requests',
      onHttpRequestsChange,
      () => {
        beginHttpRequest({ requestId: 'r-250', method: 'GET', path: '/v1/models' })
      }
    ]
  ])('the %s listener failure message reaches a debug record', (_name, subscribe, change) => {
    const unsubscribe = throwing(subscribe)
    try {
      change()
    } finally {
      unsubscribe()
    }
    const records = lines.map((line): unknown => JSON.parse(line))
    expect(records).toContainEqual(
      expect.objectContaining({
        level: 'DEBUG',
        properties: expect.objectContaining({ detail: 'listener detail 250' })
      })
    )
  })
})
