/**
 * How a fallback chain keeps a provider's quota in reserve (`src/server/route-reserve.ts`, #69).
 */

import type { Api, Model } from '@earendil-works/pi-ai'
import type { ExposedModel } from '@proxy/openai/model-exposure'
import { clearAllQuotas, recordQuota } from '@proxy/pi/quota'
import { reserveSkip } from '@proxy/server/route-reserve'
import { beforeEach, describe, expect, test } from 'vite-plus/test'

const NOW = 1_800_000_000_000
/** A reset an hour after {@link NOW}, in Unix seconds, as the headers carry it. */
const LATER = String(NOW / 1000 + 3600)

/**
 * Builds an exposed model.
 *
 * @param provider - the provider
 * @param id - the model ID
 * @returns the exposed model
 */
function exposed(provider: string, id: string): ExposedModel {
  const model: Model<Api> = {
    id,
    name: id,
    api: 'openai-completions',
    provider,
    baseUrl: 'https://example.com',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096
  }
  return { publicId: id, canonicalId: `${provider}/${id}`, model, provider }
}

/**
 * Records a provider's quota report with a 5-hour and a 7-day window.
 *
 * @param provider - the provider
 * @param used - the share used of each window, from 0 to 1
 * @param used.fiveHour - the 5-hour window's
 * @param used.sevenDay - the 7-day window's
 */
function reported(provider: string, used: { fiveHour: number; sevenDay: number }): void {
  recordQuota(
    provider,
    new Headers({
      'anthropic-ratelimit-unified-5h-utilization': String(used.fiveHour),
      'anthropic-ratelimit-unified-5h-reset': LATER,
      'anthropic-ratelimit-unified-7d-utilization': String(used.sevenDay),
      'anthropic-ratelimit-unified-7d-reset': LATER
    }),
    NOW
  )
}

const OPUS = exposed('anthropic', 'opus')
const SOL = exposed('openai-codex', 'sol')
const FLASH = exposed('google', 'flash')

beforeEach(() => {
  clearAllQuotas()
})

describe('reserveSkip', () => {
  // Catches the reserve read from the wrong window: the 7-day window with 15% left is below a 20%
  // reserve even though the 5-hour one is nearly empty, so the provider is skipped for it.
  test('skips a provider whose worst window is below its reserve', () => {
    reported('anthropic', { fiveHour: 0.1, sevenDay: 0.85 })

    const skip = reserveSkip([OPUS, SOL], 0, { anthropic: 0.2 }, NOW)

    expect(skip).toMatchObject({ provider: 'anthropic', window: '7d', reserve: 0.2 })
    expect(skip?.left).toBeCloseTo(0.15)
  })

  // Catches a skip without cause: at or above the reserve, with no reserve set for the provider,
  // or with no quota reported (Google, API keys), the chain calls it.
  test('calls a provider at or above its reserve, without one, or without quota', () => {
    reported('anthropic', { fiveHour: 0.5, sevenDay: 0.8 })

    expect(reserveSkip([OPUS, SOL], 0, { anthropic: 0.2 }, NOW)).toBeUndefined()
    expect(reserveSkip([OPUS, SOL], 0, { 'openai-codex': 0.9 }, NOW)).toBeUndefined()
    expect(reserveSkip([FLASH, SOL], 0, { google: 0.5 }, NOW)).toBeUndefined()
  })

  // Catches a reserve that fails a request on its own: the last candidate, and a chain whose
  // remaining candidates are all below their reserve, still make a call, to the one with the
  // most left.
  test('when every remaining candidate is below its reserve, calls the one with the most left', () => {
    reported('anthropic', { fiveHour: 0.9, sevenDay: 0.1 })
    reported('openai-codex', { fiveHour: 0.95, sevenDay: 0.1 })
    const reserve = { 'anthropic': 0.2, 'openai-codex': 0.2 }

    expect(reserveSkip([OPUS], 0, reserve, NOW)).toBeUndefined()
    expect(reserveSkip([OPUS, SOL], 0, reserve, NOW)).toBeUndefined()
    expect(reserveSkip([SOL, OPUS], 0, reserve, NOW)).toMatchObject({ provider: 'openai-codex' })
    expect(reserveSkip([SOL, OPUS], 1, reserve, NOW)).toBeUndefined()
  })

  // Catches a stale report holding a provider back after its window reset: a window whose reset
  // has passed no longer counts.
  test('ignores a window that has reset since it was reported', () => {
    reported('anthropic', { fiveHour: 0.99, sevenDay: 0.99 })

    expect(reserveSkip([OPUS, SOL], 0, { anthropic: 0.2 }, NOW + 3_600_001)).toBeUndefined()
  })
})
