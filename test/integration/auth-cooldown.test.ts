/**
 * A refused credential cools its login (#357) and marks it failing (#388): a 401 from the
 * provider, or a credential pi can't resolve, is remembered for 2 minutes, so a route whose
 * `fallbackOn` names `auth` passes the dead login over instead of paying its round trip on every
 * request, and `/v1/switchboard/models` says the login fails until it works again. Two logins of
 * pi's built-in Groq provider against the mock, the proxy as deployed (its config file read per
 * request).
 */

import { activeCooldown, clearAllCooldowns } from '@proxy/pi/cooldowns'
import { clearLoginHealth } from '@proxy/pi/login-health'
import { createApp } from '@proxy/server/app'
import { fileConfigReader } from '@proxy/server/routes'
import { isRecord } from '@proxy/utils/guards'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir, writeProxyConfig } from '../fixtures/agent-dir'
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

/** The first login's key, which the provider refuses. */
const DEAD_KEY = 'notarealsecret-dead-login-key'
/** The second login's key, stored in pi's auth.json as a login would. */
const LIVE_KEY = 'notarealsecret-live-login-key'
/** One of pi's built-in Groq models: both logins serve it. */
const MODEL = 'llama-3.3-70b-versatile'
/** The model as the cooldown store names it. */
const CANONICAL_ID = `groq/${MODEL}`
/** A key command that prints nothing: pi can't resolve a credential for it (#128). */
const NO_CREDENTIAL = '!true'
/** The model of the provider whose credential doesn't resolve. */
const COLD_MODEL = 'cold-mock'
/** Another provider's model, an alias's next target. */
const OTHER_MODEL = 'answer-mock'
/** That provider's key. */
const OTHER_KEY = 'notarealsecret-other-provider-key'
/** A short answer. */
const ANSWER = sse([...textChunks('ok'), finishChunk('stop')])

/**
 * Refuses the first login's key with a 401, and answers any other.
 *
 * @param response - the response to write
 * @param request - the request, whose `Authorization` names the login
 */
const refusingDeadKey: MockReply = (response, request) =>
  request.headers.authorization === `Bearer ${DEAD_KEY}`
    ? httpError(401, { error: { message: 'Invalid API key', type: 'invalid_request_error' } })(
        response,
        request
      )
    : ANSWER(response, request)

let mock: MockProvider
let agentDir: FixtureAgentDir

beforeAll(async () => {
  mock = await startMockProvider({ [MODEL]: refusingDeadKey, [OTHER_MODEL]: ANSWER })
  agentDir = await loadFixtureAgentDir({
    modelsJson: {
      providers: {
        'groq': { baseUrl: `${mock.origin}/v1`, apiKey: DEAD_KEY },
        'groq-2': { baseUrl: `${mock.origin}/v1` },
        'no-credential': {
          baseUrl: `${mock.origin}/v1`,
          api: 'openai-completions',
          apiKey: NO_CREDENTIAL,
          models: [{ id: COLD_MODEL }]
        },
        'other': {
          baseUrl: `${mock.origin}/v1`,
          api: 'openai-completions',
          apiKey: OTHER_KEY,
          models: [{ id: OTHER_MODEL }]
        }
      }
    },
    authJson: { 'groq-2': { type: 'api_key', key: LIVE_KEY } }
  })
})

beforeEach(() => {
  clearAllCooldowns()
  clearLoginHealth()
  writeProxyConfig(agentDir.path, {})
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await mock.close()
  agentDir.remove()
})

/**
 * Writes `routing.logins.fallbackOn`.
 *
 * @param classes - the failure classes that move a request to the next login
 */
function loginFallbackOn(classes: readonly string[]): void {
  writeProxyConfig(agentDir.path, { routing: { logins: { fallbackOn: classes } } })
}

/**
 * Sends one chat request and records the key each upstream request carried.
 *
 * @param model - the request's `model`
 * @param headers - extra request headers
 * @returns the status, the parsed body, and the upstream keys in call order
 */
async function ask(
  model: string = MODEL,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: unknown; upstreamKeys: (string | undefined)[] }> {
  const before = mock.requests.length
  const response = await createApp(testConfig(), fileConfigReader).request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Say ok' }] })
  })
  const body = await jsonBody(response)
  const upstreamKeys = mock.requests
    .slice(before)
    .map((request) => request.headers.authorization?.replace('Bearer ', ''))
  return { status: response.status, body, upstreamKeys }
}

/**
 * Reads a model's entry on `/v1/switchboard/models`.
 *
 * @param id - the model's public ID
 * @returns the entry, or `undefined` when it isn't listed
 */
async function switchboardEntry(id: string): Promise<unknown> {
  const body = await jsonBody(
    await createApp(testConfig(), fileConfigReader).request('/v1/switchboard/models')
  )
  const data: unknown = isRecord(body) ? body['data'] : undefined
  return Array.isArray(data)
    ? (data as unknown[]).find((model) => isRecord(model) && model['id'] === id)
    : undefined
}

