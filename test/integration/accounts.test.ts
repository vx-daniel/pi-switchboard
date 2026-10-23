/**
 * Several logins per provider (#227), end to end: a stored `groq-2` credential gets its
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
/** A second built-in Groq model, whose first login refuses the credential. */
const REFUSING_MODEL = 'llama-3.3-70b-versatile'
/** A third built-in Groq model, overloaded under every login. */
const OVERLOADED_MODEL = 'openai/gpt-oss-20b'
/** Another provider's model, for an alias's next target. */
const OTHER_MODEL = 'answer-mock'
/** That provider's key. */
const OTHER_KEY = 'notarealsecret-other-provider-key'

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

/**
 * Answers by the key the request carries: the first login's credential is refused, any other
 * answers.
 *
 * @param response - the response to write
 * @param request - the request, whose `Authorization` names the login
 */
const refusingFirstLogin: MockReply = (response, request) =>
  request.headers.authorization === `Bearer ${FIRST_KEY}`
    ? httpError(401, { error: { message: 'Invalid API key', type: 'invalid_request_error' } })(
        response,
        request
      )
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
  mock = await startMockProvider({
    [MODEL]: byLogin,
    [REFUSING_MODEL]: refusingFirstLogin,
    [OVERLOADED_MODEL]: httpError(503, { error: { message: 'Overloaded', type: 'server_error' } }),
    [OTHER_MODEL]: ANSWER
  })
  // Each login keeps pi's built-in Groq catalog, pointed at the mock: the base's entry carries
  // its key, the slot's entry composes above the copy and never sees that key.
  agentDir = await loadFixtureAgentDir({
    modelsJson: {
      providers: {
        'groq': { baseUrl: `${mock.origin}/v1`, apiKey: FIRST_KEY },
        'groq-2': { baseUrl: `${mock.origin}/v1` },
        'groq-3': { baseUrl: `${mock.origin}/v1` },
        'other': {
          baseUrl: `${mock.origin}/v1`,
          api: 'openai-completions',
          apiKey: OTHER_KEY,
          models: [{ id: OTHER_MODEL }]
        }
      }
    },
    authJson: { 'groq-2': { type: 'api_key', key: SECOND_KEY } }
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
 * @param options - stream or not, and extra request headers
 * @returns the status, the body (parsed when not streamed, else the raw SSE text), and the
 *   upstream keys in call order
 */
async function ask(
  model: string,
  options: { readonly stream?: boolean; readonly headers?: Record<string, string> } = {}
): Promise<{ status: number; body: unknown; upstreamKeys: (string | undefined)[] }> {
  const before = mock.requests.length
  const response = await createApp(testConfig(), fileConfigReader).request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...options.headers },
    body: JSON.stringify({
      model,
      stream: options.stream === true,
      messages: [{ role: 'user', content: 'Say ok' }]
    })
  })
  const text = await response.text()
  const body: unknown = options.stream === true ? text : JSON.parse(text)
  const upstreamKeys = mock.requests
    .slice(before)
    .map((request) => request.headers.authorization?.replace('Bearer ', ''))
  return { status: response.status, body, upstreamKeys }
}

/**
 * Reads the `x_pi` of each chunk of a streamed response.
 *
 * @param stream - the response body
 * @returns each data chunk's `x_pi`, in order
 */
