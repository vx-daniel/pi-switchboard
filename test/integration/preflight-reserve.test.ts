/**
 * The credential preflight passes over what the dispatch passes over (#381): a candidate below
 * its quota reserve is skipped before its credential is checked, so a login the reserve routes
 * around can't fail the request with a credential that doesn't resolve.
 */

import { readExposure } from '@proxy/admin/reads'
import { clearAllQuotas, recordQuota } from '@proxy/pi/quota'
import { createApp } from '@proxy/server/app'
import { findCredentialedStart } from '@proxy/server/chat-dispatch'
import { planLogins } from '@proxy/server/route-plan'
import { fileConfigReader } from '@proxy/server/routes'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir, writeProxyConfig } from '../fixtures/agent-dir'
import {
  finishChunk,
  type MockProvider,
  sse,
  startMockProvider,
  textChunks
} from '../fixtures/mock-provider'
import { jsonBody, testConfig } from '../helpers'

/** The healthy target's model, answered by the mock. */
const HEALTHY_MODEL = 'healthy-mock'
/** The alias: the login with no credential first, then the healthy one. */
const ALIAS = 'pair'

let mock: MockProvider
let agentDir: FixtureAgentDir

beforeAll(async () => {
  mock = await startMockProvider({
    [HEALTHY_MODEL]: sse([...textChunks('ok'), finishChunk('stop')])
  })
  agentDir = await loadFixtureAgentDir({
    modelsJson: {
      providers: {
        // A key command that prints nothing: pi can't resolve a credential for it (#128).
        'no-credential': {
          baseUrl: `${mock.origin}/v1`,
          api: 'openai-completions',
          apiKey: '!true',
          models: [{ id: 'cold-mock' }]
        },
        'healthy': mock.provider()
      }
    }
  })
})

afterAll(async () => {
  vi.unstubAllEnvs()
  agentDir.remove()
  await mock.close()
})

afterEach(() => {
  clearAllQuotas()
})

/**
 * Records that the login with no credential has used nearly all of its 5-hour window.
 */
function nearlyUsedUp(): void {
  recordQuota(
    'no-credential',
    new Headers({
      'anthropic-ratelimit-unified-5h-utilization': '0.95',
      'anthropic-ratelimit-unified-5h-reset': String(Math.ceil(Date.now() / 1000) + 3600)
    })
  )
}

/**
 * Writes the alias, and the reserve when there is one, to the config file.
 *
 * @param reserve - `routing.reserve`, or `undefined` for none
 */
function configure(reserve: Record<string, number> | undefined): void {
  writeProxyConfig(agentDir.path, {
    aliases: {
      [ALIAS]: { targets: ['no-credential/cold-mock', `healthy/${HEALTHY_MODEL}`], fallbackOn: [] }
    },
    ...(reserve === undefined ? {} : { routing: { reserve } })
  })
}

/**
 * Asks the alias for a completion, through the proxy as deployed (its config file read).
 *
 * @param reserve - `routing.reserve`, or `undefined` for none
 * @returns the status and the answer's body
 */
async function askAlias(
  reserve: Record<string, number> | undefined
): Promise<{ status: number; body: unknown }> {
  configure(reserve)
  const response = await createApp(testConfig(), fileConfigReader).request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: ALIAS, messages: [{ role: 'user', content: 'Hello' }] })
  })
  return { status: response.status, body: await jsonBody(response) }
}

describe('the credential preflight', () => {
  // Catches the preflight checking a credential the dispatch would never use (#381): the first
  // target is below its reserve, so the request goes to the healthy one, and the skip is listed.
  test('skips a candidate below its reserve before checking its credential', async () => {
    nearlyUsedUp()

    const { status, body } = await askAlias({ 'no-credential': 0.2 })

    expect(status).toBe(200)
    expect(body).toMatchObject({
      x_pi: {
        attempts: [{ model: 'no-credential/cold-mock', reason: 'quota', skipped: true }]
      }
    })
  })

  // Catches the reserve applied where none is configured: the first target's missing credential
  // is still the answer, as the alias's `fallbackOn` doesn't name `auth`.
  test('without a reserve, a missing credential is still the answer', async () => {
    nearlyUsedUp()

    const { status, body } = await askAlias(undefined)

    expect(status).toBe(502)
    expect(body).toMatchObject({ error: { code: 'upstream_credentials_missing' } })
  })

  // Pins when a reserve skip is decided (#386 review): once, before images are fetched, as a
  // cooldown skip is. The plan handed to the dispatch starts past the skipped login and lists the
  // skip, so a quota window that resets meanwhile doesn't bring the login back: the request
  // keeps to what `x_pi.attempts` says it did.
  test('decides a reserve skip once: a reset before the dispatch keeps the plan', async () => {
    configure({ 'no-credential': 0.2 })
    nearlyUsedUp()
    const exposure = await readExposure()
    const alias = exposure.ok
      ? exposure.aliases.find((exposed) => exposed.publicId === ALIAS)
      : undefined
    if (alias === undefined) throw new Error('the alias should be exposed')
    const route = planLogins(alias, false, [])

    const start = await findCredentialedStart(
      { ...route, reserve: { 'no-credential': 0.2 } },
      undefined,
      ALIAS,
      undefined
    )
    clearAllQuotas()

    expect(start).toMatchObject({
      kind: 'ready',
      candidates: [{ canonicalId: `healthy/${HEALTHY_MODEL}` }],
      attempts: [{ model: 'no-credential/cold-mock', reason: 'quota', skipped: true }]
    })
    expect(start.kind === 'ready' ? start.candidates : []).toHaveLength(1)
  })
})
