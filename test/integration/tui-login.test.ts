/**
 * Logins in the console (#61), through pi's real `ModelRuntime.login` against a fixture agent
 * directory: pi runs the flow and stores the credential, and the proxy serves the new models at
 * once. The screens are scripted; pi's own dialog only draws what these calls tell it.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { getRuntime } from '@proxy/pi/registry'
import { loginOptions, logoutOptions, runLogin, runLogout } from '@proxy/tui/login'
import { isRecord } from '@proxy/utils/guards'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'
import { scriptedScreens } from '../fixtures/login-screens'
import { testApp } from '../helpers'

/** The account provider the tests register: its login asks pi's three kinds of question. */
const PROVIDER = 'test-account'
/** Its one model. */
const MODEL = 'account-model'
/** A device ID, as pi's settings would give one. */
const DEVICE_ID = '00000000-0000-4000-8000-000000000000'

let agentDir: FixtureAgentDir

/**
 * Registers an account provider whose login asks for a method, shows a sign-in URL and asks for
 * a code, then stores an access token made of both answers. Nothing leaves the machine.
 */
function registerAccountProvider(): void {
  getRuntime().registerProvider(PROVIDER, {
    name: 'Test account',
    baseUrl: 'http://127.0.0.1:9/v1',
    api: 'openai-completions',
    models: [
      {
        id: MODEL,
        name: 'Account model',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 4096
      }
    ],
    oauth: {
      name: 'Test account',
      login: async (callbacks) => {
        const method = await callbacks.onSelect({
          message: 'Login method',
          options: [
            { id: 'browser', label: 'In a browser' },
            { id: 'device', label: 'With a device code' }
          ]
        })
        callbacks.onAuth({
          url: 'https://login.example.invalid/authorize',
          instructions: 'Sign in'
        })
        const code = await callbacks.onPrompt({ message: 'Paste the code' })
        return {
          access: `${method ?? 'none'}:${code}`,
          refresh: 'notarealsecret-refresh',
          expires: Date.now() + 3_600_000
        }
      },
      refreshToken: async (credentials) => credentials,
      getApiKey: (credentials) => credentials.access
    }
  })
}

/**
 * Lists the model IDs the proxy serves.
 *
 * @returns the IDs from `GET /v1/models`
 */
async function servedModels(): Promise<unknown[]> {
  const body: unknown = await (await testApp().request('/v1/models')).json()
  const data = isRecord(body) ? body['data'] : undefined
  return Array.isArray(data)
    ? data.map((model: unknown) => (isRecord(model) ? model['id'] : model))
    : []
}

/**
 * Reads pi's stored credentials from the fixture agent directory.
 *
 * @returns `auth.json`, parsed
 */
function storedCredentials(): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(join(agentDir.path, 'auth.json'), 'utf8'))
  return isRecord(parsed) ? parsed : {}
}

beforeEach(async () => {
  agentDir = await loadFixtureAgentDir({ authJson: {} })
  registerAccountProvider()
})

afterEach(() => {
  vi.unstubAllEnvs()
  agentDir.remove()
})

