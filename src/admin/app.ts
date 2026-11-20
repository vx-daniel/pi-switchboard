/**
 * The admin listener's HTTP app (#367): operator sign-in with the operator's own GitHub App, the
 * session it gives, and nothing else yet; the pages come in the next slice.
 *
 * @remarks
 * Routes, all under `/admin/`:
 * - `GET /admin/auth/sign-in` starts a sign-in: a `state` and a PKCE verifier in a sealed sign-in
 *   cookie (10 minutes, path `/admin/auth`), then a redirect to GitHub.
 * - `GET /admin/auth/callback` finishes it: the cookie's `state` must match GitHub's, the code is
 *   exchanged for a user token, the token answers who the operator is (and their teams when a role
 *   lists a team), and a role from `adminUi.editors`/`viewers` gives a sealed session cookie (8
 *   hours, path `/admin`). The token is then dropped.
 * - `POST /admin/auth/sign-out` ends the session.
 * - `GET /admin/api/session` says who is signed in, with which role.
 *
 * Every response carries a strict CSP, `X-Content-Type-Options: nosniff`, `Referrer-Policy:
 * no-referrer` (the callback's address holds GitHub's code) and `Cache-Control: no-store`.
 * Requests must name the admin UI's own address as `Host`; an `Origin`, when sent, must be its
 * own, and a write must send one. Sign-in and callback are rate limited per client address.
 *
 * Nothing here reads the proxy token or a provider credential, and the API listener serves none
 * of these routes (constitution I, III).
 *
 * @packageDocumentation
 */

import { timingSafeEqual } from 'node:crypto'

import { createAdminApi } from '@proxy/admin/api'
import type { AdminAssets } from '@proxy/admin/assets'
import {
  authorizeUrl,
  exchangeCode,
  type GitHubFetch,
  isActiveTeamMember,
  readUser
} from '@proxy/admin/github'
import { addPageRoutes } from '@proxy/admin/pages'
import type { AdminServerFacts } from '@proxy/admin/reads'
import { roleFor, type TeamCheck } from '@proxy/admin/roles'
import { createSealer, pkceChallenge, randomToken, type Sealer } from '@proxy/admin/sealed'
import {
  fileRevocations,
  openSession,
  type Revocations,
  type SessionData,
  SessionDataSchema
} from '@proxy/admin/sessions'
import type { AdminSignIn, AdminUiSettings } from '@proxy/config/admin'
import { proxyLogger } from '@proxy/logging'
import {
  HTTP_BAD_GATEWAY,
  HTTP_BAD_REQUEST,
  HTTP_FORBIDDEN,
  HTTP_FOUND,
  HTTP_NO_CONTENT,
  HTTP_NOT_FOUND,
  HTTP_TOO_MANY_REQUESTS
} from '@proxy/server/http-status'
import { errorMessage, isRecord } from '@proxy/utils/guards'
import { MS_PER_SECOND } from '@proxy/utils/time'
import { Hono, type MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import * as z from 'zod'

/** Logger for the admin listener. */
const adminLogger = proxyLogger('admin')
/** Logger for sign-in and sign-out. */
const authLogger = proxyLogger('admin', 'auth')

/** Seconds in a minute. */
const SECONDS_PER_MINUTE = 60
/** Minutes in an hour. */
const MINUTES_PER_HOUR = 60
/** Minutes a sign-in may take, from the redirect to GitHub to the callback. */
const SIGN_IN_MINUTES = 10
/** Hours a session lasts. */
const SESSION_HOURS = 8
/** How long a sign-in may take, in seconds. */
const SIGN_IN_SECONDS = SIGN_IN_MINUTES * SECONDS_PER_MINUTE
/** How long a session lasts, in seconds. */
const SESSION_SECONDS = SESSION_HOURS * MINUTES_PER_HOUR * SECONDS_PER_MINUTE
/** Sign-in and callback requests one client address may make per window. */
const SIGN_IN_LIMIT = 20

/** What a refusal adds when a list names a team: the cause GitHub's `404` cannot tell apart. */
const TEAM_REFUSAL_HINT =
  '; if they are in a listed team, check that the GitHub App is installed on its organization with Members: read (a private App installs only on the account that owns it)'

/** The rate limit's window, in milliseconds. */
const SIGN_IN_WINDOW_MS = SECONDS_PER_MINUTE * MS_PER_SECOND
/** The most client addresses the rate limit tracks; past it, the oldest are forgotten. */
const MAX_TRACKED_CLIENTS = 1000

/** The sign-in cookie's name. */
const SIGN_IN_COOKIE = 'pi_switchboard_admin_sign_in'
/** The session cookie's name. */
const SESSION_COOKIE = 'pi_switchboard_admin'

/**
 * Finds one cookie's value in a `Cookie` header. The admin cookies are base64url and `.`, which a
 * `Cookie` header carries as they are, so nothing is decoded.
 *
 * @param cookieHeader - the header, or `undefined` when the request sent none
 * @param name - the cookie
 * @returns its value, or `undefined` when the header has none of that name
 */
function cookieValue(cookieHeader: string | undefined, name: string): string | undefined {
  const prefix = `${name}=`
  return cookieHeader
    ?.split(';')
    .map((pair) => pair.trim())
    .find((pair) => pair.startsWith(prefix))
    ?.slice(prefix.length)
}

/** The headers every admin response carries. */
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store'
}

