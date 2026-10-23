/**
 * Several logins per provider (#227), end to end: a stored `groq-account-2` credential gets its
 * provider at startup, a copy of pi's built-in `groq` provider with its own credential in pi's
 * store. The model is listed once, under the base's name, and the proxy picks the login: the
 * second when the first is rate limited. The console adds and drops further slots. The proxy runs
 * as deployed (its config file read per request) against the mock provider, which tells the
 * logins apart by the key each request carries.
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { activeCooldown, clearAllCooldowns } from '@proxy/pi/cooldowns'
import { getRuntime } from '@proxy/pi/registry'
import { createApp } from '@proxy/server/app'
import { fileConfigReader } from '@proxy/server/routes'
import { loginLabels, loginOptions, runLogin, runLogout, saveLoginLabel } from '@proxy/tui/login'
import { isRecord } from '@proxy/utils/guards'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'
import { scriptedScreens } from '../fixtures/login-screens'
import {
  finishChunk,
  httpError,
  type MockProvider,
  type MockReply,
  sse,
  startMockProvider,
  textChunks
} from '../fixtures/mock-provider'
import { jsonBody, testConfig } from '../helpers'

/** The first login's key, set in models.json as pi's own `groq` provider allows. */
const FIRST_KEY = 'notarealsecret-first-login-key'
/** The second login's key, stored in pi's auth.json under the copy's ID, as a login would. */
const SECOND_KEY = 'notarealsecret-second-login-key'
/** One of pi's built-in Groq models: the logins share the built-in catalog. */
const MODEL = 'llama-3.1-8b-instant'
/** A 429 as OpenAI sends it. */
const RATE_LIMITED = httpError(429, {
  error: { message: 'Rate limit reached', type: 'rate_limit_error' }
})
/** A short answer. */
const ANSWER = sse([...textChunks('ok'), finishChunk('stop')])

/**
 * Answers by the key the request carries: the first login is rate limited, any other answers.
 *
 * @param response - the response to write
 * @param request - the request, whose `Authorization` names the login
 */
const byLogin: MockReply = (response, request) =>
  request.headers.authorization === `Bearer ${FIRST_KEY}`
    ? RATE_LIMITED(response, request)
    : ANSWER(response, request)

let mock: MockProvider
let agentDir: FixtureAgentDir

/**
 * Writes the proxy's config file.
 *
 * @param config - the config, as JSON
 */
function setConfig(config: Record<string, unknown>): void {
  writeFileSync(join(agentDir.path, 'proxy-config.json'), JSON.stringify(config))
}

beforeAll(async () => {
  mock = await startMockProvider({ [MODEL]: byLogin })
  // Each login keeps pi's built-in Groq catalog, pointed at the mock: the base's entry carries
  // its key, the slot's entry composes above the copy and never sees that key.
  agentDir = await loadFixtureAgentDir({
    modelsJson: {
      providers: {
        'groq': { baseUrl: `${mock.origin}/v1`, apiKey: FIRST_KEY },
        'groq-account-2': { baseUrl: `${mock.origin}/v1` },
        'groq-account-3': { baseUrl: `${mock.origin}/v1` }
      }
    },
    authJson: { 'groq-account-2': { type: 'api_key', key: SECOND_KEY } }
  })
  setConfig({})
})

beforeEach(() => {
  clearAllCooldowns()
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await mock.close()
  agentDir.remove()
})

/**
 * Sends one chat request and records the key each upstream request carried.
 *
 * @param model - the request's `model`
 * @returns the status, the parsed body, and the upstream keys in call order
 */
async function ask(
  model: string
): Promise<{ status: number; body: unknown; upstreamKeys: (string | undefined)[] }> {
  const before = mock.requests.length
  const response = await createApp(testConfig(), fileConfigReader).request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Say ok' }] })
  })
  const body: unknown = await response.json()
  const upstreamKeys = mock.requests
    .slice(before)
    .map((request) => request.headers.authorization?.replace('Bearer ', ''))
  return { status: response.status, body, upstreamKeys }
}