describe('a refused credential', () => {
  // Catches a refused credential remembered nowhere (#357): with `auth` named between logins, the
  // first request pays the round trip to the dead login and moves on, and the next request skips
  // it without calling it, saying so in `x_pi.attempts`.
  test('is skipped by the next request when the hop past it names auth', async () => {
    loginFallbackOn(['rate_limit', 'auth'])

    const first = await ask()
    expect(first.status).toBe(200)
    expect(first.upstreamKeys).toEqual([DEAD_KEY, LIVE_KEY])

    const second = await ask()

    expect(second.upstreamKeys).toEqual([LIVE_KEY])
    expect(second.body).toMatchObject({
      x_pi: {
        login: 'groq-2',
        attempts: [{ model: CANONICAL_ID, login: 'groq', reason: 'auth', skipped: true }]
      }
    })
  })

  // Catches the cooldown applied where no hop names `auth` (principle VI): by default the dead
  // login is still called and its refusal is the answer, while the operator sees it cooling.
  test('is still called while no hop names auth, and shows as cooling', async () => {
    const first = await ask()
    const second = await ask()

    expect([first.status, second.status]).toEqual([502, 502])
    expect(second.upstreamKeys).toEqual([DEAD_KEY])
    expect(activeCooldown({ provider: 'groq', canonicalId: CANONICAL_ID })).toMatchObject({
      scope: 'provider',
      reason: 'auth'
    })
  })

  // Catches a request's own upstream key cooling the proxy's login: its refusal says nothing about
  // the credential other clients share (#181 review).
  test('of a per-request key cools nothing', async () => {
    const answer = await ask(MODEL, { 'X-Switchboard-Upstream-Api-Key': DEAD_KEY })

    expect(answer.upstreamKeys).toEqual([DEAD_KEY])
    expect(activeCooldown({ provider: 'groq', canonicalId: CANONICAL_ID })).toBeUndefined()
  })

  // Catches the preflight forgetting a credential that doesn't resolve (#388: an OAuth token that
  // would not refresh, resolved again on every request): the login cools, and the alias, which
  // names `auth`, passes it over on the next request without resolving it again.
  test('that does not resolve cools its login from the preflight', async () => {
    writeProxyConfig(agentDir.path, {
      aliases: {
        pair: {
          targets: [`no-credential/${COLD_MODEL}`, `other/${OTHER_MODEL}`],
          fallbackOn: ['auth']
        }
      }
    })

    const first = await ask('pair')

    expect(first.status).toBe(200)
    expect(first.upstreamKeys).toEqual([OTHER_KEY])
    expect(
      activeCooldown({ provider: 'no-credential', canonicalId: `no-credential/${COLD_MODEL}` })
    ).toMatchObject({ reason: 'auth' })
    const second = await ask('pair')
    expect(second.body).toMatchObject({
      x_pi: { attempts: [{ model: `no-credential/${COLD_MODEL}`, reason: 'auth', skipped: true }] }
    })
  })
})

describe("a login's credential health (#388)", () => {
  // Catches the LAN host's blind spot: a login that answers 401 was reported enabled, free and
  // within quota while every request failed. With the default `fallbackOn` the dead login is the
  // one a request calls, so the model itself reads failing, with why; the other login, never
  // reached, stays unknown.
  test('a login the provider refuses reads failing, and so does the model routing would call it for', async () => {
    await ask()

    const failing = {
      status: 'failing',
      last_ok: null,
      last_failure: {
        at: expect.any(Number) as number,
        reason: 'the provider refused the credential (401 or 403)'
      }
    }
    expect(await switchboardEntry(MODEL)).toMatchObject({
      credential: failing,
      logins: [
        { id: 'groq', credential: failing },
        { id: 'groq-2', credential: { status: 'unknown', last_ok: null, last_failure: null } }
      ]
    })
  })

  // Catches a login reading failing after it worked again, or working before anything proved it:
  // the latest result wins, and an answer under the login is what shows it good.
  test('a login that answers reads working, with when; the model follows the login routing calls', async () => {
    loginFallbackOn(['rate_limit', 'auth'])
    await ask()

    const entry = await switchboardEntry(MODEL)

    expect(entry).toMatchObject({
      routing: { next: { login: 'groq-2' } },
      credential: { status: 'working', last_ok: expect.any(Number) as number },
      logins: [{ id: 'groq', credential: { status: 'failing' } }, { id: 'groq-2' }]
    })
  })

  // Catches a credential pi can't resolve (#388: an OAuth refresh rejected) reported without why,
  // or learned only from a request: a verification checks every login, and gives pi's summary.
  test("a credential that doesn't resolve reads failing with pi's reason, from a verification too", async () => {
    const verified = await createApp(testConfig(), fileConfigReader).request(
      '/healthz/creds?verify=true'
    )
    // A provider whose credential fails makes the check fail: 503, and the details in the body.
    expect(verified.status).toBe(503)

    expect(await switchboardEntry(COLD_MODEL)).toMatchObject({
      credential: {
        status: 'failing',
        last_failure: { reason: expect.stringMatching(/no-credential/) as string }
      }
    })
  })
})