/** What the sign-in cookie carries. */
const SignInSchema = z.object({
  state: z.string().trim().min(1),
  verifier: z.string().trim().min(1)
})

/** What a sign-in gives: the session's data but its ID. */
type SignedIn = Omit<SessionData, 'sid'>

/** What the admin app runs with. */
export interface AdminAppOptions {
  /** The resolved settings; sign-in must be configured (`adminUiProblems` empty). */
  readonly settings: AdminUiSettings & { readonly signIn: AdminSignIn }
  /** The `fetch` GitHub is asked with; the global one by default. */
  readonly fetch?: GitHubFetch
  /** The time, in milliseconds since the epoch; `Date.now` by default. */
  readonly now?: () => number
  /**
   * The client's address, for the rate limit; the Node socket's peer by default.
   *
   * @param env - the request's Hono env (`incoming`, `outgoing` under `@hono/node-server`)
   * @returns a key for the client
   */
  readonly clientKey?: (env: unknown) => string
  /** The API listener's settings, for the doctor and the stats. */
  readonly server: AdminServerFacts
  /** The built pages, or `undefined` when this build has none (`/admin/` then says so). */
  readonly assets?: AdminAssets | undefined
  /** The signed-out sessions; kept in pi's agent directory by default. */
  readonly revocations?: Revocations
}

/** What the route groups share. */
interface AdminDeps {
  readonly settings: AdminUiSettings & { readonly signIn: AdminSignIn }
  readonly sealer: Sealer
  readonly fetchFn: GitHubFetch
  readonly now: () => number
  readonly publicOrigin: URL
  readonly redirectUri: string
  /** Whether cookies are `Secure`: exactly when the admin UI is `https`. */
  readonly secure: boolean
  /** The API listener's settings, for the doctor and the stats. */
  readonly server: AdminServerFacts
  /** The signed-out sessions. */
  readonly revocations: Revocations
}

/** A refusal a callback answers with: its status and its text. */
interface Refusal {
  readonly status: typeof HTTP_BAD_REQUEST | typeof HTTP_FORBIDDEN | typeof HTTP_BAD_GATEWAY
  readonly text: string
}

/**
 * Compares two strings in constant time.
 *
 * @param left - one string
 * @param right - the other
 * @returns whether they are equal
 */
