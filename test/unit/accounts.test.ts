/**
 * Extra logins as providers (`src/pi/accounts.ts`, #227): a built-in provider copied under
 * `{provider}-account-N`, listing its catalog under the new ID, sending requests as the base, and
 * translating a catalog refresh between the two.
 */

import type { Api, AssistantMessageEventStream, Model, Provider } from '@earendil-works/pi-ai'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import { accountProvider, accountProviderId, registerAccounts } from '@proxy/pi/accounts'
import { describe, expect, test, vi } from 'vite-plus/test'

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
    baseUrl: 'https://example.com/v1',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096
  }
}

/** The transcript context every stream call gets; the copy passes it through untouched. */
const CONTEXT = normalizeContext({ messages: [] })

/**
 * Builds a static provider with two models, recording the model each stream call receives.
 *
 * @returns the provider and the models its stream methods were called with
 */
function makeBase(): { provider: Provider; streamed: Model<Api>[] } {
  const streamed: Model<Api>[] = []
  const models = [makeModel('acme', 'fast'), makeModel('acme', 'smart')]
  const stream = (model: Model<Api>): AssistantMessageEventStream => {
    streamed.push(model)
    return createAssistantMessageEventStream()
  }
  return {
    streamed,
    provider: {
      id: 'acme',
      name: 'Acme',
      baseUrl: 'https://example.com/v1',
      auth: { apiKey: { name: 'Acme key', resolve: () => Promise.resolve(undefined) } },
      getModels: () => models,
      getAllModels: () => models,
      stream,
      streamSimple: stream
    }
  }
}

describe('accountProviderId', () => {
  // Catches a copy's ID drifting from the convention pi-rotator and pi-multi-account share, which
  // is what lets a login made through either appear here unchanged.
  test('follows the {provider}-account-N convention', () => {
    expect(accountProviderId('anthropic', 2)).toBe('anthropic-account-2')
    expect(accountProviderId('openai-codex', 10)).toBe('openai-codex-account-10')
  })
})

describe('accountProvider', () => {
  // Catches the copy listing models under the base's ID: the proxy's canonical IDs, cooldowns,
  // quota and `x_pi` are all keyed by the model's provider, so the second login would be
  // indistinguishable from the first.
  test('lists the catalog under its own ID, in both model listings', () => {
    const copy = accountProvider(makeBase().provider, 2)

    expect(copy.id).toBe('acme-account-2')
    expect(copy.name).toBe('Acme (account 2)')
    expect(copy.getModels().map((model) => `${model.provider}/${model.id}`)).toEqual([
      'acme-account-2/fast',
      'acme-account-2/smart'
    ])
    expect(copy.getAllModels?.().map((model) => model.provider)).toEqual([
      'acme-account-2',
      'acme-account-2'
    ])
  })

  // Catches a request reaching pi's API code under the copy's ID: `openai`'s ChatGPT sign-in and
  // `github-copilot`'s headers are chosen by `model.provider`, so the copy would send a different
  // request than the base.
  test('sends each request as the base provider', () => {
    const base = makeBase()
    const copy = accountProvider(base.provider, 2)
    const [model] = copy.getModels()
    if (model === undefined) throw new Error('the copy lists no model')

    copy.stream(model, CONTEXT)
    copy.streamSimple(model, CONTEXT)

    expect(base.streamed.map((streamed) => `${streamed.provider}/${streamed.id}`)).toEqual([
      'acme/fast',
      'acme/fast'
    ])
  })

  // Catches a dynamic catalog stored or restored under the wrong ID: pi's providers restore only
  // the stored models whose `provider` is their own, so the copy's models would vanish on the next
  // start, and a list persisted under the base's ID would overwrite the base's.
  test('translates a catalog refresh between the two IDs', async () => {
    const base = makeBase()
    const seen: { restored: string[]; publishedUnder: string[] } = {
      restored: [],
      publishedUnder: []
    }
    base.provider.refreshModels = async (context) => {
      seen.restored = (context.stored?.models ?? []).map((model) => model.provider)
      await context.publish({ persist: { models: [makeModel('acme', 'new')] } })
      await context.publish({ persist: null })
    }
    const copy = accountProvider(base.provider, 2)

    await copy.refreshModels?.({
      stored: { models: [makeModel('acme-account-2', 'old')] },
      publish: (publication) => {
        seen.publishedUnder.push(
          ...(publication.persist?.models.map((model) => model.provider) ?? ['none'])
        )
        return Promise.resolve(true)
      },
      allowNetwork: false,
      signal: new AbortController().signal
    })

    expect(seen.restored).toEqual(['acme'])
    expect(seen.publishedUnder).toEqual(['acme-account-2', 'none'])
  })

  // Catches a static provider gaining a refresh it never had, which pi would then call.
  test('has no catalog refresh when the base has none', () => {
    expect(accountProvider(makeBase().provider, 2).refreshModels).toBeUndefined()
  })
})

describe('registerAccounts', () => {
  // Catches the count read as the number of extra logins rather than the total, a login skipped,
  // or a base that is not built in registered anyway: a models.json provider is composed with its
  // key, which the copy would carry to the other login.
  test('registers every extra login of a built-in provider and skips an unknown base', () => {
    const registerNativeProvider = vi.fn<(provider: Provider) => void>()

    const registered = registerAccounts(
      { registerNativeProvider },
      { 'anthropic': 3, 'no-such-provider': 2 }
    )

    expect(registered).toEqual(['anthropic-account-2', 'anthropic-account-3'])
    expect(registerNativeProvider.mock.calls.map(([provider]) => provider.id)).toEqual(registered)
  })
})
