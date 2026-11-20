/**
 * The admin UI's sessions (#367, #383): what a session cookie carries, the sessions signed out
 * before they expired, and opening a cookie into the operator it stands for now.
 *
 * @remarks
 * - **Revoked on sign-out.** Each session has a random ID. Signing out records it as revoked until
 *   the session would have expired, in `pi-switchboard-admin-revoked.json` in pi's agent
 *   directory, so a copied cookie stops working at once and stays refused after a restart:
 *   sessions outlive one, sealed with a key from a file. Expired entries are dropped whenever the
 *   file is read or written.
 * - **The role as the lists say now.** A session carries the role sign-in gave and the team that
 *   gave it. Each request checks it again against the lists the proxy runs with ({@link
 *   currentRole}): a login or team taken off them loses its role, and one moved to the viewers
 *   becomes a viewer. A change in a team's members on GitHub needs a new sign-in.
 * - **No secret.** A session ID names a session, as a log line might; it opens nothing without
 *   the sealed cookie, so the file holds no credential.
 *
 * @packageDocumentation
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { AdminSession } from '@proxy/admin/api'
import { currentRole, type RoleLists } from '@proxy/admin/roles'
import type { Sealer } from '@proxy/admin/sealed'
import { piAgentDir } from '@proxy/config/agent-dir'
import { proxyLogger } from '@proxy/logging'
import { errorMessage } from '@proxy/utils/guards'
import * as z from 'zod'

/** Logger for sign-in and sign-out. */
const authLogger = proxyLogger('admin', 'auth')

/** The file the revoked sessions are kept in, in pi's agent directory. */
const REVOKED_FILE = 'pi-switchboard-admin-revoked.json'
/** Only the owner reads and writes the file. */
const OWNER_ONLY = 0o600

/** What a session cookie carries. */
export const SessionDataSchema = z.object({
  /** The session's ID, random, for revoking it. */
  sid: z.string().trim().min(1),
  login: z.string().trim().min(1),
  id: z.int().positive(),
  role: z.enum(['editor', 'viewer']),
  /** The listed team that admitted the operator at sign-in; `null` when their login did. */
  team: z.string().trim().min(1).nullable(),
  /** When the operator signed in, in milliseconds since the epoch. */
  iat: z.int().nonnegative()
})

/** What a session cookie carries. */
export type SessionData = z.infer<typeof SessionDataSchema>

/**
 * The revoked sessions file: session ID -> until when it stays revoked, in milliseconds, and the
 * time before which every session is refused, set when the file was found unusable.
 */
const RevokedFileSchema = z.object({
  revoked: z.record(z.string(), z.int().nonnegative()),
  signedOutBefore: z.int().nonnegative().optional()
})

/** The sessions signed out before they expired. */
export interface Revocations {
  /**
   * Records a session as signed out until it would have expired, and forgets those past theirs.
   *
   * @param sid - the session's ID
   * @param until - when it would have expired, in milliseconds since the epoch
   * @param now - the time, in milliseconds since the epoch
   * @returns whether the sign-out was saved; when not, it lasts only until a restart
   */
  revoke(sid: string, until: number, now: number): boolean
  /**
   * Says whether a session was signed out, or signed in before the store was found unusable.
   *
   * @param session - the session's ID and when it was signed in
   * @param now - the time, in milliseconds since the epoch
   * @returns whether it is revoked
   */
  isRevoked(session: Pick<SessionData, 'sid' | 'iat'>, now: number): boolean
}

/** What reading the file found. */
type StoreRead =
  | { readonly kind: 'read'; readonly revoked: Map<string, number>; readonly before: number }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unusable'; readonly reason: string }

/**
 * Reads the revoked sessions still within their lifetime.
 *
 * @param path - the file
 * @param now - the time
 * @returns what it holds, that there is none, or why it can't be used
 */
