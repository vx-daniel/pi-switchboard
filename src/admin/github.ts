/**
 * Signing an operator in with their GitHub App (#367), from GitHub's public documentation of the
 * GitHub App user access token web flow ("Generating a user access token for a GitHub App") and of
 * the REST endpoints `GET /user` and `GET /orgs/{org}/teams/{team_slug}/memberships/{username}`.
 *
 * @remarks
 * The flow: the browser goes to `<githubUrl>/login/oauth/authorize` with the App's client ID, the
 * callback, a `state` and a PKCE challenge (S256); GitHub sends it back to the callback with a
 * `code`; the proxy exchanges that code at `<githubUrl>/login/oauth/access_token` with the client
 * secret and the PKCE verifier for a user token, then asks the API who the user is and, only for
 * the teams a role lists, whether they are an active member of each.
 *
 * The user token goes no further than those requests: it is never stored, logged, put in a cookie
 * or in an error. A failure names a status or GitHub's OAuth error code, never an answer's body,
 * which could quote the request. `fetch` is injected, so tests answer for GitHub.
 *
 * @packageDocumentation
 */

import { HTTP_NOT_FOUND } from '@proxy/server/http-status'
import * as z from 'zod'

/** The `fetch` the client uses: the global one, or a test's. */
export type GitHubFetch = (input: string, init: RequestInit) => Promise<Response>

/** The REST API version the client asks for. */
const API_VERSION = '2022-11-28'

/** An OAuth error code, as GitHub sends one (`bad_verification_code`); anything else is not shown. */
const OAUTH_ERROR_CODE = /^[a-z_]{1,64}$/u

/** The code exchange's answer with a token; only the token is read. */
const TokenAnswerSchema = z.looseObject({ access_token: z.string().trim().min(1) })

/** The code exchange's answer without one; only the error code is read. */
const TokenErrorSchema = z.looseObject({ error: z.string().trim() })

/** `GET /user`; only the login and the id are read. */
const UserSchema = z.looseObject({
  login: z.string().trim().min(1),
  id: z.int().positive()
})

/** `GET /orgs/{org}/teams/{team_slug}/memberships/{username}`; only the state is read. */
const MembershipSchema = z.looseObject({ state: z.string().trim() })

/** A team a role lists, and the login to check in it. */
export interface TeamMembership {
  /** The team as `org/slug`. */
  readonly team: string
  readonly login: string
}

/** Whom GitHub signed in. */
export interface GitHubUser {
  readonly login: string
  readonly id: number
}

/** What starting a sign-in sends GitHub. */
export interface AuthorizeRequest {
  /** GitHub's web origin. */
  readonly githubUrl: string
  readonly clientId: string
  /** The admin UI's callback, as the App registers it. */
  readonly redirectUri: string
  readonly state: string
  /** The PKCE verifier's S256 challenge. */
  readonly challenge: string
}

/**
 * Builds the address a sign-in starts at.
 *
 * @param request - the App, the callback, the `state` and the challenge
 * @returns GitHub's authorize address with them
 */
