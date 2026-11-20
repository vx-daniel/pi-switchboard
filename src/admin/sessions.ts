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
  team: z.string().trim().min(1).nullable()
})

/** What a session cookie carries. */
export type SessionData = z.infer<typeof SessionDataSchema>

/** The revoked sessions file: session ID -> until when it stays revoked, in milliseconds. */
const RevokedFileSchema = z.object({ revoked: z.record(z.string(), z.int().nonnegative()) })

/** The sessions signed out before they expired. */
export interface Revocations {
  /**
   * Records a session as signed out until it would have expired, and forgets those past theirs.
   *
   * @param sid - the session's ID
   * @param until - when it would have expired, in milliseconds since the epoch
   * @param now - the time, in milliseconds since the epoch
   */
  revoke(sid: string, until: number, now: number): void
  /**
   * Says whether a session was signed out.
   *
   * @param sid - the session's ID
   * @param now - the time, in milliseconds since the epoch
   * @returns whether it is revoked
   */
  isRevoked(sid: string, now: number): boolean
}

/**
 * Reads the revoked sessions still within their lifetime.
 *
 * @param path - the file
 * @param now - the time
 * @returns session ID -> until when; empty when the file is absent or unreadable
 */
function readRevoked(path: string, now: number): Map<string, number> {
  if (!existsSync(path)) return new Map()
  try {
    const parsed = RevokedFileSchema.safeParse(JSON.parse(readFileSync(path, 'utf-8')))
    if (!parsed.success) {
      authLogger.warn('Ignored {path}: not a list of revoked sessions', { path })
      return new Map()
    }
    return new Map(Object.entries(parsed.data.revoked).filter(([, until]) => until > now))
  } catch (error) {
    authLogger.warn('Could not read {path}: {error}', { path, error: errorMessage(error) })
    return new Map()
  }
}

/**
 * Keeps the revoked sessions in a file, read once and written on each sign-out.
 *
 * @param path - the file; pi's agent directory's by default
 * @param now - the time the file is read at
 * @returns the revocations
 */
export function fileRevocations(
  path: string = join(piAgentDir(), REVOKED_FILE),
  now: number = Date.now()
): Revocations {
  const revoked = readRevoked(path, now)
  return {
    revoke(sid, until, at) {
      for (const [kept, keptUntil] of revoked) if (keptUntil <= at) revoked.delete(kept)
      revoked.set(sid, until)
      const tempPath = `${path}.tmp`
      try {
        writeFileSync(tempPath, JSON.stringify({ revoked: Object.fromEntries(revoked) }), {
          encoding: 'utf-8',
          mode: OWNER_ONLY
        })
        renameSync(tempPath, path)
      } catch (error) {
        // Still revoked in memory: only a restart would forget it.
        authLogger.error('Could not save a sign-out to {path}: {error}', {
          path,
          error: errorMessage(error)
        })
      }
    },
    isRevoked: (sid, at) => (revoked.get(sid) ?? 0) > at
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
  if (data === undefined || rules.revocations.isRevoked(data.sid, now)) return undefined
  const role = currentRole(rules.lists, data.login, data.team)
  return role === undefined ? undefined : { login: data.login, id: data.id, role }
}
