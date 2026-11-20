/**
 * Reading subscription quota from provider response headers (#69, `src/pi/quota.ts`), with the
 * header sets a live probe of each subscription got (`test/fixtures/quota-headers.ts`).
 */

import { clearAllQuotas, providerQuota, readQuota, recordQuota } from '@proxy/pi/quota'
import { beforeEach, describe, expect, test } from 'vite-plus/test'

import { ANTHROPIC_QUOTA_HEADERS, CODEX_QUOTA_HEADERS } from '../fixtures/quota-headers'

/** A fixed clock: 2026-10-21T22:34:00Z. */
const NOW = Date.UTC(2026, 9, 21, 22, 34, 0)

/** The Anthropic response's headers. */
const ANTHROPIC = new Headers(ANTHROPIC_QUOTA_HEADERS)
/** The Codex response's headers. */
const CODEX = new Headers(CODEX_QUOTA_HEADERS)
/** An hour, in milliseconds. */
const HOUR_MS = 3_600_000

/**
 * A time some hours after {@link NOW}, in Unix seconds, as a reset header carries it.
 *
 * @param hours - how many hours on
 * @returns the header value
 */
function inSeconds(hours: number): string {
  return String(NOW / 1000 + hours * 3600)
}

beforeEach(() => {
  clearAllQuotas()
})

describe('readQuota', () => {
  // Catches a window misread (a share as a percentage, a reset in the wrong unit), or an ID,
  // cookie or token kept: the report has exactly the windows, the status and nothing else.
  test("Anthropic's unified windows, as 0–1 shares", () => {
    expect(readQuota(ANTHROPIC)).toEqual({
      status: 'allowed',
      statusResetsAt: 1_792_639_800_000,
      statusWindow: 'five_hour',
      plan: undefined,
      windows: [
        { name: '5h', used: 0, resetsAt: 1_792_639_800_000, windowMinutes: 300, status: 'allowed' },
        {
          name: '7d',
          used: 0.47,
          resetsAt: 1_792_893_600_000,
          windowMinutes: 10_080,
          status: 'allowed'
        }
      ]
    })
  })

  // Catches Codex's percentages read as shares (2 % as 2, over the whole), or its plan lost.
  test("Codex's primary and secondary windows, from percentages", () => {
    expect(readQuota(CODEX)).toEqual({
      status: undefined,
      statusResetsAt: undefined,
      statusWindow: undefined,
      plan: 'plus',
      windows: [
        {
          name: 'primary',
          used: 0,
          resetsAt: 1_792_631_639_000,
          windowMinutes: 300,
          status: undefined
        },
        {
          name: 'secondary',
          used: 0.02,
          resetsAt: 1_793_118_505_000,
          windowMinutes: 10_080,
          status: undefined
        }
      ]
    })
  })

  // Catches zeros made up for a provider that reports nothing, or a malformed value kept.
  test.each([
    ['no quota headers', new Headers({ 'content-type': 'text/event-stream' })],
    [
      'a share over the whole',
      new Headers({ 'anthropic-ratelimit-unified-5h-utilization': '1.5' })
    ],
    ['a share that is not a number', new Headers({ 'x-codex-primary-used-percent': '5abc' })],
    ['a reset with no share', new Headers({ 'anthropic-ratelimit-unified-5h-reset': '1792639800' })]
  ])('%s reports none', (_case, headers) => {
    expect(readQuota(headers)).toBeUndefined()
  })

  // Catches a reset time no `Date` can hold kept in the report (#384 review): `/healthz/creds`
  // formats each as an ISO time, and one that throws took the whole report down. The field is
  // dropped and the rest of the report kept.
  test('a reset time out of range is dropped, the rest kept', () => {
    const report = readQuota(
      new Headers({
        'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-reset': '99999999999999999999',
        'anthropic-ratelimit-unified-5h-utilization': '1',
        'anthropic-ratelimit-unified-5h-reset': '99999999999999999999'
      })
    )

    expect(report).toMatchObject({
      status: 'rejected',
      statusResetsAt: undefined,
      windows: [{ name: '5h', used: 1, resetsAt: undefined }]
    })
  })
})