function chunkXPi(stream: string): unknown[] {
  return stream
    .split('\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line) => {
      const chunk: unknown = JSON.parse(line.slice('data: '.length))
      return isRecord(chunk) ? chunk['x_pi'] : undefined
    })
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
    expect(ids.some((ownedId) => ownedId.includes('groq-2'))).toBe(false)

    expect(await loginsOfModel()).toEqual(['groq', 'groq-2'])

    const creds = await jsonBody(
      await createApp(testConfig(), fileConfigReader).request('/healthz/creds')
    )
    const providers = isRecord(creds) && Array.isArray(creds['providers']) ? creds['providers'] : []
    expect(
      providers.map((provider: unknown) => (isRecord(provider) ? provider['provider'] : undefined))
    ).toEqual(expect.arrayContaining(['groq', 'groq-2']))
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
        login: 'groq-2',
        attempts: [{ model: `groq/${MODEL}`, login: 'groq', reason: 'rate_limit' }]
      }
    })
    expect(
      isRecord(answer.body) && isRecord(answer.body['x_pi']) && 'alias' in answer.body['x_pi']
    ).toBe(false)
    expect(activeCooldown({ provider: 'groq', canonicalId: `groq/${MODEL}` })?.provider).toBe(
      'groq'
    )
    expect(activeCooldown({ provider: 'groq-2', canonicalId: `groq/${MODEL}` })).toBeUndefined()
  })

  // Catches an alias target's effort lost when the model expands into its logins (#230): the
  // second login would run at the request's effort, and the attempt on the first wouldn't say
  // what it ran at.
  test("an alias target's effort carries over to every login", async () => {
    setConfig({ aliases: { 'quiet-groq': { model: `groq/${MODEL}`, reasoningEffort: 'none' } } })
    try {
      const answer = await ask('quiet-groq')

      expect(answer.upstreamKeys).toEqual([FIRST_KEY, SECOND_KEY])
      expect(answer.body).toMatchObject({
        x_pi: {
          alias: 'quiet-groq',
          login: 'groq-2',
          reasoning_effort: { requested: null, applied: 'none' },
          attempts: [
            {
              model: `groq/${MODEL}`,
              login: 'groq',
              reasoning_effort: 'none',
              reason: 'rate_limit'
            }
          ]
        }
      })
    } finally {
      setConfig({})
    }
  })

  // Catches a streamed answer that hides the login hop: every chunk carries `x_pi.login` and the
  // attempt, as the non-streamed body does (principle VI).
  test('a streamed answer names the login in every chunk', async () => {
    const answer = await ask(MODEL, { stream: true })

    expect(answer.status).toBe(200)
    const found = chunkXPi(typeof answer.body === 'string' ? answer.body : '')
    expect(found.length).toBeGreaterThan(0)
    for (const fields of found) {
      expect(fields).toMatchObject({
        login: 'groq-2',
        attempts: [{ model: `groq/${MODEL}`, login: 'groq', reason: 'rate_limit' }]
      })
    }
  })

  // Catches a request with its own upstream key handed to another login (the key is the
  // client's, so no login of the proxy's is chosen), or its 429 cooling the proxy's login.
  test('a request with its own upstream key keeps the first login and cools nothing', async () => {
    const answer = await ask(MODEL, {
      headers: { 'X-Switchboard-Upstream-Api-Key': FIRST_KEY }
    })

    expect(answer.status).toBe(429)
    expect(answer.upstreamKeys).toEqual([FIRST_KEY])
    expect(activeCooldown({ provider: 'groq', canonicalId: `groq/${MODEL}` })).toBeUndefined()
  })

  // Catches a class the alias names but the logins do not (`auth`) being taken between logins,
  // or ending the request although the alias's next model could answer: the model's other logins
  // are skipped, and the next model is tried (#227).
  test("an alias moves past all of a model's logins on a class only the alias names", async () => {
    setConfig({
      aliases: {
        chain: { targets: [`groq/${REFUSING_MODEL}`, `other/${OTHER_MODEL}`], fallbackOn: ['auth'] }
      }
    })
    try {
      const answer = await ask('chain')

      expect(answer.status).toBe(200)
      expect(answer.upstreamKeys).toEqual([FIRST_KEY, OTHER_KEY])
      expect(answer.body).toMatchObject({
        model: `other/${OTHER_MODEL}`,
        x_pi: {
          alias: 'chain',
          attempts: [{ model: `groq/${REFUSING_MODEL}`, login: 'groq', reason: 'auth' }]
        }
      })
    } finally {
      setConfig({})
    }
  })

  // Catches a 503 cooling only the login that met it, or handed to the next login although
  // `routing.logins.fallbackOn` leaves `unavailable` out: an overload is the model's, under every
  // login, and the client gets it.
  test('a 503 is answered and cools the model under every login', async () => {
    const answer = await ask(OVERLOADED_MODEL)

    expect(answer.status).toBe(503)
    expect(answer.upstreamKeys).toEqual([FIRST_KEY])
    const canonicalId = `groq/${OVERLOADED_MODEL}`
    expect(activeCooldown({ provider: 'groq', canonicalId })).toMatchObject({ scope: 'model' })
    expect(activeCooldown({ provider: 'groq-2', canonicalId })).toMatchObject({ scope: 'model' })
    expect(activeCooldown({ provider: 'groq-2', canonicalId: `groq/${MODEL}` })).toBeUndefined()
  })

  // Catches a cooling login called again by the next request, or the skip hidden: the first login
  // is skipped while its 429 cooldown lasts, and the skip is in `x_pi.attempts`.
  test('is called first while the first login cools down', async () => {
    await ask(MODEL)
    const answer = await ask(MODEL)

    expect(answer.upstreamKeys).toEqual([SECOND_KEY])
    expect(answer.body).toMatchObject({
      x_pi: {
        login: 'groq-2',
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
    expect((await ask(`groq-2/${MODEL}`)).status).toBe(404)
  })

  // Catches the console offering no way to add a login: a logged-in provider's next free slot
  // must be in the list, named after the base, while a slot and an unconfigured provider offer
  // none (a slot of a slot, or a login nobody has).
  test('the login list offers the next free slot of a logged-in provider only', () => {
    const options = loginOptions(getRuntime()).map((option) => `${option.id}: ${option.name}`)

    expect(options).toContain('groq-2: Groq 2')
    expect(options).toContain('groq-3: Groq 3')
    expect(options.filter((option) => option.startsWith('groq-'))).toHaveLength(2)
    expect(options.some((option) => option.includes('-2-'))).toBe(false)
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
      { providerId: 'groq-3', type: 'api_key', deviceId: () => 'device' },
      screens
    )

    expect(await loginsOfModel()).toEqual(['groq', 'groq-2', 'groq-3'])
    const ids = (await listed('/v1/models')).map((model: unknown) =>
      isRecord(model) ? model['id'] : undefined
    )
    expect(ids.filter((modelId) => modelId === MODEL)).toHaveLength(1)
    expect(loginOptions(getRuntime()).map((option) => option.id)).toContain('groq-4')
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
      { providerId: 'groq-4', type: 'api_key', deviceId: () => 'device' },
      screens
    )
    cancel.abort()

    await expect(login).rejects.toThrow()
    expect(getRuntime().getRegisteredNativeProvider('groq-4')).toBeUndefined()
    expect(loginOptions(getRuntime()).map((option) => option.id)).toContain('groq-4')
  })

  // Catches a logout that removes the credential but keeps the slot as a provider (it would stay
  // in the login list unconfigured, and the next login would skip its number) or keeps its label
  // (the next login under the ID, maybe another account, would wear it).
  test('logging out of a slot drops it and its label, and offers its number again', async () => {
    saveLoginLabel('groq-3', 'third')

    await runLogout(getRuntime(), 'groq-3', new AbortController().signal)

    expect(getRuntime().getRegisteredNativeProvider('groq-3')).toBeUndefined()
    expect(loginLabels()).not.toHaveProperty('groq-3')
    expect(await loginsOfModel()).toEqual(['groq', 'groq-2'])
    const options = loginOptions(getRuntime()).map((option) => option.id)
    expect(options).toContain('groq-3')
    expect(options).not.toContain('groq-4')
  })
})
