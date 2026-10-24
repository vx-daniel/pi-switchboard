/**
 * Cooldown state (`src/pi/cooldowns.ts`) and how a fallback chain skips by it
 * (`src/server/route-cooldowns.ts`), #68.
 */

import type { Api, Model } from '@earendil-works/pi-ai'
import type { FailureClass } from '@proxy/config/schema'
import type { ExposedModel } from '@proxy/openai/model-exposure'
import {
  activeCooldown,
  backoffMs,
  clearAllCooldowns,
  clearCooldowns,
  clearCooldownsFor,
  loginSubject,
  startCooldown
} from '@proxy/pi/cooldowns'
import { LATEST_DATE_MS } from '@proxy/pi/reset-time'
import { cooldownSkip } from '@proxy/server/route-cooldowns'
import type { RouteHops } from '@proxy/server/route-hops'
import { beforeEach, describe, expect, test } from 'vite-plus/test'

const NOW = 1_800_000_000_000
const MINUTE = 60_000

/**
 * Builds a route's hop rules: the classes an alias names between models, and none between logins.
 *
 * @param classes - the alias's `fallbackOn`
 * @returns the hop rules
 */
function hops(classes: readonly FailureClass[]): RouteHops {
  return { fallbackOn: new Set(classes), loginFallbackOn: new Set() }
}

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
  return { publicId: id, canonicalId: `${provider}/${id}`, model, provider, login: provider }
}

const OPUS = exposed('anthropic', 'opus')
const SONNET = exposed('anthropic', 'sonnet')
const SOL = exposed('openai-codex', 'sol')
/** The same model as {@link OPUS} under a second login (#227). */
const OPUS_2: ExposedModel = { ...OPUS, login: 'anthropic-2' }

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
    clearCooldowns(OPUS, NOW + 1)
    expect(startCooldown(OPUS, 'rate_limit', undefined, NOW).until).toBe(NOW + MINUTE)
  })

  // Catches the growing default overflowing a Date (fifth #181 review): a client that keeps
  // naming a rate-limited model grows the streak each call, and past about 38 calls the end could
  // not be shown, so every skip and every /healthz/models answer threw.
  test('a long streak ends at the last representable date, not past it', () => {
    for (let failure = 0; failure < 60; failure += 1) {
      startCooldown(OPUS, 'rate_limit', undefined, NOW)
    }

    const until = activeCooldown(OPUS, NOW)?.until ?? 0
    expect(until).toBe(LATEST_DATE_MS)
    expect(() => new Date(until).toISOString()).not.toThrow()
  })

  // Catches a cooldown outliving its end, or one a success doesn't clear.
  test('ends at its time, or when a model of it answers', () => {
    startCooldown(OPUS, 'rate_limit', 30_000, NOW)

    expect(activeCooldown(SONNET, NOW + 29_999)).toBeDefined()
    expect(activeCooldown(SONNET, NOW + 30_000)).toBeUndefined()

    startCooldown(OPUS, 'rate_limit', 30_000, NOW)
    clearCooldowns(SONNET, NOW + 1)
    expect(activeCooldown(OPUS, NOW)).toBeUndefined()
  })

  // Catches a success erasing a cooldown that started after its call was sent (sixth #181
  // review): the provider took that call while it still had room, so the limit still holds.
  test('a success sent before the cooldown started leaves it', () => {
    startCooldown(OPUS, 'rate_limit', 30_000, NOW)

    clearCooldowns(OPUS, NOW - 1)
    expect(activeCooldown(OPUS, NOW)).toBeDefined()
    clearCooldowns(OPUS, NOW)
    expect(activeCooldown(OPUS, NOW)).toBeDefined()
  })
})

