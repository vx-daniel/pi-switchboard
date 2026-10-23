/**
 * Startup with a stored login slot (#227) when pi's availability refresh fails: the proxy still
 * starts, with the slot registered.
 */

import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { getRuntime } from '@proxy/pi/registry'
import { afterAll, describe, expect, test, vi } from 'vite-plus/test'

import { loadFixtureAgentDir } from '../fixtures/agent-dir'

afterAll(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('startup with a stored login slot', () => {
  // Catches a failed refresh after registering logins stopping the proxy from starting: before
  // logins existed, startup never refreshed here, so the failure must not cost the proxy.
  test('survives a failing availability refresh, with the slot registered', async () => {
    // `ModelRuntime.create` refreshes too; only the refresh that follows registration fails.
    const original = ModelRuntime.prototype.refresh
    const refresh = vi.spyOn(ModelRuntime.prototype, 'refresh').mockImplementation(function (
      this: ModelRuntime,
      ...args
    ) {
      return this.getRegisteredNativeProvider('groq-account-2') === undefined
        ? original.apply(this, args)
        : Promise.reject(new Error('models store unreadable'))
    })

    const agentDir = await loadFixtureAgentDir({
      authJson: { 'groq-account-2': { type: 'api_key', key: 'notarealsecret-slot-key' } }
    })
    try {
      expect(refresh).toHaveBeenCalled()
      expect(getRuntime().getRegisteredNativeProvider('groq-account-2')).toBeDefined()
    } finally {
      agentDir.remove()
    }
  })
})
