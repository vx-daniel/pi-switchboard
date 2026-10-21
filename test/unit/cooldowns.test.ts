/**
 * Cooldown state (`src/pi/cooldowns.ts`) and how a fallback chain skips by it
 * (`src/server/route-cooldowns.ts`), #68.
 */

import type { Api, Model } from '@earendil-works/pi-ai'
import type { ExposedModel } from '@proxy/openai/model-exposure'
import {
  activeCooldown,
  backoffMs,
  clearAllCooldowns,
  clearCooldowns,
  startCooldown
} from '@proxy/pi/cooldowns'
import { cooldownSkip } from '@proxy/server/route-cooldowns'
import { beforeEach, describe, expect, test } from 'vite-plus/test'

const NOW = 1_800_000_000_000
const MINUTE = 60_000

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

const OPUS = exposed('anthropic', 'opus')
const SONNET = exposed('anthropic', 'sonnet')
const SOL = exposed('openai-codex', 'sol')

beforeEach(() => {
  clearAllCooldowns()
})

describe('cooldowns', () => {
  // Catches a 429 cooling only its model, when a subscription's limit covers the whole login, or
  // an overload cooling the whole provider, when only that model is overloaded.
  test('a 429 cools the provider; a 503 only the model', () => {
    startCooldown(OPUS, 'rate_limit', 30_000, NOW)
    startCooldown(SOL, 'unavailable', 30_000, NOW)

    expect(activeCooldown(SONNET, NOW)).toMatchObject({ scope: 'provider', reason: 'rate_limit' })
    expect(activeCooldown(exposed('openai-codex', 'luna'), NOW)).toBeUndefined()
    expect(activeCooldown(SOL, NOW)).toMatchObject({ scope: 'model', reason: 'unavailable' })
  })

  // Catches the default not growing, so a provider that never says when keeps being hit once a
  // minute, or growing on a schedule other than 60 s, 180 s, then doubling.
  test('without a time, each failure in a row waits longer: 60 s, 180 s, then doubling', () => {
    expect([1, 2, 3, 4].map(backoffMs)).toEqual([MINUTE, 3 * MINUTE, 6 * MINUTE, 12 * MINUTE])

    expect(startCooldown(OPUS, 'rate_limit', undefined, NOW).until).toBe(NOW + MINUTE)
    expect(startCooldown(OPUS, 'rate_limit', undefined, NOW).until).toBe(NOW + 3 * MINUTE)
  })

  // Catches the growing default carried past a time the provider stated, or past a success: each
  // resets the run, so the next unexplained failure waits 60 s again.
  test('a stated time, or a success, starts the default over', () => {
    startCooldown(OPUS, 'rate_limit', undefined, NOW)
    startCooldown(OPUS, 'rate_limit', undefined, NOW)
    expect(startCooldown(OPUS, 'rate_limit', 5000, NOW)).toMatchObject({
      source: 'response',
      streak: 0
    })
    expect(startCooldown(OPUS, 'rate_limit', undefined, NOW).until).toBe(NOW + MINUTE)

    startCooldown(OPUS, 'rate_limit', undefined, NOW)
    clearCooldowns(OPUS)
    expect(startCooldown(OPUS, 'rate_limit', undefined, NOW).until).toBe(NOW + MINUTE)
  })

  // Catches a cooldown outliving its end, or one a success doesn't clear.
  test('ends at its time, or when a model of it answers', () => {
    startCooldown(OPUS, 'rate_limit', 30_000, NOW)

    expect(activeCooldown(SONNET, NOW + 29_999)).toBeDefined()
    expect(activeCooldown(SONNET, NOW + 30_000)).toBeUndefined()

    startCooldown(OPUS, 'rate_limit', 30_000, NOW)
    clearCooldowns(SONNET)
    expect(activeCooldown(OPUS, NOW)).toBeUndefined()
  })
})

describe('cooldownSkip', () => {
  // Catches a chain skipping a cooling model for a failure it doesn't name (principle VI), or not
  // skipping one it does.
  test('skips a cooling candidate only when the alias names its class', () => {
    startCooldown(OPUS, 'rate_limit', 30_000, NOW)
    const chain = [OPUS, SOL]

    expect(cooldownSkip(chain, 0, new Set(['rate_limit']), NOW)).toMatchObject({
      reason: 'rate_limit'
    })
    expect(cooldownSkip(chain, 0, new Set(['unavailable', 'timeout']), NOW)).toBeUndefined()
    expect(cooldownSkip(chain, 1, new Set(['rate_limit']), NOW)).toBeUndefined()
  })

  // Catches a chain making no call at all when every candidate is cooling: the one whose cooldown
  // ends first is still tried.
  test('when every candidate is cooling, the one that ends first is tried', () => {
    startCooldown(OPUS, 'rate_limit', 10 * MINUTE, NOW)
    startCooldown(SOL, 'rate_limit', MINUTE, NOW)
    const chain = [OPUS, SOL]
    const named = new Set(['rate_limit'] as const)

    expect(cooldownSkip(chain, 0, named, NOW)).toBeDefined()
    expect(cooldownSkip(chain, 1, named, NOW)).toBeUndefined()
  })
})