describe('clearCooldownsFor (#182)', () => {
  // Catches a clear that leaves the growing default where it was, so the next unexplained failure
  // waits 6 minutes instead of 60 s, or one that keeps a cooldown that started after the last send
  // (the operator's clear has no send time to check).
  test('ends a fresh cooldown and starts the default over', () => {
    startCooldown(OPUS, 'rate_limit', undefined, NOW)
    startCooldown(OPUS, 'rate_limit', undefined, NOW)

    expect(clearCooldownsFor({ provider: 'anthropic' }, NOW)).toEqual([
      expect.objectContaining({ scope: 'provider', provider: 'anthropic', streak: 2 })
    ])
    expect(activeCooldown(OPUS, NOW)).toBeUndefined()
    expect(startCooldown(OPUS, 'rate_limit', undefined, NOW).until).toBe(NOW + MINUTE)
  })

  // Catches a model's clear lifting its login's limit, a login's clear lifting a model's overload,
  // or naming nothing clearing nothing.
  test('a login names its cooldown, a model its own, and neither names all', () => {
    startCooldown(OPUS, 'rate_limit', 30_000, NOW)
    startCooldown(SOL, 'unavailable', 60_000, NOW)

    expect(clearCooldownsFor({ model: 'anthropic/opus' }, NOW)).toEqual([])
    expect(clearCooldownsFor({ provider: 'openai-codex' }, NOW)).toEqual([])
    expect(clearCooldownsFor({}, NOW).map((cooldown) => cooldown.scope)).toEqual([
      'provider',
      'model'
    ])
    expect([activeCooldown(OPUS, NOW), activeCooldown(SOL, NOW)]).toEqual([undefined, undefined])
  })

  // Catches an ended cooldown reported as cleared: the operator would read it as still running.
  test('a cooldown already over is not reported', () => {
    startCooldown(OPUS, 'rate_limit', 30_000, NOW)

    expect(clearCooldownsFor({}, NOW + 30_000)).toEqual([])
  })
})

describe('cooldownSkip', () => {
  // Catches a chain skipping a cooling model for a failure it doesn't name (principle VI), or not
  // skipping one it does.
  test('skips a cooling candidate only when the alias names its class', () => {
    startCooldown(OPUS, 'rate_limit', 30_000, NOW)
    const chain = [OPUS, SOL]

    expect(cooldownSkip(chain, 0, hops(['rate_limit']), NOW)).toMatchObject({
      reason: 'rate_limit'
    })
    expect(cooldownSkip(chain, 0, hops(['unavailable', 'timeout']), NOW)).toBeUndefined()
    expect(cooldownSkip(chain, 1, hops(['rate_limit']), NOW)).toBeUndefined()
  })

  // Catches a 503 (the model is overloaded, under every login) answered by trying the same model
  // under the next login when only the alias names `unavailable`: the remaining logins are skipped
  // and the next model is tried; a 429 on one login cools only that login (#227).
  test("a model's cooldown covers its logins; a login's cools only itself", () => {
    const route = [OPUS, OPUS_2, SOL]
    const aliasNamesUnavailable: RouteHops = {
      fallbackOn: new Set(['unavailable']),
      loginFallbackOn: new Set(['rate_limit'])
    }

    startCooldown(loginSubject(OPUS), 'unavailable', MINUTE, NOW)
    expect(cooldownSkip(route, 0, aliasNamesUnavailable, NOW)).toMatchObject({ scope: 'model' })
    expect(cooldownSkip(route, 1, aliasNamesUnavailable, NOW)).toMatchObject({ scope: 'model' })
    expect(cooldownSkip(route, 2, aliasNamesUnavailable, NOW)).toBeUndefined()

    clearAllCooldowns()
    startCooldown(loginSubject(OPUS), 'rate_limit', MINUTE, NOW)
    expect(cooldownSkip(route, 0, aliasNamesUnavailable, NOW)).toMatchObject({ scope: 'provider' })
    expect(cooldownSkip(route, 1, aliasNamesUnavailable, NOW)).toBeUndefined()
  })

  // Catches a chain making no call at all when every candidate is cooling: the one whose cooldown
  // ends first is still tried.
  test('when every candidate is cooling, the one that ends first is tried', () => {
    startCooldown(OPUS, 'rate_limit', 10 * MINUTE, NOW)
    startCooldown(SOL, 'rate_limit', MINUTE, NOW)
    const chain = [OPUS, SOL]
    const named = hops(['rate_limit'])

    expect(cooldownSkip(chain, 0, named, NOW)).toBeDefined()
    expect(cooldownSkip(chain, 1, named, NOW)).toBeUndefined()
  })

  // Catches a tie going against the alias's order (third #181 review): when two cooldowns end at
  // the same time, the chain keeps its preference and calls the earlier one.
  test('a tie goes to the earlier candidate in the chain', () => {
    startCooldown(OPUS, 'rate_limit', MINUTE, NOW)
    startCooldown(SOL, 'rate_limit', MINUTE, NOW)

    expect(cooldownSkip([OPUS, SOL], 0, hops(['rate_limit']), NOW)).toBeUndefined()
  })
})
