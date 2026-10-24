/**
 * Reading a provider's reset time from a failed response, and capturing that response (#68,
 * `src/pi/reset-time.ts`).
 */

import { capturingFetch, type FailedResponse, resetAfterMs } from '@proxy/pi/reset-time'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

/** A fixed clock: 2026-10-21T12:00:00Z. */
const NOW = Date.UTC(2026, 9, 21, 12, 0, 0)

/**
 * Builds a failed 429 with these headers and body.
 *
 * @param headers - the response headers
 * @param body - the response body
 * @returns the failed response
 */
function failed(headers: Record<string, string>, body = ''): Parameters<typeof resetAfterMs>[0] {
  return { status: 429, headers: new Headers(headers), body }
}

describe('resetAfterMs', () => {
  // Catches a provider's stated reset time misread, so a chain skips a provider for the wrong
  // length: too short retries a limit that still holds, too long wastes a working login.
  test.each([
    ['retry-after in seconds', failed({ 'retry-after': '30' }), 30_000],
    ['retry-after as a date', failed({ 'retry-after': 'Wed, 21 Oct 2026 12:02:00 GMT' }), 120_000],
    ['retry-after-ms', failed({ 'retry-after-ms': '1500' }), 1500],
    [
      'Codex resets_in_seconds',
      failed({}, '{"error":{"type":"usage_limit_reached","resets_in_seconds":3600}}'),
      3_600_000
    ],
    [
      'Codex resets_at, Unix seconds',
      failed({}, `{"error":{"resets_at":${String(NOW / 1000 + 600)}}}`),
      600_000
    ],
    // A field of the wrong type reads as absent, not as a refusal of the body: the sibling counts.
    [
      'a wrong-typed field beside a valid one',
      failed({}, '{"error":{"resets_in_seconds":"soon","retry_after":30}}'),
      30_000
    ],
    [
      'retry_after at the top level, with `error` not an object',
      failed({}, '{"error":"rate limited","retry_after":90}'),
      90_000
    ],
    [
      "OpenAI's reset headers, the later one",
      failed({ 'x-ratelimit-reset-requests': '6m0s', 'x-ratelimit-reset-tokens': '1s' }),
      360_000
    ],
    [
      "Anthropic's reset header, a timestamp",
      failed({ 'anthropic-ratelimit-requests-reset': '2026-10-21T12:05:00Z' }),
      300_000
    ],
    // A bucket with room is passed over (fourth #181 review): its reset isn't what the 429 waits on.
    [
      "OpenAI's reset headers, only the empty bucket's",
      failed({
        'x-ratelimit-reset-requests': '6m0s',
        'x-ratelimit-remaining-requests': '12',
        'x-ratelimit-reset-tokens': '1s',
        'x-ratelimit-remaining-tokens': '0'
      }),
      1000
    ],
    [
      "Anthropic's reset headers, only the empty bucket's",
      failed({
        'anthropic-ratelimit-requests-reset': '2026-10-21T12:05:00Z',
        'anthropic-ratelimit-requests-remaining': '0',
        'anthropic-ratelimit-tokens-reset': '2026-10-21T13:00:00Z',
        'anthropic-ratelimit-tokens-remaining': '40000'
      }),
      300_000
    ],
    [
      'the message, in short units',
      failed({}, '{"error":{"message":"Rate limit reached. Please try again in 20s."}}'),
      20_000
    ],
    [
      'the message, in words',
      failed({}, 'Limit reached; try again in 1 hour 2 minutes.'),
      3_720_000
    ],
    ['the message, in days', failed({}, 'Your weekly limit resets in 3 days 4 hours'), 273_600_000]
  ])('%s', (_case, response, expected) => {
    expect(resetAfterMs(response, NOW)).toBe(expected)
  })

  // Catches the standard header losing to a guess from the message: retry-after is the provider's
  // own instruction, so it wins.
  test('retry-after wins over the body', () => {
    const response = failed({ 'retry-after': '5' }, 'try again in 2 hours')

    expect(resetAfterMs(response, NOW)).toBe(5000)
  })

  // Catches a zero or past retry-after hiding the time the body gives, which would cool the
  // provider for the 60 s default instead (#181 review).
  test.each([
    [
      'retry-after: 0',
      failed({ 'retry-after': '0' }, '{"error":{"resets_in_seconds":90}}'),
      90_000
    ],
    [
      'a past retry-after date',
      failed({
        'retry-after': 'Wed, 21 Oct 2026 11:00:00 GMT',
        'x-ratelimit-reset-requests': '2m'
      }),
      120_000
    ],
    // `retry-after-ms` is checked as strictly as `retry-after` (third #181 review).
    ['retry-after-ms: 5abc', failed({ 'retry-after-ms': '5abc', 'retry-after': '30' }), 30_000],
    ['retry-after-ms: -5', failed({ 'retry-after-ms': '-5', 'retry-after': '30' }), 30_000],
    ['retry-after-ms: 0', failed({ 'retry-after-ms': '0', 'retry-after': '30' }), 30_000],
    // A wait past what a Date can hold made toISOString throw on every skip (fifth #181 review).
    [
      'a retry-after past the last representable date',
      failed({ 'retry-after': '99999999999999999999' }, '{"error":{"resets_in_seconds":90}}'),
      90_000
    ]
  ])('%s falls through to the next source', (_case, response, expected) => {
    expect(resetAfterMs(response, NOW)).toBe(expected)
  })

  // Catches a reset time in epoch milliseconds read as seconds (#181 review): with no cap, that
  // is a wait of about 50,000 years, and the provider stays cooled until a restart.
  test.each([
    ['in a body', failed({}, `{"error":{"resets_at":${String(NOW + 600_000)}}}`)],
    ['in a reset header', failed({ 'x-ratelimit-reset': String(NOW + 600_000) })]
  ])('a Unix time in milliseconds %s', (_case, response) => {
    expect(resetAfterMs(response, NOW)).toBe(600_000)
  })

  // Catches a made-up wait when the response gives none, or a past time read as a wait: the
  // cooldown then uses its growing default.
  test.each([
    ['no time anywhere', failed({}, '{"error":{"message":"Too many requests"}}')],
    [
      'only a wait past the last representable date',
      failed({}, '{"error":{"resets_in_seconds":1e13}}')
    ],
    // V8's Date.parse reads this as 1 December 2030 (#181 review).
    ['text that is not a date', failed({ 'retry-after': 'Dec 2030' })],
    ['a reset time already past', failed({ 'retry-after': 'Wed, 21 Oct 2026 11:00:00 GMT' })],
    ['a number in the message that is not a wait', failed({}, 'Request 42 failed')]
  ])('%s gives none', (_case, response) => {
    expect(resetAfterMs(response, NOW)).toBeUndefined()
  })
})

