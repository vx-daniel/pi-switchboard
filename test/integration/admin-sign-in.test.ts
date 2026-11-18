/**
 * The admin listener's sign-in (#367), end to end against a fake GitHub: the redirect with `state`
 * and a PKCE challenge, the callback that exchanges the code with the matching verifier, the role
 * from the editors and viewers lists, the session it gives, and what is refused. Also that the
 * admin listener and the API listener never accept each other's credentials (constitution I, III).
 */

import { type AdminAppOptions, createAdminApp } from '@proxy/admin/app'
import type { GitHubFetch } from '@proxy/admin/github'
import { pkceChallenge } from '@proxy/admin/sealed'
import { type AdminUiSettings, resolveAdminUi } from '@proxy/config/admin'
import { ADMIN_UI_DEFAULTS } from '@proxy/config/admin-schema'
import { createApp } from '@proxy/server/app'
import type { Hono } from 'hono'
import { describe, expect, test } from 'vite-plus/test'

import { testConfig } from '../helpers'

const ORIGIN = 'http://127.0.0.1:4142'
const HOST = '127.0.0.1:4142'
const CLIENT_SECRET = 'notarealsecret-client-secret'
const USER_TOKEN = 'notarealsecret-user-token'
const PROXY_TOKEN = 'notarealsecret-proxy-token'
const ENV = {
  PI_SWITCHBOARD_GITHUB_CLIENT_ID: 'Iv1.notarealclient',
  PI_SWITCHBOARD_GITHUB_CLIENT_SECRET: CLIENT_SECRET,
  PI_SWITCHBOARD_ADMIN_SESSION_KEY: 'notarealsecret-session-key-0123456789abcdef'
}

/**
 * Creates the admin app as the listener would, with a loopback API listener behind it.
 *
 * @param options - the app's options but the API listener's settings
 * @returns the app
 */
function adminApp(options: Omit<AdminAppOptions, 'server'>): Hono {
  return createAdminApp({
    ...options,
    server: { host: '127.0.0.1', docsUiEnabled: false, statsEnabled: false, proxyAuth: false }
  })
}

/** What the fake GitHub saw. */
interface GitHubLog {
  readonly exchanges: URLSearchParams[]
  readonly apiCalls: string[]
}

/** How the fake GitHub answers. */
interface GitHubScript {
  readonly login?: string
  /**
   * Team memberships by `org/slug` as the path names them: a state (`active`, `pending`), or a
   * status GitHub fails with. A team not here answers `404`.
   */
  readonly memberships?: Readonly<Record<string, string | number>>
  /** An error answer to the code exchange, instead of a token. */
  readonly exchangeError?: Record<string, unknown>
}

/**
 * Makes a fake GitHub: the code exchange, `GET /user` and team memberships, recording each call.
 *
 * @param script - how it answers
 * @returns its `fetch` and its log
 */
function fakeGitHub(script: GitHubScript = {}): { fetch: GitHubFetch; log: GitHubLog } {
  const log: GitHubLog = { exchanges: [], apiCalls: [] }
  const fetch: GitHubFetch = async (input, init) => {
    const url = new URL(input)
    if (url.pathname === '/login/oauth/access_token') {
      log.exchanges.push(new URLSearchParams(typeof init.body === 'string' ? init.body : ''))
      return Response.json(
        script.exchangeError ?? { access_token: USER_TOKEN, token_type: 'bearer' }
      )
    }
    log.apiCalls.push(url.pathname)
    const auth = new Headers(init.headers).get('authorization')
    if (auth !== `Bearer ${USER_TOKEN}`) return new Response('bad token', { status: 401 })
    if (url.pathname === '/user') return Response.json({ login: script.login ?? 'alice', id: 42 })
    const membership = /^\/orgs\/([^/]+)\/teams\/([^/]+)\/memberships\/([^/]+)$/u.exec(url.pathname)
    const answer =
      membership === null
        ? undefined
        : script.memberships?.[`${membership[1] ?? ''}/${membership[2] ?? ''}`]
    if (typeof answer === 'number') return new Response('GitHub is down', { status: answer })
    if (typeof answer === 'string') return Response.json({ state: answer, role: 'member' })
    return new Response('not found', { status: 404 })
  }
  return { fetch, log }
}

