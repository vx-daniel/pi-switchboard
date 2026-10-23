/**
 * One exposed model, several logins (`src/openai/model-logins.ts`, #227): a login slot's models
 * group under the base provider's, and the base stands for them in exposure.
 */

import type { Api, Model } from '@earendil-works/pi-ai'
import { groupLogins } from '@proxy/openai/model-logins'
import { describe, expect, test } from 'vite-plus/test'

/**
 * Builds a chat model of a provider.
 *
 * @param provider - the provider
 * @param id - the model ID
 * @returns the model
 */
function makeModel(provider: string, id: string): Model<Api> {
  return {
    id,
    name: id,
    api: 'openai-completions',
    provider,
    baseUrl: `https://${provider}.example.com`,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096
  }
}

describe('groupLogins', () => {
  // Catches a slot's models grouped with the wrong model, listed as models of their own, or the
  // logins out of order (the base must be tried first, then slots by number, whatever pi's order
  // or the slot's ID form).
  test("groups a slot's models under the base's, base first, slots by number", () => {
    const base = makeModel('anthropic', 'opus')
    const third = makeModel('anthropic-account-3', 'opus')
    const second = makeModel('anthropic-2', 'opus')
    const other = makeModel('anthropic', 'haiku')

    const groups = groupLogins([third, base, other, second])

    expect(groups.map((group) => `${group.primary.provider}/${group.primary.id}`)).toEqual([
      'anthropic/opus',
      'anthropic/haiku'
    ])
    expect(groups[0]?.primary).toBe(base)
    expect(groups[0]?.logins.map((login) => login.provider)).toEqual([
      'anthropic',
      'anthropic-2',
      'anthropic-account-3'
    ])
    expect(groups[1]?.logins).toEqual([other])
  })

  // Catches a model only a slot has (logged out of the base, or a catalog difference) vanishing:
  // it stands in for the base, under the base's provider, and is served by that login.
  test('a model only a slot has is exposed under the base provider', () => {
    const slotOnly = makeModel('openai-codex-2', 'gpt')

    const [group] = groupLogins([slotOnly])

    expect(group?.primary).toMatchObject({ provider: 'openai-codex', id: 'gpt' })
    expect(group?.logins).toEqual([slotOnly])
  })

  // Catches a provider merely named like a slot (a models.json `acme-2`, which no built-in
  // `acme` backs) taken for one: it is a provider of its own.
  test('a provider named like a slot of no built-in provider is its own', () => {
    const acme = makeModel('acme-2', 'chat')

    const [group] = groupLogins([acme])

    expect(group?.primary).toBe(acme)
    expect(group?.logins).toEqual([acme])
  })
})
