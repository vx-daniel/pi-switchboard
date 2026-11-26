/**
 * What a request would do now (`src/server/route-preview.ts`, #379): the candidate it would call
 * first and those it would skip, by routing's own cooldown and reserve rules.
 */

import type { ExposedModel } from '@proxy/openai/model-exposure'
import { clearAllCooldowns, loginSubject, startCooldown } from '@proxy/pi/cooldowns'
import { clearAllQuotas, recordQuota } from '@proxy/pi/quota'
import { nextCooldown, previewRoute } from '@proxy/server/route-preview'
import { beforeEach, describe, expect, test } from 'vite-plus/test'

import { exposed } from '../helpers'

const NOW = 1_800_000_000_000
const MINUTE_MS = 60_000
/** `routing.logins.fallbackOn`'s default. */
const DEFAULTS = { loginFallbackOn: ['rate_limit' as const] }

/**
 * The model under several logins, as the exposure lists it: each login's entry knows the others.
 *
 * @param base - the model under its first login
 * @param extra - the other logins, in routing order
 * @returns the model's entry, its first login's
 */
function underLogins(base: ExposedModel, ...extra: string[]): ExposedModel {
  const logins = [
    base,
    ...extra.map((login) => ({ ...base, login, model: { ...base.model, provider: login } }))
  ]
  return { ...base, logins }
}

/**
 * Cools one login of a model after a 429.
 *
 * @param model - the model
 * @param login - the login
 * @param minutes - how long
 */
function cooling(model: ExposedModel, login: string, minutes: number): void {
  startCooldown(loginSubject({ ...model, login }), 'rate_limit', minutes * MINUTE_MS, NOW)
}

/**
 * Records a login's 5-hour quota report.
 *
 * @param login - the login
 * @param used - the share used
 */
function reported(login: string, used: number): void {
  recordQuota(
    login,
    new Headers({
      'anthropic-ratelimit-unified-5h-utilization': String(used),
      'anthropic-ratelimit-unified-5h-reset': String(NOW / 1000 + 3600)
    }),
    NOW
  )
}

const OPUS = underLogins(exposed('anthropic', 'opus'), 'anthropic-2')
const SOL = exposed('openai-codex', 'sol')

beforeEach(() => {
  clearAllCooldowns()
  clearAllQuotas()
})

describe('previewRoute', () => {
  // Catches the preview reporting the cooldown that lasts longest, or skipping every login: when
  // every login is cooling, routing calls the one that ends first, and so must the preview.
  test.each([
    { first: 30, second: 5, next: 'anthropic-2', skipped: ['anthropic'] },
    { first: 5, second: 30, next: 'anthropic', skipped: [] }
  ])(
    'with every login cooling, the next is the one that ends first ($next)',
    ({ first, second, next, skipped }) => {
      cooling(OPUS, 'anthropic', first)
      cooling(OPUS, 'anthropic-2', second)

      const preview = previewRoute(OPUS, DEFAULTS, NOW)

      expect(preview.next.login).toBe(next)
      expect(preview.skipped.map((skip) => skip.login)).toEqual(skipped)
      expect(nextCooldown(OPUS, DEFAULTS, NOW)?.until).toBe(NOW + 5 * MINUTE_MS)
    }
  )

  // Catches the reserve left out of the preview: routing passes over a login below its reserve
  // for one above it, and lists the skip as `quota`, with no end time.
  test('passes over a login below its reserve, as quota', () => {
    reported('anthropic', 0.9)
    reported('anthropic-2', 0.1)

    const preview = previewRoute(OPUS, { ...DEFAULTS, reserve: { anthropic: 0.2 } }, NOW)

    expect(preview).toMatchObject({
      next: { login: 'anthropic-2' },
      skipped: [{ model: 'anthropic/opus', login: 'anthropic', reason: 'quota', until: null }]
    })
  })

  // Catches a model-wide cooldown (a 529, under every login) treated as a reason to skip under
  // the default, which names only rate limits: the request still calls the first login.
  test('calls the first login through a model-wide 529 under the default fallback classes', () => {
    startCooldown(loginSubject(OPUS), 'unavailable', 2 * MINUTE_MS, NOW)

    const preview = previewRoute(OPUS, DEFAULTS, NOW)

    expect(preview).toMatchObject({ next: { login: 'anthropic' }, skipped: [] })
    expect(nextCooldown(OPUS, DEFAULTS, NOW)).toMatchObject({ scope: 'model' })
  })

  // Catches an alias reported by its first target alone: with both of that target's logins
  // cooling and the alias falling back on rate limits, a request goes on to the next model.
  test("follows an alias's chain past a target whose logins are all cooling", () => {
    cooling(OPUS, 'anthropic', 30)
    cooling(OPUS, 'anthropic-2', 30)
    const alias = {
      ...OPUS,
      route: { candidates: [OPUS, SOL], fallbackOn: ['rate_limit' as const] }
    }

    const preview = previewRoute(alias, DEFAULTS, NOW)

    expect(preview.next.canonicalId).toBe('openai-codex/sol')
    expect(preview.skipped).toEqual([
      { model: 'anthropic/opus', login: 'anthropic', reason: 'rate_limit', until: 1_800_001_800 },
      { model: 'anthropic/opus', login: 'anthropic-2', reason: 'rate_limit', until: 1_800_001_800 }
    ])
  })

  // Catches a one-login model changed by the preview: it is its own next, with nothing skipped,
  // and no login is named on a skip of a model without a choice of logins.
  test('leaves a one-login model as it is', () => {
    expect(previewRoute(SOL, {}, NOW)).toEqual({ next: SOL, skipped: [] })
  })
})
