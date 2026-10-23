/**
 * Which failures move a request along its candidates (`src/server/route-hops.ts`, #67, #227):
 * between logins of one model, and between models.
 */

import type { Api, Model } from '@earendil-works/pi-ai'
import type { ExposedModel } from '@proxy/openai/model-exposure'
import { nextFor, type RouteHops } from '@proxy/server/route-hops'
import { describe, expect, test } from 'vite-plus/test'

/**
 * Builds a candidate: an exposed model under one login.
 *
 * @param provider - the base provider
 * @param id - the model ID
 * @param login - the login serving it; the provider when omitted
 * @returns the candidate
 */
function candidate(provider: string, id: string, login = provider): ExposedModel {
  const model: Model<Api> = {
    id,
    name: id,
    api: 'openai-completions',
    provider: login,
    baseUrl: 'https://example.com',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096
  }
  return { publicId: id, canonicalId: `${provider}/${id}`, model, provider, login }
}

const OPUS = candidate('anthropic', 'opus')
const OPUS_2 = candidate('anthropic', 'opus', 'anthropic-account-2')
const SOL = candidate('openai-codex', 'sol')

describe('nextFor', () => {
  // Catches a login hop taken for a class only the alias names, or a model hop for one only the
  // logins name: each hop follows its own list (principle VI).
  test('a login hop follows routing.logins.fallbackOn, a model hop the alias', () => {
    const chain = [OPUS, OPUS_2, SOL]
    const hops = {
      fallbackOn: new Set(['unavailable'] as const),
      loginFallbackOn: new Set(['rate_limit'] as const)
    }

    expect(nextFor(chain, 0, hops, 'rate_limit')).toBe(1)
    expect(nextFor(chain, 1, hops, 'rate_limit')).toBeUndefined()
    expect(nextFor(chain, 1, hops, 'unavailable')).toBe(2)
    expect(nextFor(chain, 0, hops, 'timeout')).toBeUndefined()
    expect(nextFor(chain, 2, hops, 'rate_limit')).toBeUndefined()
  })

  // Catches a class the alias names, but the logins do not, ending the request at the first login
  // although another model could answer: the rest of the model's logins are skipped and the next
  // model is tried.
  test('a class named for models but not logins skips the remaining logins', () => {
    const chain = [OPUS, OPUS_2, SOL]
    const hops: RouteHops = { fallbackOn: new Set(['unavailable']), loginFallbackOn: new Set() }

    expect(nextFor(chain, 0, hops, 'unavailable')).toBe(2)
  })

  // Catches a failure with no class (a 400, the client's own fault) moving on anywhere.
  test('a failure with no class never moves on', () => {
    const hops = {
      fallbackOn: new Set(['rate_limit'] as const),
      loginFallbackOn: new Set(['rate_limit'] as const)
    }

    expect(nextFor([OPUS, OPUS_2], 0, hops, undefined)).toBeUndefined()
  })
})
