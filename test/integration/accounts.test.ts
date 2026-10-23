/**
 * Several logins per provider (#227), end to end: a stored `groq-account-2` credential gets its
 * provider at startup, a copy of pi's built-in `groq` provider with its own credential in pi's
 * store, and the console adds and drops further slots. The proxy runs as deployed (its config
 * file read per request) against the mock provider, which tells the two logins apart by the key
 * each request carries.
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
/** A 429 as OpenAI sends it. */
const RATE_LIMITED = httpError(429, {
  error: { message: 'Rate limit reached', type: 'rate_limit_error' }
})
/** A short answer. */
const ANSWER = sse([...textChunks('ok'), finishChunk('stop')])

/**
 * Answers by the key the request carries: the first login is rate limited, the second answers.
 *
 * @param response - the response to write
 * @param request - the request, whose `Authorization` names the login
 */
const byLogin: MockReply = (response, request) =>
  request.headers.authorization === `Bearer ${SECOND_KEY}`
    ? ANSWER(response, request)
    : RATE_LIMITED(response, request)

let mock: MockProvider
let agentDir: FixtureAgentDir

beforeAll(async () => {
  mock = await startMockProvider({ 'chat-mock': byLogin })
  // Each login is its own models.json provider: the entry under the copy's ID composes above it,
  // and the base's entry (its key included) does not reach the copy.
  const atMock = { baseUrl: `${mock.origin}/v1`, models: [{ id: 'chat-mock' }] }
  agentDir = await loadFixtureAgentDir({
    modelsJson: {
      providers: { 'groq': { ...atMock, apiKey: FIRST_KEY }, 'groq-account-2': atMock }
    },
    authJson: { 'groq-account-2': { type: 'api_key', key: SECOND_KEY } }
  })
  writeFileSync(
    join(agentDir.path, 'proxy-config.json'),
    JSON.stringify({
      aliases: {
        chain: {
          targets: ['groq/chat-mock', 'groq-account-2/chat-mock'],
          fallbackOn: ['rate_limit']
        }
      }
    })
  )
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

describe('an extra login', () => {
  // Catches the copy missing from the model list, listed under the base's ID, or listed although
  // its own credential is absent (it has the base's key, or none): both logins must be exposed
  // models, since a chain reaches only exposed models (principle IV). The console's login list
  // must offer it too, or there is no way to log in to it.
  test('is an exposed model of its own, with its own credential, offered for login', async () => {
    const models = await createApp(testConfig(), fileConfigReader).request('/v1/models')
    const listed = await jsonBody(models)
    const ids = isRecord(listed) && Array.isArray(listed['data']) ? listed['data'] : []

    expect(models.status).toBe(200)
    expect(ids.map((model: unknown) => (isRecord(model) ? model['id'] : undefined))).toEqual(
      expect.arrayContaining(['groq/chat-mock', 'groq-account-2/chat-mock'])
    )

    const creds = await jsonBody(
      await createApp(testConfig(), fileConfigReader).request('/healthz/creds')
    )
    const providers = isRecord(creds) && Array.isArray(creds['providers']) ? creds['providers'] : []
    expect(
      providers.map((provider: unknown) => (isRecord(provider) ? provider['provider'] : undefined))
    ).toEqual(expect.arrayContaining(['groq', 'groq-account-2']))

    expect(loginOptions(getRuntime()).map((option) => `${option.id}: ${option.name}`)).toContain(
      'groq-account-2: Groq (account 2)'
    )
  })

  // Catches the second login sending the first login's key, the chain not reaching it, or the
  // rate limit cooling both logins: each is a provider of its own to routing, cooldowns and x_pi.
  test('answers through a fallback chain when the first login is rate limited', async () => {
    const answer = await ask('chain')

    expect(answer.status).toBe(200)
    expect(answer.upstreamKeys).toEqual([FIRST_KEY, SECOND_KEY])
    expect(answer.body).toMatchObject({
      model: 'groq-account-2/chat-mock',
      x_pi: { alias: 'chain', attempts: [{ model: 'groq/chat-mock', reason: 'rate_limit' }] }
    })
    expect(activeCooldown({ provider: 'groq', canonicalId: 'groq/chat-mock' })?.provider).toBe(
      'groq'
    )
    expect(
      activeCooldown({ provider: 'groq-account-2', canonicalId: 'groq-account-2/chat-mock' })
    ).toBeUndefined()
  })

  // Catches a request that names the second login reaching the first: the model named is the
  // login called, as with any other provider.
  test('is called directly when a request names it', async () => {
    const answer = await ask('groq-account-2/chat-mock')

    expect(answer.status).toBe(200)
    expect(answer.upstreamKeys).toEqual([SECOND_KEY])
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
  // registered first), or that reaches another login's models. The slot's catalog is the built-in
  // one, as its models.json has no entry of its own.
  test('logging in to the next slot registers it and serves its models at once', async () => {
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

    const models = await jsonBody(
      await createApp(testConfig(), fileConfigReader).request('/v1/models')
    )
    const ids = isRecord(models) && Array.isArray(models['data']) ? models['data'] : []
    expect(
      ids.some(
        (model: unknown) =>
          isRecord(model) &&
          typeof model['id'] === 'string' &&
          model['id'].startsWith('groq-account-3/')
      )
    ).toBe(true)
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
    expect(getRuntime().getProvider('groq-account-4')).toBeUndefined()
    expect(loginOptions(getRuntime()).map((option) => option.id)).toContain('groq-account-4')
  })

  // Catches a logout that removes the credential but keeps the slot as a provider (it would stay
  // in the login list unconfigured, and the next login would skip its number) or keeps its label
  // (the next login under the ID, maybe another account, would wear it).
  test('logging out of a slot drops it and its label, and offers its number again', async () => {
    saveLoginLabel('groq-account-3', 'third')

    await runLogout(getRuntime(), 'groq-account-3', new AbortController().signal)

    expect(getRuntime().getProvider('groq-account-3')).toBeUndefined()
    expect(loginLabels()).not.toHaveProperty('groq-account-3')
    const options = loginOptions(getRuntime()).map((option) => option.id)
    expect(options).toContain('groq-account-3')
    expect(options).not.toContain('groq-account-4')
  })
})