function sameSecret(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

/**
 * Makes a fixed-window rate limiter per client key.
 *
 * @param now - the clock
 * @returns a function saying whether one more request from a client is allowed
 */
function rateLimiter(now: () => number): (key: string) => boolean {
  const windows = new Map<string, { start: number; count: number }>()
  return (key) => {
    const time = now()
    const current = windows.get(key)
    if (current === undefined || time - current.start >= SIGN_IN_WINDOW_MS) {
      windows.delete(key)
      windows.set(key, { start: time, count: 1 })
      if (windows.size > MAX_TRACKED_CLIENTS) {
        const oldest = windows.keys().next().value
        if (oldest !== undefined) windows.delete(oldest)
      }
      return true
    }
    current.count += 1
    return current.count <= SIGN_IN_LIMIT
  }
}

/**
 * Reads the client's address from the Node socket `@hono/node-server` puts in the env, or one
 * shared key when there is none (a test calling the app directly).
 *
 * @param env - the request's Hono env
 * @returns the peer's address, or `unknown`
 */
function socketKey(env: unknown): string {
  const incoming = isRecord(env) ? env['incoming'] : undefined
  const socket = isRecord(incoming) ? incoming['socket'] : undefined
  const address = isRecord(socket) ? socket['remoteAddress'] : undefined
  return typeof address === 'string' ? address : 'unknown'
}

/**
 * Adds the guards every request passes: the security headers, the admin UI's own `Host` and
 * `Origin`, and the sign-in rate limit.
 *
 * @param app - the admin app
 * @param deps - what the routes share
 * @param clientKey - the client's key for the rate limit
 */
function addGuards(app: Hono, deps: AdminDeps, clientKey: (env: unknown) => string): void {
  const { publicOrigin } = deps
  const allowSignIn = rateLimiter(deps.now)

  app.use('*', async (context, next) => {
    await next()
    for (const [header, headerValue] of Object.entries(SECURITY_HEADERS)) {
      context.header(header, headerValue)
    }
  })

  // The admin UI's own address only: no DNS-rebinding Host, no foreign Origin, and a write must
  // say where it comes from (CSRF).
  app.use('*', async (context, next) => {
    const request = { method: context.req.method, path: context.req.path }
    if (context.req.header('host') !== publicOrigin.host) {
      adminLogger.warn('Refused {method} {path}: Host is not the admin UI address', request)
      return context.text('Not the admin UI address', HTTP_FORBIDDEN)
    }
    const origin = context.req.header('origin')
    const write = request.method !== 'GET' && request.method !== 'HEAD'
    if (origin === undefined ? write : origin !== publicOrigin.origin) {
      adminLogger.warn('Refused {method} {path}: Origin is not the admin UI', request)
      return context.text('Refused: the request does not come from the admin UI', HTTP_FORBIDDEN)
    }
    await next()
    return undefined
  })

  // Only the requests that start or finish a sign-in: sign-out and the API never wait on it. Behind
  // a reverse proxy every request comes from its address, so per-client limits belong there; the
  // listener does not trust a forwarded address, which a client can write.
  const limit: MiddlewareHandler = async (context, next) => {
    if (!allowSignIn(clientKey(context.env))) {
      return context.text('Too many sign-in attempts; wait a minute', HTTP_TOO_MANY_REQUESTS)
    }
    await next()
    return undefined
  }
  app.use('/admin/auth/sign-in', limit)
  app.use('/admin/auth/callback', limit)
}

/**
 * Makes the team check for one sign-in: asks GitHub whether the operator is an active member of a
 * team, counting a check GitHub fails as no membership, so a failure can only lower a role.
 *
 * @param deps - what the routes share
 * @param token - the operator's user token
 * @param login - the operator's login
 * @returns the check
 */
function teamCheck(deps: AdminDeps, token: string, login: string): TeamCheck {
  return async (team) => {
    try {
      return await isActiveTeamMember(deps.fetchFn, deps.settings.apiUrl, token, { team, login })
    } catch (error) {
      authLogger.warn('Could not check {login} in {team}; counted as not a member: {error}', {
        login,
        team,
        error: errorMessage(error)
      })
      return false
    }
  }
}

/**
 * Finishes a sign-in GitHub sent back: exchanges the code, asks who the operator is, and gives
 * their role. The user token goes no further than these calls.
 *
 * @param deps - what the routes share
 * @param code - GitHub's code
 * @param verifier - the sign-in's PKCE verifier
 * @returns what the session carries but its ID, or the refusal to answer with
 */
async function finishSignIn(
  deps: AdminDeps,
  code: string,
  verifier: string
): Promise<SignedIn | Refusal> {
  const { settings, fetchFn } = deps
  try {
    const exchanged = await exchangeCode(fetchFn, {
      githubUrl: settings.githubUrl,
      clientId: settings.signIn.clientId,
      clientSecret: settings.signIn.clientSecret,
      code,
      redirectUri: deps.redirectUri,
      verifier
    })
    if (exchanged.kind === 'refused') {
      authLogger.warn('GitHub sign-in failed: {reason}', { reason: exchanged.reason })
      return { status: HTTP_BAD_GATEWAY, text: 'GitHub refused the sign-in; try again' }
    }
    const user = await readUser(fetchFn, settings.apiUrl, exchanged.token)
    const grant = await roleFor(settings, user.login, teamCheck(deps, exchanged.token, user.login))
    if (grant === undefined) {
      // GitHub answers 404 for a team in an org the App is not installed on, as for a team the
      // operator is not in, so the log names that cause whenever a list names a team.
      const namesTeams = [...settings.editors, ...settings.viewers].some((principal) =>
        principal.includes('/')
      )
      authLogger.info('Refused sign-in of {login}: not in adminUi.editors or viewers{hint}', {
        login: user.login,
        hint: namesTeams ? TEAM_REFUSAL_HINT : ''
      })
      return { status: HTTP_FORBIDDEN, text: `${user.login} may not use this admin UI` }
    }
    return { login: user.login, id: user.id, role: grant.role, team: grant.team }
  } catch (error) {
    authLogger.warn('GitHub sign-in failed: {error}', { error: errorMessage(error) })
    return { status: HTTP_BAD_GATEWAY, text: 'GitHub could not be asked; try again' }
  }
}

/**
 * Adds the sign-in routes: start, and GitHub's callback.
 *
 * @param app - the admin app
 * @param deps - what the routes share
 */
function addSignIn(app: Hono, deps: AdminDeps): void {
  const { settings, sealer, now, secure } = deps
  const signInCookie = { path: '/admin/auth', httpOnly: true, secure, sameSite: 'Lax' } as const

  app.get('/admin/auth/sign-in', (context) => {
    const state = randomToken()
    const verifier = randomToken()
    const sealed = sealer.seal(
      'sign-in',
      { state, verifier },
      now() + SIGN_IN_SECONDS * MS_PER_SECOND
    )
    setCookie(context, SIGN_IN_COOKIE, sealed, { ...signInCookie, maxAge: SIGN_IN_SECONDS })
    const target = authorizeUrl({
      githubUrl: settings.githubUrl,
      clientId: settings.signIn.clientId,
      redirectUri: deps.redirectUri,
      state,
      challenge: pkceChallenge(verifier)
    })
    return context.redirect(target, HTTP_FOUND)
  })

  app.get('/admin/auth/callback', async (context) => {
    const pending = sealer.unseal(
      'sign-in',
      getCookie(context, SIGN_IN_COOKIE),
      SignInSchema,
      now()
    )
    deleteCookie(context, SIGN_IN_COOKIE, signInCookie)
    if (pending === undefined) {
      return context.text(
        'The sign-in expired or was not started here; sign in again',
        HTTP_BAD_REQUEST
      )
    }
    const state = context.req.query('state')
    if (state === undefined || !sameSecret(state, pending.state)) {
      authLogger.warn('Refused a sign-in callback: its state does not match')
      return context.text('The sign-in does not match; sign in again', HTTP_BAD_REQUEST)
    }
    if (context.req.query('error') !== undefined) {
      return context.text('GitHub sign-in was cancelled', HTTP_FORBIDDEN)
    }
    const code = context.req.query('code')
    if (code === undefined || code === '') {
      return context.text('GitHub sent no code; sign in again', HTTP_BAD_REQUEST)
    }
    const outcome = await finishSignIn(deps, code, pending.verifier)
    if ('status' in outcome) return context.text(outcome.text, outcome.status)
    const session: SessionData = { ...outcome, sid: randomToken() }
    const sealed = sealer.seal('session', session, now() + SESSION_SECONDS * MS_PER_SECOND)
    setCookie(context, SESSION_COOKIE, sealed, {
      path: '/admin',
      httpOnly: true,
      secure,
      sameSite: 'Lax',
      maxAge: SESSION_SECONDS
    })
    authLogger.info('Signed in {login} as {role}', { login: outcome.login, role: outcome.role })
    return context.redirect('/admin/', HTTP_FOUND)
  })
}

/**
 * Adds the session routes: sign-out, and the API under `/admin/api/`, which needs a session.
 *
 * @param app - the admin app
 * @param deps - what the routes share
 */
function addSession(app: Hono, deps: AdminDeps): void {
  const { sealer, now, secure, revocations } = deps
  const rules = { sealer, revocations, lists: deps.settings }

  // A signed-out session is revoked, not only forgotten by this browser: a copy of its cookie
  // stops working too (#383). Revoked until it would have expired, which sealing bounds.
  app.post('/admin/auth/sign-out', (context) => {
    const time = now()
    const data = sealer.unseal(
      'session',
      getCookie(context, SESSION_COOKIE),
      SessionDataSchema,
      time
    )
    deleteCookie(context, SESSION_COOKIE, { path: '/admin', secure })
    if (data !== undefined) {
      revocations.revoke(data.sid, time + SESSION_SECONDS * MS_PER_SECOND, time)
      authLogger.info('Signed out {login}', { login: data.login })
    }
    return context.body(null, HTTP_NO_CONTENT)
  })

  app.route(
    '/admin/api',
    createAdminApi({
      sessionOf: (cookieHeader) =>
        openSession(rules, cookieValue(cookieHeader, SESSION_COOKIE), now()),
      server: deps.server,
      now
    })
  )
}

/**
 * Creates the admin listener's app.
 *
 * @param options - the settings, and the seams tests replace
 * @returns the Hono app
 */
export function createAdminApp(options: AdminAppOptions): Hono {
  const { settings } = options
  const publicOrigin = new URL(settings.publicUrl)
  const deps: AdminDeps = {
    settings,
    sealer: createSealer(settings.signIn.sessionKey),
    fetchFn: options.fetch ?? ((input, init) => fetch(input, init)),
    now: options.now ?? Date.now,
    publicOrigin,
    redirectUri: `${publicOrigin.origin}/admin/auth/callback`,
    // A `Secure` cookie is kept from an `http` origin only on localhost; the admin UI is https
    // beyond loopback (`adminUiProblems`), so `Secure` exactly when it is https.
    secure: publicOrigin.protocol === 'https:',
    server: options.server,
    revocations: options.revocations ?? fileRevocations()
  }
  const app = new Hono()
  addGuards(app, deps, options.clientKey ?? socketKey)
  addSignIn(app, deps)
  addSession(app, deps)
  addPageRoutes(app, options.assets)
  app.notFound((context) => context.text('Not found', HTTP_NOT_FOUND))
  return app
}