export function authorizeUrl(request: AuthorizeRequest): string {
  const url = new URL('/login/oauth/authorize', request.githubUrl)
  url.searchParams.set('client_id', request.clientId)
  url.searchParams.set('redirect_uri', request.redirectUri)
  url.searchParams.set('state', request.state)
  url.searchParams.set('code_challenge', request.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  return url.toString()
}

/** What exchanging a code sends GitHub. */
export interface CodeExchange {
  readonly githubUrl: string
  readonly clientId: string
  readonly clientSecret: string
  readonly code: string
  readonly redirectUri: string
  readonly verifier: string
}

/** The code exchange's outcome: a user token, or why GitHub gave none. */
export type ExchangeResult =
  | { readonly kind: 'token'; readonly token: string }
  | { readonly kind: 'refused'; readonly reason: string }

/**
 * Reads an answer's JSON, or nothing when it is not JSON. Never the parser's error, whose message
 * quotes the answer.
 *
 * @param response - the answer
 * @returns its JSON, or `undefined`
 */
async function jsonOrUndefined(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

/**
 * Exchanges a sign-in's code for a user token.
 *
 * @param fetchFn - the `fetch` to use
 * @param exchange - the App, the code, the callback and the PKCE verifier
 * @returns the token, or why GitHub refused: its status or OAuth error code
 */
export async function exchangeCode(
  fetchFn: GitHubFetch,
  exchange: CodeExchange
): Promise<ExchangeResult> {
  const response = await fetchFn(new URL('/login/oauth/access_token', exchange.githubUrl).href, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      client_id: exchange.clientId,
      client_secret: exchange.clientSecret,
      code: exchange.code,
      redirect_uri: exchange.redirectUri,
      code_verifier: exchange.verifier
    }).toString()
  })
  if (!response.ok) {
    return {
      kind: 'refused',
      reason: `GitHub answered the code exchange ${String(response.status)}`
    }
  }
  const answer = await jsonOrUndefined(response)
  const token = TokenAnswerSchema.safeParse(answer)
  if (token.success) return { kind: 'token', token: token.data.access_token }
  const error = TokenErrorSchema.safeParse(answer)
  const code =
    error.success && OAUTH_ERROR_CODE.test(error.data.error) ? error.data.error : 'no token'
  return { kind: 'refused', reason: `GitHub refused the code: ${code}` }
}

/**
 * Asks one API path with the user's token.
 *
 * @param fetchFn - the `fetch` to use
 * @param apiUrl - GitHub's API origin and path
 * @param path - the endpoint
 * @param token - the user's token
 * @returns GitHub's answer, whatever its status
 */
async function askApi(
  fetchFn: GitHubFetch,
  apiUrl: string,
  path: string,
  token: string
): Promise<Response> {
  return fetchFn(`${apiUrl}${path}`, {
    method: 'GET',
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${token}`,
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': 'pi-switchboard'
    }
  })
}

/**
 * Asks who the token's user is (`GET /user`).
 *
 * @param fetchFn - the `fetch` to use
 * @param apiUrl - GitHub's API origin and path
 * @param token - the user's token
 * @returns their login and id
 * @throws Error when GitHub refuses, or answers without a login and id
 */
export async function readUser(
  fetchFn: GitHubFetch,
  apiUrl: string,
  token: string
): Promise<GitHubUser> {
  const response = await askApi(fetchFn, apiUrl, '/user', token)
  if (!response.ok) throw new Error(`GitHub answered /user ${String(response.status)}`)
  const user = UserSchema.safeParse(await jsonOrUndefined(response))
  if (!user.success) throw new Error('GitHub answered /user without a login and id')
  return { login: user.data.login, id: user.data.id }
}

/**
 * Asks whether a user is an active member of a team
 * (`GET /orgs/{org}/teams/{team_slug}/memberships/{username}`).
 *
 * @remarks
 * A GitHub App's user token sees a team only in an organization where the App is installed with
 * the organization's Members permission (read), and only when the user may see the team; GitHub
 * answers `404` otherwise, as for someone not in it. A pending invitation is no membership.
 *
 * @param fetchFn - the `fetch` to use
 * @param apiUrl - GitHub's API origin and path
 * @param token - the user's token
 * @param membership - the team, as `org/slug`, and the login
 * @returns whether the membership is `active`
 * @throws Error when GitHub answers anything but a membership or `404`
 */
export async function isActiveTeamMember(
  fetchFn: GitHubFetch,
  apiUrl: string,
  token: string,
  membership: TeamMembership
): Promise<boolean> {
  const [org = '', slug = ''] = membership.team.split('/')
  const path = `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(slug)}/memberships/${encodeURIComponent(membership.login)}`
  const response = await askApi(fetchFn, apiUrl, path, token)
  if (response.status === HTTP_NOT_FOUND) return false
  if (!response.ok) {
    throw new Error(
      `GitHub answered the membership of ${membership.team} ${String(response.status)}`
    )
  }
  const answer = MembershipSchema.safeParse(await jsonOrUndefined(response))
  if (!answer.success) {
    throw new Error(`GitHub answered the membership of ${membership.team} without a state`)
  }
  return answer.data.state === 'active'
}
