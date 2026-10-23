/**
 * Extra logins as providers (`src/pi/accounts.ts`, #227): a built-in provider copied under
 * `{provider}-account-N`, listing its catalog under the new ID, sending requests as the base, and
 * translating a catalog refresh between the two.
 */

import type { Api, AssistantMessageEventStream, Model, Provider } from '@earendil-works/pi-ai'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import {
  type AccountRuntime,
  accountProvider,
  accountProviderId,
  nextAccountSlot,
  parseAccountProviderId,
  registerAccountProvider,
  registerStoredAccounts,
  unregisterAccountProvider
} from '@proxy/pi/accounts'
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

/**
 * Builds a fake runtime that keeps registered providers in a map and lists given credentials.
 *
 * @param credentials - the provider IDs pi has credentials for
 * @param registered - the provider IDs registered already (bases, for instance)
 * @returns the runtime, and the IDs it holds now
 */
function fakeRuntime(
  credentials: readonly string[],
  registered: readonly string[] = []
): { runtime: AccountRuntime; ids: () => string[] } {
  const providers = new Map<string, Provider>()
  for (const providerId of registered) {
    providers.set(providerId, { ...makeBase().provider, id: providerId })
  }
  return {
    runtime: {
      getProvider: (id) => providers.get(id),
      registerNativeProvider: (provider) => providers.set(provider.id, provider),
      unregisterProvider: (id) => providers.delete(id),
      listCredentials: () =>
        Promise.resolve(credentials.map((providerId) => ({ providerId, type: 'api_key' as const })))
    },
    ids: () => [...providers.keys()]
  }
}

describe('parseAccountProviderId', () => {
  // Catches a base with a dash split at the wrong dash, `-account-1` taken as a slot (slot 1 is
  // the base itself), or a provider merely named like a slot taken for one.
  test('splits a slot ID into base and number; nothing else is a slot', () => {
    expect(parseAccountProviderId('openai-codex-account-12')).toEqual({
      base: 'openai-codex',
      number: 12
    })
    expect(parseAccountProviderId('anthropic-account-1')).toBeUndefined()
    expect(parseAccountProviderId('anthropic-account-02')).toBeUndefined()
    expect(parseAccountProviderId('anthropic')).toBeUndefined()
    expect(parseAccountProviderId('-account-2')).toBeUndefined()
  })
})

describe('registerAccountProvider', () => {
  // Catches a slot of a models.json provider registered (its key would be copied), a slot
  // registered twice, or a plain provider ID treated as a slot.
  test('registers a slot of a built-in provider once, and refuses anything else', () => {
    const { runtime, ids } = fakeRuntime([], ['anthropic'])

    expect(registerAccountProvider(runtime, 'anthropic-account-2')).toBe(true)
    expect(registerAccountProvider(runtime, 'anthropic-account-2')).toBe(false)
    expect(registerAccountProvider(runtime, 'no-such-provider-account-2')).toBe(false)
    expect(registerAccountProvider(runtime, 'anthropic')).toBe(false)

    expect(ids()).toEqual(['anthropic', 'anthropic-account-2'])
    expect(runtime.getProvider('anthropic-account-2')?.name).toBe('Anthropic (account 2)')
  })

  // Catches a logout leaving the slot registered (it would stay in the model and login lists, and
  // the next login would take slot 3), or a base dropped as if it were a slot.
  test('unregistering drops a registered slot and nothing else', () => {
    const { runtime, ids } = fakeRuntime([], ['anthropic'])
    registerAccountProvider(runtime, 'anthropic-account-2')

    unregisterAccountProvider(runtime, 'anthropic')
    unregisterAccountProvider(runtime, 'anthropic-account-3')
    expect(ids()).toEqual(['anthropic', 'anthropic-account-2'])

    unregisterAccountProvider(runtime, 'anthropic-account-2')
    expect(ids()).toEqual(['anthropic'])
  })
})

describe('nextAccountSlot', () => {
  // Catches the next slot skipping a freed number, or colliding with a registered one.
  test('is the lowest number from 2 that is not registered', () => {
    const { runtime } = fakeRuntime([], ['anthropic', 'anthropic-account-3'])
    expect(nextAccountSlot(runtime, 'anthropic')).toEqual({
      providerId: 'anthropic-account-2',
      number: 2
    })

    registerAccountProvider(runtime, 'anthropic-account-2')
    expect(nextAccountSlot(runtime, 'anthropic').providerId).toBe('anthropic-account-4')
  })
})

describe('registerStoredAccounts', () => {
  // Catches a login from an earlier run (or from pi-rotator) not served after a restart, a base
  // credential taken for a slot, or a slot of an unknown base registered.
  test('registers a provider for each stored slot credential of a built-in provider', async () => {
    const { runtime, ids } = fakeRuntime(
      ['anthropic', 'anthropic-account-3', 'openai-codex-account-2', 'acme-account-2'],
      ['anthropic', 'openai-codex']
    )

    const registered = await registerStoredAccounts(runtime, new AbortController().signal)

    expect(registered).toEqual(['anthropic-account-3', 'openai-codex-account-2'])
    expect(ids()).toEqual([
      'anthropic',
      'openai-codex',
      'anthropic-account-3',
      'openai-codex-account-2'
    ])
  })

  // Catches a store that cannot be listed keeping the proxy from starting: before slots existed,
  // startup never read the store here, so a failure registers nothing and the proxy runs on.
  test('registers nothing when the store cannot be listed', async () => {
    const { runtime, ids } = fakeRuntime([], ['anthropic'])
    runtime.listCredentials = () => Promise.reject(new Error('auth.json: EACCES'))

    await expect(registerStoredAccounts(runtime, new AbortController().signal)).resolves.toEqual([])
    expect(ids()).toEqual(['anthropic'])
  })
})