describe('the latest report per provider', () => {
  // Catches a response without quota headers wiping the last report, or reports mixed between
  // providers.
  test('a later report replaces the last; a response without one keeps it', () => {
    recordQuota('anthropic', ANTHROPIC, NOW)
    recordQuota('openai-codex', CODEX, NOW)
    recordQuota('anthropic', new Headers({ 'content-type': 'application/json' }), NOW + 1)

    expect(providerQuota('anthropic', NOW)).toMatchObject({
      provider: 'anthropic',
      observedAt: NOW
    })
    expect(providerQuota('openai-codex', NOW)?.plan).toBe('plus')
    expect(providerQuota('google', NOW)).toBeUndefined()
  })

  // Catches a window's share shown after it has reset, when it is no longer known: at the
  // primary reset the 5-hour window goes, and once both have reset there is no report.
  test('a window that has reset is left out', () => {
    recordQuota('openai-codex', CODEX, NOW)

    const afterPrimary = providerQuota('openai-codex', 1_792_631_639_000)
    expect(afterPrimary?.windows.map((window) => window.name)).toEqual(['secondary'])
    expect(providerQuota('openai-codex', 1_793_118_505_000)).toBeUndefined()
  })

  // Catches an overall status outliving the window it came from (#189 review): with no reset time
  // of its own, once a window resets `allowed` (or `rejected`) may no longer hold, so it is shown
  // as unknown.
  test('without its own reset time, the overall status lapses when a window resets', () => {
    recordQuota(
      'anthropic',
      new Headers({
        'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-5h-utilization': '1',
        'anthropic-ratelimit-unified-5h-reset': inSeconds(1),
        'anthropic-ratelimit-unified-7d-utilization': '0.4',
        'anthropic-ratelimit-unified-7d-reset': inSeconds(48)
      }),
      NOW
    )

    expect(providerQuota('anthropic', NOW)?.status).toBe('rejected')
    expect(providerQuota('anthropic', NOW + HOUR_MS)).toMatchObject({
      status: undefined,
      windows: [{ name: '7d' }]
    })
  })

  // Catches a window that resets first ending a status it didn't decide (#384 review): under a
  // 7-day rejection whose own reset is an hour after the 5-hour window's, the status holds past
  // the 5-hour reset and lapses at its own.
  test('with its own reset time, the overall status outlasts a window that resets first', () => {
    recordQuota(
      'anthropic',
      new Headers({
        'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-reset': inSeconds(2),
        'anthropic-ratelimit-unified-representative-claim': 'seven_day',
        'anthropic-ratelimit-unified-5h-utilization': '0.2',
        'anthropic-ratelimit-unified-5h-reset': inSeconds(1),
        'anthropic-ratelimit-unified-7d-utilization': '1',
        'anthropic-ratelimit-unified-7d-reset': inSeconds(48)
      }),
      NOW
    )

    expect(providerQuota('anthropic', NOW + HOUR_MS)).toMatchObject({
      status: 'rejected',
      statusWindow: 'seven_day',
      windows: [{ name: '7d' }]
    })
    expect(providerQuota('anthropic', NOW + 2 * HOUR_MS)).toMatchObject({
      status: undefined,
      statusResetsAt: undefined,
      windows: [{ name: '7d' }]
    })
  })

  // Catches a `rejected` kept after the limit lifted (#382): a login nobody routes to keeps its
  // last report, so the status must lapse at Anthropic's own `unified-reset`, even while every
  // window it reported is still running.
  test('the overall status lapses at its own reset, before any window has reset', () => {
    recordQuota(
      'anthropic',
      new Headers({
        'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-reset': inSeconds(1),
        'anthropic-ratelimit-unified-representative-claim': 'five_hour',
        'anthropic-ratelimit-unified-5h-utilization': '1',
        'anthropic-ratelimit-unified-5h-reset': inSeconds(2)
      }),
      NOW
    )
    const anHourOn = NOW + HOUR_MS

    expect(providerQuota('anthropic', anHourOn - 1)).toMatchObject({
      status: 'rejected',
      statusResetsAt: anHourOn,
      statusWindow: 'five_hour'
    })
    expect(providerQuota('anthropic', anHourOn)).toMatchObject({
      status: undefined,
      statusResetsAt: undefined,
      statusWindow: undefined,
      windows: [{ name: '5h', used: 1 }]
    })
  })
})