/**
 * Resolves admin UI settings that may start: loopback, sign-in configured.
 *
 * @param lists - who may sign in
 * @param lists.editors - who may change settings
 * @param lists.viewers - who may only read
 * @returns the settings, sign-in present
 */
function settingsWith(lists: {
  editors?: string[]
  viewers?: string[]
}): AdminUiSettings & { readonly signIn: NonNullable<AdminUiSettings['signIn']> } {
  const settings = resolveAdminUi({ ...ADMIN_UI_DEFAULTS, enabled: true, ...lists }, ENV)
  const configured = settings.signIn
  if (configured === undefined) throw new Error('sign-in should be configured')
  return { ...settings, signIn: configured }
}

/**
 * Reads one cookie a response sets, as the next request would send it.
 *
 * @param response - the response
 * @param name - the cookie
 * @returns `name=value`, or `undefined` when it sets none
 */
function cookieFrom(response: Response, name: string): string | undefined {
  const set = response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`))
  return set?.split(';')[0]
}

/**
 * Starts a sign-in and follows it back from GitHub, as a browser would.
 *
 * @param app - the admin app
 * @param stateOverride - a `state` to send back instead of the one GitHub was given
 * @returns the callback's response, and the authorize address it went to
 */
async function signIn(
  app: Hono,
  stateOverride?: string
): Promise<{ callback: Response; authorize: URL }> {
  const start = await app.request('/admin/auth/sign-in', { headers: { host: HOST } })
  const authorize = new URL(start.headers.get('location') ?? '')
  const pending = cookieFrom(start, 'pi_switchboard_admin_sign_in') ?? ''
  const state = stateOverride ?? authorize.searchParams.get('state') ?? ''
  const callback = await app.request(
    `/admin/auth/callback?code=github-code&state=${encodeURIComponent(state)}`,
    { headers: { host: HOST, cookie: pending } }
  )
  return { callback, authorize }
}

describe('admin sign-in', () => {
  // Catches a sign-in GitHub would refuse or that a stolen code could finish: the authorize
  // address carries the App, the callback, a state and an S256 challenge, and the exchange sends
  // the verifier whose hash is that challenge, with the client secret.
  test('sends GitHub a PKCE challenge and exchanges the code with its verifier', async () => {
    const github = fakeGitHub()
    const app = adminApp({
      settings: settingsWith({ editors: ['alice'] }),
      fetch: github.fetch
    })

    const { callback, authorize } = await signIn(app)

    expect(authorize.origin + authorize.pathname).toBe('https://github.com/login/oauth/authorize')
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
      client_id: 'Iv1.notarealclient',
      redirect_uri: `${ORIGIN}/admin/auth/callback`,
      code_challenge_method: 'S256'
    })
    const [exchange] = github.log.exchanges
    expect(exchange?.get('client_secret')).toBe(CLIENT_SECRET)
    expect(exchange?.get('code')).toBe('github-code')
    expect(pkceChallenge(exchange?.get('code_verifier') ?? '')).toBe(
      authorize.searchParams.get('code_challenge')
    )
    expect(callback.status).toBe(302)
  })

  // Catches a session that does not say who signed in with which role, or a user token kept in
  // the cookie.
  test('gives an editor a session that names them and holds no token', async () => {
    const app = adminApp({
      settings: settingsWith({ editors: ['alice'] }),
      fetch: fakeGitHub().fetch
    })
    const { callback } = await signIn(app)
    const session = cookieFrom(callback, 'pi_switchboard_admin') ?? ''

    const answer = await app.request('/admin/api/session', {
      headers: { host: HOST, cookie: session }
    })

    expect(await answer.json()).toEqual({ login: 'alice', role: 'editor' })
    expect(
      Buffer.from(session.split('=')[1]?.split('.')[0] ?? '', 'base64url').toString()
    ).not.toContain(USER_TOKEN)
  })

  // Catches a team role never given, a pending invitation taken for a membership, or GitHub asked
  // about a team when the login alone decides.
  test.each([
    { who: 'an active member', state: 'active', session: { login: 'carol', role: 'viewer' } },
    { who: 'someone only invited', state: 'pending', session: null }
  ])('gives a team role to $who', async ({ state, session: expected }) => {
    const github = fakeGitHub({ login: 'carol', memberships: { 'my-org/readers': state } })
    const app = adminApp({
      settings: settingsWith({ viewers: ['My-Org/readers'] }),
      fetch: github.fetch
    })

    const { callback } = await signIn(app)
    const session = cookieFrom(callback, 'pi_switchboard_admin')
    const answer = await app.request('/admin/api/session', {
      headers: { host: HOST, cookie: session ?? '' }
    })

    expect(github.log.apiCalls).toContain('/orgs/my-org/teams/readers/memberships/carol')
    expect(answer.ok ? await answer.json() : null).toEqual(expected)
  })

  // Catches a team check GitHub fails turning into a 502 for everyone (a GitHub App installed on
  // no organization, or without Members: read): a login still decides, and only the team role is
  // lost.
  test('a failed team check only loses the team role', async () => {
    const github = fakeGitHub({ login: 'bob', memberships: { 'my-org/ops': 403 } })
    const app = adminApp({
      settings: settingsWith({ editors: ['my-org/ops'], viewers: ['bob'] }),
      fetch: github.fetch
    })

    const { callback } = await signIn(app)
    const session = cookieFrom(callback, 'pi_switchboard_admin') ?? ''
    const answer = await app.request('/admin/api/session', {
      headers: { host: HOST, cookie: session }
    })

    expect(callback.status).toBe(302)
    expect(await answer.json()).toEqual({ login: 'bob', role: 'viewer' })
  })

  // Catches a callback finished without the sign-in it belongs to (login CSRF), someone neither
  // list names let in, or GitHub's error answer shown to the browser.
  test.each([
    {
      refused: 'a state that does not match',
      settings: settingsWith({ editors: ['alice'] }),
      script: {},
      state: 'forged-state',
      status: 400
    },
    {
      refused: 'someone neither list names',
      settings: settingsWith({ editors: ['bob'] }),
      script: {},
      state: undefined,
      status: 403
    },
    {
      refused: 'a code GitHub refuses',
      settings: settingsWith({ editors: ['alice'] }),
      script: {
        exchangeError: {
          error: 'bad_verification_code',
          error_description: 'notarealsecret detail'
        }
      },
      state: undefined,
      status: 502
    }
  ])('refuses $refused, with no session', async ({ settings, script, state, status }) => {
    const app = adminApp({ settings, fetch: fakeGitHub(script).fetch })

    const { callback } = await signIn(app, state)

    expect(callback.status).toBe(status)
    expect(cookieFrom(callback, 'pi_switchboard_admin')).toBeUndefined()
    expect(await callback.text()).not.toContain('notarealsecret')
  })

  // Catches the callback replayed with the same sign-in cookie after it finished once.
  test('the sign-in cookie is cleared by the callback', async () => {
    const app = adminApp({
      settings: settingsWith({ editors: ['alice'] }),
      fetch: fakeGitHub().fetch
    })

    const { callback } = await signIn(app)

    expect(
      callback.headers
        .getSetCookie()
        .find((cookie) => cookie.startsWith('pi_switchboard_admin_sign_in='))
    ).toMatch(/Max-Age=0/u)
  })
})

describe('admin listener guards', () => {
  const app = adminApp({
    settings: settingsWith({ editors: ['alice'] }),
    fetch: fakeGitHub().fetch
  })

  // Catches a DNS-rebinding page (its own Host) or a foreign page (its Origin) reaching the admin
  // UI, or a write without an Origin (CSRF).
  test.each([
    {
      request: 'a foreign Host',
      method: 'GET',
      path: '/admin/api/session',
      headers: { host: 'evil.example:4142' },
      status: 403
    },
    {
      request: 'a foreign Origin',
      method: 'GET',
      path: '/admin/api/session',
      headers: { host: HOST, origin: 'https://evil.example' },
      status: 403
    },
    {
      request: 'a write without an Origin',
      method: 'POST',
      path: '/admin/auth/sign-out',
      headers: { host: HOST },
      status: 403
    },
    {
      request: 'a write from the admin UI',
      method: 'POST',
      path: '/admin/auth/sign-out',
      headers: { host: HOST, origin: ORIGIN },
      status: 204
    }
  ])('$request: $method $path answers $status', async ({ method, path, headers, status }) => {
    const response = await app.request(path, { method, headers })

    expect(response.status).toBe(status)
  })

  // Catches the callback's address (GitHub's code in its query) leaked as a Referer, or the admin
  // pages framed or loaded with a foreign script.
  test('every response carries the security headers', async () => {
    const response = await app.request('/admin/api/session', { headers: { host: HOST } })

    expect(Object.fromEntries(response.headers)).toMatchObject({
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store'
    })
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
  })

  // Catches sign-in left open to guessing (past the limit a client waits), or the limit reaching
  // sign-out, which an operator behind a shared reverse-proxy address must always reach.
  test('rate limits sign-in per client, never sign-out', async () => {
    const limited = adminApp({
      settings: settingsWith({ editors: ['alice'] }),
      fetch: fakeGitHub().fetch,
      clientKey: () => 'one-client'
    })
    const statuses: number[] = []
    for (let attempt = 0; attempt < 21; attempt++) {
      statuses.push(
        (await limited.request('/admin/auth/sign-in', { headers: { host: HOST } })).status
      )
    }
    const signOut = await limited.request('/admin/auth/sign-out', {
      method: 'POST',
      headers: { host: HOST, origin: ORIGIN }
    })

    expect(statuses.at(-1)).toBe(429)
    expect(statuses.slice(0, 20).every((status) => status === 302)).toBe(true)
    expect(signOut.status).toBe(204)
  })
})

describe('the two listeners never accept each other', () => {
  // Catches the proxy token (which every client, j5 workers included, holds) opening the admin UI.
  test('the proxy token does not sign in to the admin UI', async () => {
    const app = adminApp({
      settings: settingsWith({ editors: ['alice'] }),
      fetch: fakeGitHub().fetch
    })

    const response = await app.request('/admin/api/session', {
      headers: { host: HOST, authorization: `Bearer ${PROXY_TOKEN}` }
    })

    expect(response.status).toBe(401)
  })

  // Catches an operator's session cookie admitted to the API listener, and the admin routes served
  // there.
  test('an admin session admits to no API route, and the API serves no admin route', async () => {
    const admin = adminApp({
      settings: settingsWith({ editors: ['alice'] }),
      fetch: fakeGitHub().fetch
    })
    const { callback } = await signIn(admin)
    const session = cookieFrom(callback, 'pi_switchboard_admin') ?? ''
    const api = createApp({ ...testConfig(), proxyAuth: { kind: 'token', token: PROXY_TOKEN } })

    const models = await api.request('/v1/models', { headers: { cookie: session } })
    const adminOnApi = await api.request('/admin/api/session', {
      headers: { cookie: session, authorization: `Bearer ${PROXY_TOKEN}` }
    })

    expect(models.status).toBe(401)
    expect(adminOnApi.status).toBe(404)
  })
})
