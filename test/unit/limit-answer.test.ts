import { limitAnswer, mapUpstreamError, USAGE_LIMIT_MIN_WAIT_MS } from '@proxy/server/errors'
import { describe, expect, test } from 'vite-plus/test'

describe('limitAnswer (#199)', () => {
  const rateLimited = mapUpstreamError(new Error('429 Too Many Requests'))
  const usageLimited = mapUpstreamError(new Error('You have hit your ChatGPT usage limit.'))

  // Catches a short limit sent without the wait the provider gave (the client retries in its own
  // backoff, too soon), or with the seconds rounded down to a wait that ends early.
  test('a rate limit with a known wait says when to retry, rounded up', () => {
    expect(limitAnswer(rateLimited, 29_500)).toEqual({
      answer: rateLimited,
      headers: { 'retry-after': '30', 'retry-after-ms': '29500' }
    })
  })

  // Catches a header made up when the provider said nothing.
  test('a rate limit with no known wait has no retry headers', () => {
    expect(limitAnswer(rateLimited, undefined)).toEqual({ answer: rateLimited, headers: {} })
  })

  // Catches the boundary drifting: a wait just under it is a rate limit, at it a usage limit,
  // which tells the SDKs not to retry and sends no wait of hours for a client to sit out.
  test('a wait of at least the threshold is a usage limit, with x-should-retry: false', () => {
    expect(limitAnswer(rateLimited, USAGE_LIMIT_MIN_WAIT_MS - 1).answer).toBe(rateLimited)
    expect(limitAnswer(rateLimited, USAGE_LIMIT_MIN_WAIT_MS)).toEqual({
      answer: usageLimited,
      headers: { 'x-should-retry': 'false' }
    })
  })

  // Catches a usage limit recognized by its words answered with a retry wait, or as a rate limit,
  // when it says no time.
  test('a usage limit by its words is one whatever the wait', () => {
    expect(limitAnswer(usageLimited, 10_000)).toEqual({
      answer: usageLimited,
      headers: { 'x-should-retry': 'false' }
    })
    expect(limitAnswer(usageLimited, undefined).headers).toEqual({ 'x-should-retry': 'false' })
  })

  // Catches retry headers on a failure that is not a limit.
  test('any other failure is unchanged, with no headers', () => {
    const outage = mapUpstreamError(new Error('503: down'))
    expect(limitAnswer(outage, 60_000)).toEqual({ answer: outage, headers: {} })
  })
})
