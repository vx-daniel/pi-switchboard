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

beforeEach(() => {
  clearAllQuotas()
})

describe('readQuota', () => {
  // Catches a window misread (a share as a percentage, a reset in the wrong unit), or an ID,
  // cookie or token kept: the report has exactly the windows, the status and nothing else.
  test("Anthropic's unified windows, as 0–1 shares", () => {
    expect(readQuota(ANTHROPIC)).toEqual({
      status: 'allowed',
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
})