describe('capturingFetch', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  /**
   * Wraps a `fetch` that answers `response`, recording what the wrapper captures.
   *
   * @param response - the response the wrapped `fetch` gives
   * @returns the wrapped `fetch` and the captured responses
   */
  function wrapped(response: Response): {
    fetch: typeof globalThis.fetch
    captured: FailedResponse[]
  } {
    const captured: FailedResponse[] = []
    const fetch = capturingFetch(
      (failure) => {
        captured.push(failure)
      },
      async () => response
    )
    return { fetch, captured }
  }

  // Catches pi held up by an error body that never ends (#181 review): after 2 s the wrapper
  // keeps what arrived and hands pi the response, whose own body is still readable.
  test('stops reading a body that never ends, and leaves the original to pi', async () => {
    vi.useFakeTimers()
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"error":'))
      }
    })
    const { fetch, captured } = wrapped(new Response(stalled, { status: 429 }))

    const pending = fetch('https://example.com')
    await vi.advanceTimersByTimeAsync(2000)
    const response = await pending

    expect(captured).toMatchObject([{ status: 429, body: '{"error":' }])
    const first = await response.body?.getReader().read()
    expect(new TextDecoder().decode(first?.value)).toBe('{"error":')
  })

  // Catches a huge error body read whole into memory: only the first 16 KiB is kept.
  test('keeps at most the first 16,384 characters', async () => {
    const { fetch, captured } = wrapped(new Response('x'.repeat(100_000), { status: 503 }))

    await fetch('https://example.com')

    expect(captured[0]?.body).toHaveLength(16_384)
  })

  // Catches a failure with no body breaking the wrapper: it is captured with an empty body.
  test('captures a failure with no body', async () => {
    const { fetch, captured } = wrapped(new Response(null, { status: 429 }))

    await fetch('https://example.com')

    expect(captured).toMatchObject([{ status: 429, body: '' }])
  })

  // Catches a success cloned and read, which would buffer every streamed answer.
  test('leaves a success alone', async () => {
    const { fetch, captured } = wrapped(new Response('ok', { status: 200 }))

    expect(await (await fetch('https://example.com')).text()).toBe('ok')
    expect(captured).toEqual([])
  })
})