describe('a login in the console', () => {
  // Catches a login pi stores but the proxy only serves after a restart, which the console exists
  // to avoid: the same runtime answers requests, so the model is listed at once.
  test('stores the credential with pi and serves the new models at once', async () => {
    expect(await servedModels()).not.toContain(MODEL)
    const { screens } = scriptedScreens({
      choose: 'browser',
      answer: 'the-code',
      signal: new AbortController().signal
    })

    await runLogin(
      getRuntime(),
      { providerId: PROVIDER, type: 'oauth', deviceId: () => DEVICE_ID },
      screens
    )

    expect(await servedModels()).toContain(MODEL)
    expect(storedCredentials()[PROVIDER]).toMatchObject({
      type: 'oauth',
      access: 'browser:the-code'
    })
  })

  // Catches pi's questions routed to the wrong screen: a choice must reach the selector and its
  // answer the flow, the sign-in URL the dialog, a code prompt the dialog's input.
  test("routes pi's choice, URL and prompt to the screens that answer them", async () => {
    const { screens, shown } = scriptedScreens({
      choose: 'device',
      answer: 'abc',
      signal: new AbortController().signal
    })

    await runLogin(
      getRuntime(),
      { providerId: PROVIDER, type: 'oauth', deviceId: () => DEVICE_ID },
      screens
    )

    expect(shown).toEqual([
      'select Login method',
      'auth https://login.example.invalid/authorize',
      'prompt Paste the code'
    ])
    expect(storedCredentials()[PROVIDER]).toMatchObject({ access: 'device:abc' })
  })

  // Catches Esc on pi's dialog leaving the login waiting forever, or storing half a credential.
  test('cancelled from the dialog, fails and stores nothing', async () => {
    const cancel = new AbortController()
    const { screens, shown } = scriptedScreens({
      choose: 'browser',
      answer: undefined,
      signal: cancel.signal
    })

    const login = runLogin(
      getRuntime(),
      { providerId: PROVIDER, type: 'oauth', deviceId: () => DEVICE_ID },
      screens
    )
    await vi.waitFor(() => expect(shown).toContain('prompt Paste the code'))
    cancel.abort()

    await expect(login).rejects.toThrow()
    expect(storedCredentials()).not.toHaveProperty(PROVIDER)
    expect(await servedModels()).not.toContain(MODEL)
  })

  // Catches an API key login (a built-in provider, pi's own key prompt) that pi saves but the
  // proxy does not serve, or a key that ends up anywhere but pi's store.
  test("with an API key, serves the provider's models at once", async () => {
    const { screens } = scriptedScreens({
      choose: 'unused',
      answer: 'notarealsecret-openai-key',
      signal: new AbortController().signal
    })

    await runLogin(
      getRuntime(),
      { providerId: 'openai', type: 'api_key', deviceId: () => DEVICE_ID },
      screens
    )

    const served = await servedModels()
    expect(
      served.some((modelId) => typeof modelId === 'string' && modelId.startsWith('gpt-'))
    ).toBe(true)
    expect(storedCredentials()['openai']).toMatchObject({
      type: 'api_key',
      key: 'notarealsecret-openai-key'
    })
  })
})

describe("the console's login picker", () => {
  // Catches a provider missing from the picker, a provider offering an account and an API key
  // listed only once, or a provider still shown as not configured after its login.
  test('lists each login pi offers, and marks a provider configured once logged in', async () => {
    const openai = loginOptions(getRuntime()).filter((option) => option.id === 'openai')
    expect(openai.map((option) => option.authType).toSorted()).toEqual(['api_key', 'oauth'])
    const before = loginOptions(getRuntime()).find((option) => option.id === PROVIDER)
    expect(before).toMatchObject({ name: 'Test account', authType: 'oauth' })
    expect(before?.status).toBeUndefined()

    const { screens } = scriptedScreens({
      choose: 'browser',
      answer: 'the-code',
      signal: new AbortController().signal
    })
    await runLogin(
      getRuntime(),
      { providerId: PROVIDER, type: 'oauth', deviceId: () => DEVICE_ID },
      screens
    )

    const after = loginOptions(getRuntime()).find((option) => option.id === PROVIDER)
    expect(after?.status).toMatchObject({ type: 'oauth' })
  })
})

describe('a logout in the console', () => {
  // Catches a logout the proxy keeps serving: pi removes the credential and the models go with it.
  test("lists pi's stored credential, and logging out stops serving its models", async () => {
    const { screens } = scriptedScreens({
      choose: 'browser',
      answer: 'the-code',
      signal: new AbortController().signal
    })
    await runLogin(
      getRuntime(),
      { providerId: PROVIDER, type: 'oauth', deviceId: () => DEVICE_ID },
      screens
    )

    expect((await logoutOptions(getRuntime())).map((option) => option.id)).toEqual([PROVIDER])
    await runLogout(getRuntime(), PROVIDER, new AbortController().signal)

    expect(await servedModels()).not.toContain(MODEL)
    expect(storedCredentials()).not.toHaveProperty(PROVIDER)
  })
})
