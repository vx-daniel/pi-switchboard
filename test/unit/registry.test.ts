/**
 * Registry tests: request auth is resolved through Pi's ModelRuntime.
 */

import type { Api, Model } from '@earendil-works/pi-ai'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { getLoginRegistration, getRequestAuth, initRegistry } from '@proxy/pi/registry'
import { assert, afterEach, beforeAll, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'

beforeAll(async () => {
  await initRegistry()
})

const agentDirs: FixtureAgentDir[] = []

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const agentDir of agentDirs.splice(0)) agentDir.remove()
})

/** An auth.json with a stored `anthropic-2` login (a slot of a built-in provider). */
const STORED_SLOT_LOGIN = {
  'anthropic-2': { type: 'api_key', key: 'notarealsecret-registry-slot-key' }
}

/** An auth.json pi cannot parse, with a marker that must never come back out. */
const UNREADABLE_AUTH_JSON = '{"anthropic-2": notarealsecret-registry-auth-marker'

/**
 * Wraps `ModelRuntime.create` so the runtime `initRegistry` builds has a spy on its `refresh`,
 * installed after `create` has made its own initial refresh.
 *
 * @returns the spy on `refresh`; it has no calls until `initRegistry` has the runtime
 */
function spyOnRuntimeRefresh(): { calls: () => number } {
  let refresh: { mock: { calls: unknown[] } } | undefined
  const create = ModelRuntime.create.bind(ModelRuntime)
  vi.spyOn(ModelRuntime, 'create').mockImplementation(async (...args) => {
    const created = await create(...args)
    refresh = vi.spyOn(created, 'refresh')
    return created
  })
  return { calls: () => refresh?.mock.calls.length ?? Number.NaN }
}

/** A model of a provider that no credential, environment variable or models.json defines. */
const MODEL_WITHOUT_CREDENTIALS: Model<Api> = {
  id: 'no-such-model',
  name: 'No such model',
  api: 'openai-completions',
  provider: 'provider-with-no-credentials',
  baseUrl: 'http://127.0.0.1:1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 100
}

describe('getRequestAuth', () => {
  // Catches the route's pre-check turning into a pass-through: a request for a model Pi cannot
  // authenticate must be refused with a reason before a response starts, not fail mid-stream.
  test('refuses a model whose provider has no credentials, and says why', async () => {
    const result = await getRequestAuth(MODEL_WITHOUT_CREDENTIALS)
    expect(result.ok).toBe(false)
    assert(!result.ok)
    expect(result.error).toContain('provider-with-no-credentials')
  })
})

describe('initRegistry login registration (#252)', () => {
  // Catches a failed credential listing at startup reading as "no extra logins": the failure's
  // code or name must be recorded (not the message, which quotes the file's text), and the
  // availability pass for registered logins must not run for a listing that registered none.
  test('records why the listing failed, without its message, and skips the refresh', async () => {
    const refresh = spyOnRuntimeRefresh()
    agentDirs.push(await loadFixtureAgentDir({ authJsonText: UNREADABLE_AUTH_JSON }))

    expect(getLoginRegistration()).toEqual({ registered: false, reason: 'SyntaxError' })
    expect(refresh.calls()).toBe(0)
  })

  // Catches the failure standing after a later init lists the store fine (a module variable that
  // is set on failure and never cleared would keep /healthz/creds reporting it).
  test('a later init with a readable store clears the failure', async () => {
    agentDirs.push(await loadFixtureAgentDir({ authJsonText: UNREADABLE_AUTH_JSON }))
    expect(getLoginRegistration().registered).toBe(false)

    agentDirs.push(await loadFixtureAgentDir({ authJson: {} }))

    expect(getLoginRegistration()).toEqual({ registered: true })
  })

  // Catches the availability pass being skipped when slot logins were registered (the provisional
  // availability of the new providers would stand), now that it is conditional on the listing.
  // `registerNativeProvider` starts a refresh of its own for each slot, so the explicit one shows
  // as a call beyond the number of slots.
  test('refreshes availability once logins were registered, and reports them as registered', async () => {
    const refresh = spyOnRuntimeRefresh()
    agentDirs.push(await loadFixtureAgentDir({ authJson: STORED_SLOT_LOGIN }))

    expect(getLoginRegistration()).toEqual({ registered: true })
    expect(refresh.calls()).toBeGreaterThan(Object.keys(STORED_SLOT_LOGIN).length)
  })

  // Catches an empty store counted as a failed listing, or refreshed needlessly.
  test('an empty store is registered, and nothing is refreshed', async () => {
    const refresh = spyOnRuntimeRefresh()
    agentDirs.push(await loadFixtureAgentDir({ authJson: {} }))

    expect(getLoginRegistration()).toEqual({ registered: true })
    expect(refresh.calls()).toBe(0)
  })
})
