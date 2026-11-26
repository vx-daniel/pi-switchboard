/**
 * Whether each login's credential works (#388): the last time it was shown good and the last time
 * it failed, kept in memory for the life of the process and shown on `/v1/switchboard/models`.
 *
 * @remarks
 * - **Keyed by login** (`anthropic`, `anthropic-2`): a credential is one login's.
 * - **Good:** a whole answer under the login, or a passing `/healthz/creds?verify=true` of an
 *   OAuth login (its token resolved, refreshed when due). An API key that resolves proves only
 *   that it is set, so its verification says nothing here.
 * - **Failed:** pi could not resolve the credential (a refresh rejected, a key command that prints
 *   nothing), whether for a request or a verification, or the provider refused it (401 or 403).
 *   The reason is the summary a response may carry (`summarizeAuthError`): never the credential,
 *   never the token endpoint's body.
 * - **Latest wins.** A login is `failing` while its last failure is newer than its last good
 *   result, `working` while the good one is newer, `unknown` before either. Nothing is learned
 *   without a call: a login no request reaches stays as it last was, which is why a verification
 *   counts.
 * - **Only the shared login writes it.** A request with the client's own upstream key says
 *   nothing about the proxy's login.
 * - **Forgotten** when the console logs the login in or out, since the credential is new or gone.
 *
 * @packageDocumentation
 */

import { proxyLogger } from '@proxy/logging'

/** Logger for the credential going bad or good again: the chat category, as for cooldowns. */
const healthLogger = proxyLogger('server', 'chat')

/** What is known of a login's credential. */
export interface LoginHealth {
  /** `failing` while the last failure is the latest result, `working` while a success is. */
  readonly status: 'working' | 'failing' | 'unknown'
  /** When it was last shown good, in milliseconds since the epoch. */
  readonly lastOk: number | undefined
  /** Its last failure: when, and why. */
  readonly lastFailure: { readonly at: number; readonly reason: string } | undefined
}

/** Each login's results, by login ID. */
const health = new Map<string, Omit<LoginHealth, 'status'>>()

/**
 * Records that a login's credential worked.
 *
 * @param login - the login
 * @param now - when; now by default
 */
export function noteCredentialOk(login: string, now: number = Date.now()): void {
  const before = loginHealth(login)
  health.set(login, { lastOk: now, lastFailure: before.lastFailure })
  if (before.status === 'failing') {
    healthLogger.info('The credential of {login} works again', { login })
  }
}

/**
 * Records that a login's credential failed.
 *
 * @param login - the login
 * @param reason - why, as a response may carry it
 * @param now - when; now by default
 */
export function noteCredentialFailure(
  login: string,
  reason: string,
  now: number = Date.now()
): void {
  const before = loginHealth(login)
  health.set(login, { lastOk: before.lastOk, lastFailure: { at: now, reason } })
  if (before.status !== 'failing') {
    healthLogger.warn('The credential of {login} fails: {reason}', { login, reason })
  }
}

/**
 * Reports what is known of a login's credential.
 *
 * @param login - the login
 * @returns its status, its last good result and its last failure
 */
export function loginHealth(login: string): LoginHealth {
  const known = health.get(login)
  const lastOk = known?.lastOk
  const lastFailure = known?.lastFailure
  if (lastFailure !== undefined && (lastOk === undefined || lastFailure.at >= lastOk)) {
    return { status: 'failing', lastOk, lastFailure }
  }
  return { status: lastOk === undefined ? 'unknown' : 'working', lastOk, lastFailure }
}

/**
 * Forgets a login's results: it was logged in again, or out.
 *
 * @param login - the login
 */
export function forgetLoginHealth(login: string): void {
  health.delete(login)
}

/** Forgets every login's results, for tests. */
export function clearLoginHealth(): void {
  health.clear()
}
