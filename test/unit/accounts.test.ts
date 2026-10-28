/**
 * Extra logins as providers (`src/pi/accounts.ts`, #227): a built-in provider copied under
 * `{provider}-N`, listing its catalog under the new ID, sending requests as the base, and
 * translating a catalog refresh between the two.
 */

import type {
  Api,
  AssistantMessageEventStream,
  AuthContext,
  Model,
  Provider
} from '@earendil-works/pi-ai'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import { accountProvider, parseAccountProviderId } from '@proxy/pi/account-provider'
import {
  type AccountRuntime,
  accountProviderId,
  nextAccountSlot,
  registerAccountProvider,
  registerStoredAccounts,
  unregisterAccountProvider
} from '@proxy/pi/accounts'
import { consoleEvents } from '@proxy/server/console-events'
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
  test('follows the {provider}-N convention', () => {
    expect(accountProviderId('anthropic', 2)).toBe('anthropic-2')
    expect(accountProviderId('openai-codex', 10)).toBe('openai-codex-10')
  })
})

describe('accountProvider', () => {
  // Catches the copy listing models under the base's ID: the proxy's canonical IDs, cooldowns,
  // quota and `x_pi` are all keyed by the model's provider, so the second login would be
  // indistinguishable from the first.
  test('lists the catalog under its own ID, in both model listings', () => {
    const copy = accountProvider(makeBase().provider, { providerId: 'acme-2', number: 2 })

    expect(copy.id).toBe('acme-2')
    expect(copy.name).toBe('Acme 2')
    expect(copy.getModels().map((model) => `${model.provider}/${model.id}`)).toEqual([
      'acme-2/fast',
      'acme-2/smart'
    ])
    expect(copy.getAllModels?.().map((model) => model.provider)).toEqual(['acme-2', 'acme-2'])
  })

  // Catches a request reaching pi's API code under the copy's ID: `openai`'s ChatGPT sign-in and
  // `github-copilot`'s headers are chosen by `model.provider`, so the copy would send a different
  // request than the base.
  test('sends each request as the base provider', () => {
    const base = makeBase()
    const copy = accountProvider(base.provider, { providerId: 'acme-2', number: 2 })
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
    const copy = accountProvider(base.provider, { providerId: 'acme-2', number: 2 })

    await copy.refreshModels?.({
      stored: { models: [makeModel('acme-2', 'old')] },
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
    expect(seen.publishedUnder).toEqual(['acme-2', 'none'])
  })

  // Catches a static provider gaining a refresh it never had, which pi would then call.
  test('has no catalog refresh when the base has none', () => {
    expect(
      accountProvider(makeBase().provider, { providerId: 'acme-2', number: 2 }).refreshModels
    ).toBeUndefined()
  })

  // Catches an API-key resolver or check that answers for a login with no stored credential (it
  // would fall back to the base's ambient key or profile), or one that no longer delegates when a
  // credential is stored.
  test("answers for an API-key login only from the login's own stored credential", async () => {
    const base = makeBase().provider
    const configured = { auth: { apiKey: 'ambient' }, source: 'environment' }
    const copy = accountProvider(
      {
        ...base,
        auth: {
          apiKey: {
            name: 'Acme key',
            resolve: () => Promise.resolve(configured),
            check: () => Promise.resolve({ type: 'api_key', source: 'environment' })
          }
        }
      },
      { providerId: 'acme-2', number: 2 }
    )
    const { apiKey } = copy.auth
    if (apiKey?.check === undefined) throw new Error('the copy lost its check hook')
    const context: AuthContext = {
      env: () => Promise.resolve(undefined),
      fileExists: () => Promise.resolve(false)
    }
    const signal = new AbortController().signal
    const stored = { type: 'api_key' as const, key: 'notarealsecret-stored' }

    expect(await apiKey.resolve({ ctx: context, signal })).toBeUndefined()
    expect(await apiKey.check({ ctx: context, signal })).toBeUndefined()
    expect(await apiKey.resolve({ ctx: context, credential: stored, signal })).toBe(configured)
    expect(await apiKey.check({ ctx: context, credential: stored, signal })).toMatchObject({
      type: 'api_key'
    })
  })

  // Catches a provider with no API-key auth (Codex, OAuth only) gaining one, or losing its login.
  test("keeps an OAuth-only provider's auth as it is", () => {
    const oauth = {
      name: 'Acme account',
      login: () => Promise.reject(new Error('not run')),
      refresh: () => Promise.reject(new Error('not run')),
      toAuth: () => Promise.reject(new Error('not run'))
    }
    const base = makeBase().provider

    const copy = accountProvider({ ...base, auth: { oauth } }, { providerId: 'acme-2', number: 2 })

    expect(copy.auth).toEqual({ oauth })
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
      getRegisteredNativeProvider: (id) => providers.get(id),
      registerNativeProvider: (provider) => providers.set(provider.id, provider),
      unregisterProvider: (id) => providers.delete(id),
      listCredentials: () =>
        Promise.resolve(credentials.map((providerId) => ({ providerId, type: 'api_key' as const })))
    },
    ids: () => [...providers.keys()]
  }
}

describe('parseAccountProviderId', () => {
  // Catches a base with a dash split at the wrong dash, `-1` taken as a slot (slot 1 is the base
  // itself), pi-rotator's `-account-N` form no longer read (a login made through it would vanish),
  // or a provider merely named like a slot taken for one.
  test('splits a slot ID of either form into base and number; nothing else is a slot', () => {
    expect(parseAccountProviderId('openai-codex-12')).toEqual({ base: 'openai-codex', number: 12 })
    expect(parseAccountProviderId('openai-codex-account-12')).toEqual({
      base: 'openai-codex',
      number: 12
    })
    expect(parseAccountProviderId('anthropic-1')).toBeUndefined()
    expect(parseAccountProviderId('anthropic-account-1')).toBeUndefined()
    expect(parseAccountProviderId('anthropic-02')).toBeUndefined()
    expect(parseAccountProviderId('anthropic')).toBeUndefined()
    expect(parseAccountProviderId('-2')).toBeUndefined()
    expect(parseAccountProviderId('-account-2')).toBeUndefined()
  })
})

describe('registerAccountProvider', () => {
  // Catches a slot of a models.json provider registered (its key would be copied), a slot
  // registered twice, or a plain provider ID treated as a slot.
  test('registers a slot of a built-in provider once, and refuses anything else', () => {
    const { runtime, ids } = fakeRuntime([], ['anthropic'])

    expect(registerAccountProvider(runtime, 'anthropic-2')).toBe(true)
    // The console's Requests table says a login slot was added (#266).
    expect(consoleEvents().at(-1)?.text).toBe('Registered anthropic-2 as a login of anthropic')
    expect(registerAccountProvider(runtime, 'anthropic-2')).toBe(false)
    expect(registerAccountProvider(runtime, 'no-such-provider-2')).toBe(false)
    expect(registerAccountProvider(runtime, 'anthropic')).toBe(false)

    expect(ids()).toEqual(['anthropic', 'anthropic-2'])
    expect(runtime.getRegisteredNativeProvider('anthropic-2')?.name).toBe('Anthropic 2')
  })

  // Catches a logout leaving the slot registered (it would stay in the model and login lists, and
  // the next login would take slot 3), or a base dropped as if it were a slot.
  test('unregistering drops a registered slot and nothing else', () => {
    const { runtime, ids } = fakeRuntime([], ['anthropic'])
    registerAccountProvider(runtime, 'anthropic-2')

    unregisterAccountProvider(runtime, 'anthropic')
    unregisterAccountProvider(runtime, 'anthropic-3')
    expect(ids()).toEqual(['anthropic', 'anthropic-2'])

    unregisterAccountProvider(runtime, 'anthropic-2')
    expect(ids()).toEqual(['anthropic'])
  })
})

describe('nextAccountSlot', () => {
  // Catches the next slot skipping a freed number, colliding with a registered one, or with a
  // pi-rotator login (`anthropic-account-2`) whose number is taken under the other form.
  test('is the lowest number from 2 that is not registered under either form', () => {
    const { runtime } = fakeRuntime([], ['anthropic', 'anthropic-account-2', 'anthropic-4'])
    expect(nextAccountSlot(runtime, 'anthropic')).toEqual({ providerId: 'anthropic-3', number: 3 })

    registerAccountProvider(runtime, 'anthropic-3')
    expect(nextAccountSlot(runtime, 'anthropic').providerId).toBe('anthropic-5')
  })
})

describe('registerStoredAccounts', () => {
  // Catches a login from an earlier run (or from pi-rotator) not served after a restart, a base
  // credential taken for a slot, or a slot of an unknown base registered.
  test('registers a provider for each stored slot credential of a built-in provider', async () => {
    const { runtime, ids } = fakeRuntime(
      ['anthropic', 'anthropic-3', 'openai-codex-account-2', 'acme-2'],
      ['anthropic', 'openai-codex']
    )

    const registered = await registerStoredAccounts(runtime, new AbortController().signal)

    expect(registered).toEqual({
      listed: true,
      accounts: ['anthropic-3', 'openai-codex-account-2']
    })
    expect(ids()).toEqual(['anthropic', 'openai-codex', 'anthropic-3', 'openai-codex-account-2'])
  })

  // Catches a store that cannot be listed keeping the proxy from starting: before slots existed,
  // startup never read the store here, so a failure registers nothing and the proxy runs on.
  // The result says the listing failed, with the error's name and not its message (which can
  // quote a path), so a failure is not read as "no extra logins" (#252).
  test('registers nothing and says so when the store cannot be listed', async () => {
    const { runtime, ids } = fakeRuntime([], ['anthropic'])
    runtime.listCredentials = () => Promise.reject(new Error('auth.json: EACCES'))

    await expect(registerStoredAccounts(runtime, new AbortController().signal)).resolves.toEqual({
      listed: false,
      reason: 'Error'
    })
    expect(ids()).toEqual(['anthropic'])
  })

  // Catches the failure reason carrying the error's message (which quotes a path under the user's
  // home) instead of its code or name, or a timeout or abort of the listing read as an empty store
  // (#252): the reason is `code` when the error has one, else its name, else `unknown`.
  test.each([
    [
      'an error with a code',
      Object.assign(new Error('EACCES: permission denied, open /home/alice/.pi/agent/auth.json'), {
        code: 'EACCES'
      }),
      'EACCES'
    ],
    [
      'an error without a code',
      new SyntaxError('Unexpected token in /home/alice/.pi/agent/auth.json'),
      'SyntaxError'
    ],
    [
      'a timeout of the signal',
      new DOMException('timed out reading /home/alice/.pi/agent/auth.json', 'TimeoutError'),
      'TimeoutError'
    ],
    ['a rejection that is no error', '/home/alice/.pi/agent/auth.json', 'unknown']
  ])('reports %s by its code or name, never its message', async (_label, failure, reason) => {
    const { runtime } = fakeRuntime([], ['anthropic'])
    runtime.listCredentials = () => Promise.reject(failure)

    const result = await registerStoredAccounts(runtime, new AbortController().signal)

    expect(result).toEqual({ listed: false, reason })
  })

  // Catches the abort signal being ignored: a listing that honours an already-aborted signal (as
  // pi's store does) must come back as a failed listing, not as `[]` or a thrown error that stops
  // the proxy from starting.
  test('a listing cut short by the signal is a failed listing', async () => {
    const { runtime, ids } = fakeRuntime(['anthropic-2'], ['anthropic'])
    runtime.listCredentials = ({ signal } = {}) => {
      signal?.throwIfAborted()
      return Promise.resolve([{ providerId: 'anthropic-2', type: 'api_key' as const }])
    }
    const timedOut = AbortSignal.abort(new DOMException('listing took too long', 'TimeoutError'))

    await expect(registerStoredAccounts(runtime, timedOut)).resolves.toEqual({
      listed: false,
      reason: 'TimeoutError'
    })
    expect(ids()).toEqual(['anthropic'])
  })

  // Catches an empty store reported as a failed listing (the field on /healthz/creds would cry
  // wolf for every install with a single login).
  test('an empty store is listed, with no accounts', async () => {
    const { runtime } = fakeRuntime([], ['anthropic'])

    await expect(registerStoredAccounts(runtime, new AbortController().signal)).resolves.toEqual({
      listed: true,
      accounts: []
    })
  })
})
