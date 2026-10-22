import {
  activeRequests,
  beginActiveRequest,
  FINISHED_KEPT,
  finishedRequests,
  recordRejectedRequest,
  REJECTED_KEPT,
  requestOutcome
} from '@proxy/server/active-requests'
import { describe, expect, test } from 'vite-plus/test'

describe('the finished requests kept for the console', () => {
  // Catches memory that grows with every request a long-running proxy serves, or the newest
  // request dropped instead of the oldest.
  test('keeps the newest, up to the limit, newest first', () => {
    for (let requestIndex = 0; requestIndex <= FINISHED_KEPT; requestIndex += 1) {
      beginActiveRequest({
        requestId: `req-${String(requestIndex)}`,
        alias: null,
        model: 'alpha/model',
        stream: false
      }).end('ok')
    }

    const kept = finishedRequests()
    expect(kept).toHaveLength(FINISHED_KEPT)
    expect(kept[0]?.requestId).toBe(`req-${String(FINISHED_KEPT)}`)
    expect(kept.at(-1)?.requestId).toBe('req-1')
  })

  // Catches a request counted twice when both its stream and the dispatch end it.
  test('records a request once, however many times it is ended', () => {
    const before = finishedRequests()[0]
    const handle = beginActiveRequest({
      requestId: 'once',
      alias: null,
      model: 'alpha/model',
      stream: true
    })
    handle.streaming()
    handle.settled('ok')
    expect(finishedRequests()[0]).toBe(before)
    handle.end('failed')
    handle.settled('ok')

    expect(finishedRequests().filter((request) => request.requestId === 'once')).toEqual([
      expect.objectContaining({ outcome: 'failed' })
    ])
  })

  // Catches a streamed request left in ACTIVE for good when its relay never started: the dispatch
  // returning must end it, as it does a plain request.
  test('ends a streamed request whose relay never started when the dispatch returns', () => {
    const handle = beginActiveRequest({
      requestId: 'never-relayed',
      alias: null,
      model: 'alpha/model',
      stream: true
    })
    handle.settled('failed')

    expect(activeRequests()).toEqual([])
    expect(finishedRequests()[0]).toEqual(
      expect.objectContaining({ requestId: 'never-relayed', outcome: 'failed' })
    )
  })

  // Catches a flood of rejected requests (anyone who can reach the port can send them, no token
  // needed) pushing out the requests that reached a model, or growing without bound.
  test('keeps rejected requests apart, up to their own limit, newest first among all', () => {
    const served = beginActiveRequest({
      requestId: 'served',
      alias: null,
      model: 'alpha/model',
      stream: false
    })
    served.end('ok')
    for (let requestIndex = 0; requestIndex <= REJECTED_KEPT * 2; requestIndex += 1) {
      recordRejectedRequest({
        requestId: `junk-${String(requestIndex)}`,
        model: undefined,
        status: 401,
        startedAt: 0
      })
    }

    const kept = finishedRequests()
    expect(kept.filter((request) => request.outcome === 'rejected')).toHaveLength(REJECTED_KEPT)
    expect(kept[0]?.requestId).toBe(`junk-${String(REJECTED_KEPT * 2)}`)
    expect(kept.some((request) => request.requestId === 'served')).toBe(true)
  })

  // Catches a client that left counted as a failure, which would make a healthy upstream look
  // broken.
  test('names a client that left whatever its answer was', () => {
    const left = AbortSignal.abort()

    expect(requestOutcome(true, left)).toBe('left')
    expect(requestOutcome(false, left)).toBe('left')
    expect(requestOutcome(true, undefined)).toBe('failed')
    expect(requestOutcome(false, new AbortController().signal)).toBe('ok')
  })
})
