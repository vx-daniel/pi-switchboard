/**
 * An extra login (#227) is configured by its own stored credential only, never by the base
 * provider's environment key: `ANTHROPIC_API_KEY` is `anthropic`'s, not `anthropic-2`'s.
 */

import { registerAccountProvider } from '@proxy/pi/accounts'
import { getRuntime } from '@proxy/pi/registry'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'

/** The environment key, the base login's. */
const ENV_KEY = 'notarealsecret-environment-key'
/** The third login's stored key. */
const STORED_KEY = 'notarealsecret-stored-login-key'

let agentDir: FixtureAgentDir

beforeAll(async () => {
  vi.stubEnv('ANTHROPIC_API_KEY', ENV_KEY)
  agentDir = await loadFixtureAgentDir({
    authJson: { 'anthropic-3': { type: 'api_key', key: STORED_KEY } }
  })
})

afterAll(() => {
  vi.unstubAllEnvs()
  agentDir.remove()
})

describe("an extra login and the base's environment key", () => {
  // Catches an extra login configured by the base's environment key: it would be listed as a
  // second login of the same account, and one whose credential went away would serve on the
  // base's account without anyone seeing it.
  test('the environment key configures the base, not an extra login without a credential', async () => {
    const runtime = getRuntime()
    registerAccountProvider(runtime, 'anthropic-2')

    expect(await runtime.getAuth('anthropic')).toMatchObject({ auth: { apiKey: ENV_KEY } })
    expect(await runtime.getAuth('anthropic-2')).toBeUndefined()
  })

  // Catches the environment key winning over a login's own stored key.
  test("an extra login with a stored key uses its own key, whatever the environment's", async () => {
    expect(await getRuntime().getAuth('anthropic-3')).toMatchObject({
      auth: { apiKey: STORED_KEY }
    })
  })

  // Catches the case this guards against: a login registered at startup whose credential is then
  // removed outside the proxy (pi's logout in another process) falling back to the base's
  // environment key, and so serving on the base's account under its own name.
  test('an extra login whose credential is removed is no longer configured', async () => {
    const runtime = getRuntime()
    await runtime.logout('anthropic-3')

    expect(runtime.getRegisteredNativeProvider('anthropic-3')).toBeDefined()
    expect(await runtime.getAuth('anthropic-3')).toBeUndefined()
  })
})