function readStore(path: string, now: number): StoreRead {
  if (!existsSync(path)) return { kind: 'missing' }
  try {
    const parsed = RevokedFileSchema.safeParse(JSON.parse(readFileSync(path, 'utf-8')))
    if (!parsed.success) return { kind: 'unusable', reason: 'not a list of revoked sessions' }
    const live = Object.entries(parsed.data.revoked).filter(([, until]) => until > now)
    return { kind: 'read', revoked: new Map(live), before: parsed.data.signedOutBefore ?? 0 }
  } catch (error) {
    return { kind: 'unusable', reason: errorMessage(error) }
  }
}

/**
 * Keeps the revoked sessions in a file, read once and written on each sign-out.
 *
 * @remarks
 * A file that can't be read or isn't one (#385 review) is not taken for an empty list, which
 * would let every session it revoked in again: every session signed in before the proxy started is
 * refused instead, and the file is written afresh with that time, so it holds after the next
 * restart too. Operators sign in again.
 *
 * @param path - the file; pi's agent directory's by default
 * @param now - the time the file is read at
 * @returns the revocations
 */
export function fileRevocations(
  path: string = join(piAgentDir(), REVOKED_FILE),
  now: number = Date.now()
): Revocations {
  const read = readStore(path, now)
  const revoked = read.kind === 'read' ? read.revoked : new Map<string, number>()
  const before = read.kind === 'read' ? read.before : 0
  const store = { revoked, before: read.kind === 'unusable' ? now : before }
  if (read.kind === 'unusable') {
    authLogger.error('{path} is unusable ({reason}): refusing every session signed in before now', {
      path,
      reason: read.reason
    })
    saveStore(path, store, now)
  }
  return {
    revoke(sid, until, at) {
      revoked.set(sid, until)
      return saveStore(path, store, at)
    },
    isRevoked: (session, at) => session.iat < store.before || (revoked.get(session.sid) ?? 0) > at
  }
}

/**
 * Writes the revoked sessions still within their lifetime, atomically and for the owner only.
 *
 * @param path - the file
 * @param store - the revoked sessions, and the time before which every session is refused
 * @param store.revoked - session ID -> until when; those past it are forgotten
 * @param store.before - every session signed in before it is refused; 0 for none
 * @param now - the time
 * @returns whether it was written
 */
function saveStore(
  path: string,
  store: { readonly revoked: Map<string, number>; readonly before: number },
  now: number
): boolean {
  for (const [kept, until] of store.revoked) if (until <= now) store.revoked.delete(kept)
  const tempPath = `${path}.tmp`
  const contents = {
    revoked: Object.fromEntries(store.revoked),
    ...(store.before > 0 ? { signedOutBefore: store.before } : {})
  }
  try {
    writeFileSync(tempPath, JSON.stringify(contents), { encoding: 'utf-8', mode: OWNER_ONLY })
    renameSync(tempPath, path)
    return true
  } catch (error) {
    authLogger.error('Could not save the signed-out sessions to {path}: {error}', {
      path,
      error: errorMessage(error)
    })
    return false
  }
}

/** What opening a session cookie reads with. */
export interface SessionRules {
  readonly sealer: Sealer
  readonly revocations: Revocations
  /** The editors and viewers the proxy runs with. */
  readonly lists: RoleLists
}

/**
 * Opens a session cookie into the operator it stands for now: unsealed, not signed out, and
 * still admitted by the lists, with the role they give today.
 *
 * @param rules - the sealer, the revocations and the lists
 * @param cookie - the cookie's value, or `undefined` when there was none
 * @param now - the time, in milliseconds since the epoch
 * @returns the operator, or `undefined` when there is no valid session
 */
export function openSession(
  rules: SessionRules,
  cookie: string | undefined,
  now: number
): AdminSession | undefined {
  const data = rules.sealer.unseal('session', cookie, SessionDataSchema, now)
  if (data === undefined || rules.revocations.isRevoked(data, now)) return undefined
  const role = currentRole(rules.lists, data.login, data.team)
  return role === undefined ? undefined : { login: data.login, id: data.id, role }
}
