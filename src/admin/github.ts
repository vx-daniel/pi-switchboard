/**
 * Signing an operator in with their GitHub App (#367), from GitHub's public documentation of the
 * GitHub App user access token web flow ("Generating a user access token for a GitHub App") and of
 * the REST endpoints `GET /user` and `GET /user/teams`.
 *
 * @remarks
 * The flow: the browser goes to `<githubUrl>/login/oauth/authorize` with the App's client ID, the
 * callback, a `state` and a PKCE challenge (S256); GitHub sends it back to the callback with a
 * `code`; the proxy exchanges that code at `<githubUrl>/login/oauth/access_token` with the client
 * secret and the PKCE verifier for a user token, then asks the API who the user is and, only when a
 * role lists a team, which teams they are in.
 *
 * The user token goes no further than those requests: it is never stored, logged, put in a cookie
 * or in an error. A failure names a status or GitHub's OAuth error code, never an answer's body,
 * which could quote the request. `fetch` is injected, so tests answer for GitHub.
 *
 * @packageDocumentation
 */

import * as z from 'zod'

/** The `fetch` the client uses: the global one, or a test's. */
export type GitHubFetch = (input: string, init: RequestInit) => Promise<Response>

/** The REST API version the client asks for. */
const API_VERSION = '2022-11-28'

/** How many teams one page of `GET /user/teams` holds at most. */
const TEAMS_PER_PAGE = 100

/** The most pages of teams read: ten thousand teams, far past anyone's. */
const MAX_TEAM_PAGES = 100

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

/** One page of `GET /user/teams`; only each team's slug and organization are read. */
const TeamsPageSchema = z.array(
  z.looseObject({
    slug: z.string().trim().min(1),
    organization: z.looseObject({ login: z.string().trim().min(1) })
  })
)

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
 * Reads one API path with the user's token.
 *
 * @param fetchFn - the `fetch` to use
 * @param apiUrl - GitHub's API origin and path
 * @param path - the endpoint and query
 * @param token - the user's token
 * @returns the answer's JSON, or `undefined` when it is not JSON
 * @throws Error naming the endpoint and the status when GitHub refuses
 */
async function readApi(
  fetchFn: GitHubFetch,
  apiUrl: string,
  path: string,
  token: string
): Promise<unknown> {
  const response = await fetchFn(`${apiUrl}${path}`, {
    method: 'GET',
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${token}`,
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': 'pi-switchboard'
    }
  })
  if (!response.ok) {
    throw new Error(`GitHub answered ${path.split('?')[0] ?? path} ${String(response.status)}`)
  }
  return jsonOrUndefined(response)
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
  const user = UserSchema.safeParse(await readApi(fetchFn, apiUrl, '/user', token))
  if (!user.success) throw new Error('GitHub answered /user without a login and id')
  return { login: user.data.login, id: user.data.id }
}

/**
 * Lists the teams the token's user is in (`GET /user/teams`, every page), as `org/slug`.
 *
 * @remarks
 * A GitHub App's user token lists only teams in organizations where the App is installed with
 * the organization's Members permission (read); a team elsewhere is simply not listed.
 *
 * @param fetchFn - the `fetch` to use
 * @param apiUrl - GitHub's API origin and path
 * @param token - the user's token
 * @returns each team as `org/slug`, lowercase
 * @throws Error when GitHub refuses, or answers a page that is not a list of teams
 */
export async function readTeams(
  fetchFn: GitHubFetch,
  apiUrl: string,
  token: string
): Promise<string[]> {
  const teams: string[] = []
  for (let page = 1; page <= MAX_TEAM_PAGES; page++) {
    const answer = await readApi(
      fetchFn,
      apiUrl,
      `/user/teams?per_page=${String(TEAMS_PER_PAGE)}&page=${String(page)}`,
      token
    )
    const parsed = TeamsPageSchema.safeParse(answer)
    if (!parsed.success) throw new Error('GitHub answered /user/teams with no list of teams')
    for (const team of parsed.data) {
      teams.push(`${team.organization.login}/${team.slug}`.toLowerCase())
    }
    if (parsed.data.length < TEAMS_PER_PAGE) break
  }
  return teams
}
