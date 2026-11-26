/**
 * The admin UI's app for tests of its writes (#367): an app over a running proxy, a session as
 * sign-in would seal it, a write as the admin page sends it, and the audit lines it logs.
 *
 * @packageDocumentation
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { createAdminApp } from '@proxy/admin/app'
import type { AdminServerFacts } from '@proxy/admin/reads'
import { createSealer } from '@proxy/admin/sealed'
import { resolveAdminUi } from '@proxy/config/admin'
import { ADMIN_UI_DEFAULTS } from '@proxy/config/admin-schema'
import type { Hono } from 'hono'

import { testConfig } from '../helpers'

/** The admin listener's `Host`. */
export const ADMIN_HOST = '127.0.0.1:4142'
/** The admin page's `Origin`, which every write carries. */
const ADMIN_ORIGIN = 'http://127.0.0.1:4142'
/** The session key, also given to the app. */
const SESSION_KEY = 'notarealsecret-session-key-0123456789abcdef'
/** How long a test's session lasts. */
const MINUTE_MS = 60_000
/** The editor the app lists. */
export const EDITOR = 'alice'
/** The one viewer `adminUi.viewers` lists: each request checks the role against the lists (#383). */
const VIEWER = 'bob'

/** A session's role. */
export type TestRole = 'editor' | 'viewer'

/**
 * Creates the admin app over a running proxy, with `alice` its one editor and `bob` its viewer.
 *
 * @param server - what the running proxy differs in: by default no proxy auth and no overrides
 * @returns the app
 */
export function adminApp(server: Partial<AdminServerFacts> = {}): Hono {
  const settings = resolveAdminUi(
    { ...ADMIN_UI_DEFAULTS, enabled: true, editors: [EDITOR], viewers: [VIEWER] },
    {
      PI_SWITCHBOARD_GITHUB_CLIENT_ID: 'Iv1.notarealclient',
      PI_SWITCHBOARD_GITHUB_CLIENT_SECRET: 'notarealsecret-client-secret',
      PI_SWITCHBOARD_ADMIN_SESSION_KEY: SESSION_KEY
    }
  )
  const { signIn } = settings
  if (signIn === undefined) throw new Error('sign-in should be configured')
  return createAdminApp({
    settings: { ...settings, signIn },
    server: { running: testConfig(), overrides: {}, proxyAuth: false, ...server }
  })
}

/**
 * Makes a session cookie, as sign-in would set it.
 *
 * @param role - the operator's role
 * @returns the `Cookie` header
 */
export function sessionCookie(role: TestRole): string {
  const sealed = createSealer(SESSION_KEY).seal(
    'session',
    {
      sid: `test-${role}`,
      login: role === 'editor' ? EDITOR : VIEWER,
      id: 1,
      role,
      team: null,
      iat: Date.now()
    },
    Date.now() + MINUTE_MS
  )
  return `pi_switchboard_admin=${sealed}`
}

/** One request to the admin API. */
export interface AdminCall {
  readonly method: 'GET' | 'PUT' | 'POST' | 'DELETE'
  /** The path under `/admin/api`, with its query. */
  readonly path: string
  readonly role: TestRole
  /** The JSON body, for a write that sends one. */
  readonly body?: unknown
}

/**
 * Sends a request as the admin page would: the session, and on a write the page's `Origin`.
 *
 * @param app - the admin app
 * @param call - the method, path, role and body
 * @returns the response
 */
export async function adminRequest(app: Hono, call: AdminCall): Promise<Response> {
  const write = call.method !== 'GET'
  return app.request(`/admin/api${call.path}`, {
    method: call.method,
    headers: {
      host: ADMIN_HOST,
      cookie: sessionCookie(call.role),
      ...(write ? { origin: ADMIN_ORIGIN } : {}),
      ...(call.body === undefined ? {} : { 'content-type': 'application/json' })
    },
    ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) })
  })
}

/**
 * Reads `proxy-config.json` as saved.
 *
 * @param agentDir - pi's agent directory
 * @returns its contents
 */
export function savedConfig(agentDir: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(join(agentDir, 'proxy-config.json'), 'utf8'))
  return typeof parsed === 'object' && parsed !== null ? { ...parsed } : {}
}

/**
 * Picks the audit lines from captured JSON log lines.
 *
 * @param lines - the lines, as `configureLogging` wrote them
 * @returns each audit record, parsed, oldest first
 */
export function auditRecords(lines: readonly string[]): unknown[] {
  return lines
    .map((line): unknown => JSON.parse(line))
    .filter((record) => JSON.stringify(record).includes('pi-switchboard.admin.audit'))
}