/**
 * Reads a list response's entries.
 *
 * @param path - the route
 * @returns the `data` array, or none
 */
async function listed(path: string): Promise<unknown[]> {
  const body = await jsonBody(await createApp(testConfig(), fileConfigReader).request(path))
  const data: unknown = isRecord(body) ? body['data'] : undefined
  return Array.isArray(data) ? (data as unknown[]) : []
}

/**
 * Reads the model's entry on `/v1/switchboard/models`.
 *
 * @returns the entry's `logins` IDs
 */
async function loginsOfModel(): Promise<unknown[]> {
  const entry = (await listed('/v1/switchboard/models')).find(
    (model) => isRecord(model) && model['id'] === MODEL
  )
  const logins = isRecord(entry) && Array.isArray(entry['logins']) ? entry['logins'] : []
  return logins.map((login: unknown) => (isRecord(login) ? login['id'] : undefined))
}

describe('a second login', () => {
  // Catches the second login listed as a model of its own (every Claude model twice, and plain
  // names gone: j5's complaint), the model owned by the login rather than the provider, or the
  // login missing from the model's logins and from `/healthz/creds`.
  test('is a login of the base model, not a model of its own', async () => {
    const ids = (await listed('/v1/models')).map((model: unknown) =>
      isRecord(model) ? `${String(model['owned_by'])}:${String(model['id'])}` : ''
    )
    expect(ids).toContain(`groq:${MODEL}`)
    expect(ids.filter((ownedId) => ownedId.endsWith(`:${MODEL}`))).toHaveLength(1)
    expect(ids.some((ownedId) => ownedId.includes('groq-account-2'))).toBe(false)

    expect(await loginsOfModel()).toEqual(['groq', 'groq-account-2'])

    const creds = await jsonBody(
      await createApp(testConfig(), fileConfigReader).request('/healthz/creds')
    )
    const providers = isRecord(creds) && Array.isArray(creds['providers']) ? creds['providers'] : []
    expect(
      providers.map((provider: unknown) => (isRecord(provider) ? provider['provider'] : undefined))
    ).toEqual(expect.arrayContaining(['groq', 'groq-account-2']))
  })

  // Catches the second login sending the first login's key, the request not moving to it on the
  // first's 429, the hop hidden from the client, or the rate limit cooling both logins: the
  // response names the login (principle VI), and cooldowns are per login.
  test('serves a plain model name when the first login is rate limited', async () => {
    const answer = await ask(MODEL)

    expect(answer.status).toBe(200)
    expect(answer.upstreamKeys).toEqual([FIRST_KEY, SECOND_KEY])
    expect(answer.body).toMatchObject({
      model: `groq/${MODEL}`,
      x_pi: {
        login: 'groq-account-2',
        attempts: [{ model: `groq/${MODEL}`, login: 'groq', reason: 'rate_limit' }]
      }
    })
    expect(
      isRecord(answer.body) && isRecord(answer.body['x_pi']) && 'alias' in answer.body['x_pi']
    ).toBe(false)
    expect(activeCooldown({ provider: 'groq', canonicalId: `groq/${MODEL}` })?.provider).toBe(
      'groq'
    )
    expect(
      activeCooldown({ provider: 'groq-account-2', canonicalId: `groq/${MODEL}` })
    ).toBeUndefined()
  })

  // Catches a cooling login called again by the next request, or the skip hidden: the first login
  // is skipped while its 429 cooldown lasts, and the skip is in `x_pi.attempts`.
  test('is called first while the first login cools down', async () => {
    await ask(MODEL)
    const answer = await ask(MODEL)

    expect(answer.upstreamKeys).toEqual([SECOND_KEY])
    expect(answer.body).toMatchObject({
      x_pi: {
        login: 'groq-account-2',
        attempts: [{ model: `groq/${MODEL}`, login: 'groq', reason: 'rate_limit', skipped: true }]
      }
    })
  })

  // Catches a login hop the configuration does not name (principle VI): with
  // `routing.logins.fallbackOn` empty, the first login's 429 is the answer.
  test('is not tried when routing.logins.fallbackOn leaves rate limits out', async () => {
    setConfig({ routing: { logins: { fallbackOn: [] } } })
    try {
      const answer = await ask(MODEL)

      expect(answer.status).toBe(429)
      expect(answer.upstreamKeys).toEqual([FIRST_KEY])
    } finally {
      setConfig({})
    }
  })

  // Catches the slot's ID still resolving as a model: a client picks models, never logins.
  test('is not a model a request can name', async () => {
    expect((await ask(`groq-account-2/${MODEL}`)).status).toBe(404)
  })

  // Catches the console offering no way to add a login: a logged-in provider's next free slot
  // must be in the list, named after the base, while a slot and an unconfigured provider offer
  // none (a slot of a slot, or a login nobody has).
  test('the login list offers the next free slot of a logged-in provider only', () => {
    const options = loginOptions(getRuntime()).map((option) => `${option.id}: ${option.name}`)

    expect(options).toContain('groq-account-2: Groq (account 2)')
    expect(options).toContain('groq-account-3: Groq (account 3)')
    expect(options.filter((option) => option.startsWith('groq-account-'))).toHaveLength(2)
    expect(options.some((option) => option.includes('-account-2-account-'))).toBe(false)
    expect(options.some((option) => option.startsWith('anthropic-account-'))).toBe(false)
  })

  // Catches a login to a new slot that pi stores but the proxy never serves (the slot was not
  // registered first), or one that becomes a model of its own: it joins the model's logins.
  test('logging in to the next slot registers it as another login at once', async () => {
    const { screens } = scriptedScreens({
      choose: 'unused',
      answer: 'notarealsecret-third-login-key',
      signal: new AbortController().signal
    })

    await runLogin(
      getRuntime(),
      { providerId: 'groq-account-3', type: 'api_key', deviceId: () => 'device' },
      screens
    )

    expect(await loginsOfModel()).toEqual(['groq', 'groq-account-2', 'groq-account-3'])
    const ids = (await listed('/v1/models')).map((model: unknown) =>
      isRecord(model) ? model['id'] : undefined
    )
    expect(ids.filter((modelId) => modelId === MODEL)).toHaveLength(1)
    expect(loginOptions(getRuntime()).map((option) => option.id)).toContain('groq-account-4')
  })

  // Catches a cancelled login leaving an empty slot behind, which would then be listed as a
  // provider and push the next login to a higher number.
  test('a cancelled login to a new slot leaves no provider', async () => {
    const cancel = new AbortController()
    const { screens } = scriptedScreens({
      choose: 'unused',
      answer: undefined,
      signal: cancel.signal
    })
    const login = runLogin(
      getRuntime(),
      { providerId: 'groq-account-4', type: 'api_key', deviceId: () => 'device' },
      screens
    )
    cancel.abort()

    await expect(login).rejects.toThrow()
    expect(getRuntime().getRegisteredNativeProvider('groq-account-4')).toBeUndefined()
    expect(loginOptions(getRuntime()).map((option) => option.id)).toContain('groq-account-4')
  })

  // Catches a logout that removes the credential but keeps the slot as a provider (it would stay
  // in the login list unconfigured, and the next login would skip its number) or keeps its label
  // (the next login under the ID, maybe another account, would wear it).
  test('logging out of a slot drops it and its label, and offers its number again', async () => {
    saveLoginLabel('groq-account-3', 'third')

    await runLogout(getRuntime(), 'groq-account-3', new AbortController().signal)

    expect(getRuntime().getRegisteredNativeProvider('groq-account-3')).toBeUndefined()
    expect(loginLabels()).not.toHaveProperty('groq-account-3')
    expect(await loginsOfModel()).toEqual(['groq', 'groq-account-2'])
    const options = loginOptions(getRuntime()).map((option) => option.id)
    expect(options).toContain('groq-account-3')
    expect(options).not.toContain('groq-account-4')
  })
})
