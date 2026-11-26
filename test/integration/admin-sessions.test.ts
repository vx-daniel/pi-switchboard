/**
 * The admin UI's sessions after sign-in (#383): signing out revokes the session, a copy of its
 * cookie included, across a restart; each request checks the role against the lists the proxy
 * runs with; and a viewer's refused write is in the audit log.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resetSync } from '@logtape/logtape'
import { createAdminApp } from '@proxy/admin/app'
import { createSealer } from '@proxy/admin/sealed'
import { fileRevocations, type SessionData } from '@proxy/admin/sessions'
import { resolveAdminUi } from '@proxy/config/admin'
import { ADMIN_UI_DEFAULTS } from '@proxy/config/admin-schema'
import { configureLogging } from '@proxy/logging'
import { isRecord } from '@proxy/utils/guards'
import type { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test'

import { adminApp, adminRequest, auditRecords } from '../fixtures/admin-app'
import { testConfig } from '../helpers'

const ORIGIN = 'http://127.0.0.1:4142'
const HOST = '127.0.0.1:4142'
const SESSION_KEY = 'notarealsecret-session-key-0123456789abcdef'
const HOUR_MS = 3_600_000

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'pi-switchboard-sessions-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

/**
 * Starts the admin app as a proxy would, with these lists and the revocations file in a temporary
 * directory: a second call with the same directory is the same proxy after a restart.
 *
 * @param lists - who may sign in
 * @param lists.editors - who may change settings
 * @param lists.viewers - who may only read
 * @param file - the revocations file, under the temporary directory
 * @returns the app
 */
function startedWith(
  lists: { editors?: string[]; viewers?: string[] },
  file = 'revoked.json'
): Hono {
  const settings = resolveAdminUi(
    { ...ADMIN_UI_DEFAULTS, enabled: true, ...lists },
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
    server: { running: testConfig(), overrides: {}, proxyAuth: false },
    revocations: fileRevocations(join(directory, file))
  })
}

/**
 * Seals a session cookie as sign-in would.
 *
 * @param session - what it carries
 * @returns the `Cookie` header
 */
function cookieOf(session: SessionData): string {
  const sealed = createSealer(SESSION_KEY).seal('session', session, Date.now() + HOUR_MS)
  return `pi_switchboard_admin=${sealed}`
}

/**
 * Asks who is signed in.
 *
 * @param app - the admin app
 * @param cookie - the `Cookie` header
 * @returns the status, and the role when there is a session
 */
async function whoIs(app: Hono, cookie: string): Promise<{ status: number; role: unknown }> {
  const answer = await app.request('/admin/api/session', { headers: { host: HOST, cookie } })
  const body: unknown = answer.ok ? await answer.json() : undefined
  return { status: answer.status, role: isRecord(body) ? body['role'] : undefined }
}

const ALICE: SessionData = {
  sid: 'alice-session',
  login: 'alice',
  id: 1,
  role: 'editor',
  team: null,
  iat: Date.now()
}

describe('signing out', () => {
  // Catches sign-out that only clears this browser's cookie: a copy of it, taken before, must stop
  // working at once, and still after the proxy restarts, since sessions outlive a restart.
  test('revokes the session, a copied cookie included, across a restart', async () => {
    const app = startedWith({ editors: ['alice'] })
    const copied = cookieOf(ALICE)
    expect((await whoIs(app, copied)).status).toBe(200)

    const signOut = await app.request('/admin/auth/sign-out', {
      method: 'POST',
      headers: { host: HOST, origin: ORIGIN, cookie: copied }
    })

    expect(signOut.status).toBe(204)
    expect((await whoIs(app, copied)).status).toBe(401)
    expect((await whoIs(startedWith({ editors: ['alice'] }), copied)).status).toBe(401)
    expect((await whoIs(app, cookieOf({ ...ALICE, sid: 'another-session' }))).status).toBe(200)
  })
  // Catches a sign-out reported as done that a restart would undo (#385 review): when the
  // revocation can't be saved, the session is refused here at once, but the answer says it didn't
  // hold rather than 204.
  test('that could not be saved is refused here, and answered as a failure', async () => {
    const app = startedWith({ editors: ['alice'] }, join('no-such-directory', 'revoked.json'))
    const cookie = cookieOf(ALICE)

    const signOut = await app.request('/admin/auth/sign-out', {
      method: 'POST',
      headers: { host: HOST, origin: ORIGIN, cookie }
    })

    expect(signOut.status).toBe(500)
    expect(await signOut.text()).toMatch(/could not be saved/u)
    expect((await whoIs(app, cookie)).status).toBe(401)
  })

  // Catches a malformed store taken for an empty one (#385 review), which would let every session
  // it revoked in again: every session signed in before the proxy started is refused, and still
  // after the next restart, while one signed in since is not.
  test('a revocations file that is unusable refuses every session signed in before', async () => {
    writeFileSync(join(directory, 'revoked.json'), 'not json')
    const cookie = cookieOf(ALICE)

    const app = startedWith({ editors: ['alice'] })
    const later = cookieOf({ ...ALICE, sid: 'later-session', iat: Date.now() + HOUR_MS })

    expect((await whoIs(app, cookie)).status).toBe(401)
    expect((await whoIs(app, later)).status).toBe(200)
    expect((await whoIs(startedWith({ editors: ['alice'] }), cookie)).status).toBe(401)
  })

  // Catches a live requests stream outliving its session (#385 review): once signed out, an open
  // stream ends at the next flush, though nothing changed and only heartbeats would flow.
  test('ends an open requests stream', async () => {
    const app = startedWith({ editors: ['alice'] })
    const cookie = cookieOf(ALICE)
    const stream = await app.request('/admin/api/requests/stream', {
      headers: { host: HOST, cookie }
    })
    const reader = stream.body?.getReader()
    if (reader === undefined) throw new Error('the stream should have a body')
    await reader.read()

    await app.request('/admin/auth/sign-out', {
      method: 'POST',
      headers: { host: HOST, origin: ORIGIN, cookie }
    })
    // The server checks the session on its 500 ms flush: a stream that never ends fails this test
    // at its timeout, so no wait is guessed here. What was sent before it ended is read past.
    let chunk = await reader.read()
    while (!chunk.done) chunk = await reader.read()

    expect(await reader.read()).toEqual({ done: true, value: undefined })
  })
})

describe("a session's role", () => {
  // Catches a role frozen at sign-in (#383): after a restart with other lists, a session follows
  // them: taken off, it is no session; moved to the viewers, it is a viewer's.
  test.each([
    { lists: { editors: ['alice'] }, expected: { status: 200, role: 'editor' } },
    { lists: { viewers: ['alice'] }, expected: { status: 200, role: 'viewer' } },
    { lists: { editors: ['bob'] }, expected: { status: 401, role: undefined } }
  ])('follows the lists the proxy runs with: $lists', async ({ lists, expected }) => {
    expect(await whoIs(startedWith(lists), cookieOf(ALICE))).toEqual(expected)
  })

  // Catches a team's member keeping a role once the team is no longer listed, or losing it while
  // it still is: the team sign-in recorded is checked, not asked of GitHub again.
  test('given by a team, lasts as long as the team is listed', async () => {
    const carol = cookieOf({ ...ALICE, login: 'carol', team: 'my-org/ops' })

    expect(await whoIs(startedWith({ editors: ['My-Org/Ops'] }), carol)).toEqual({
      status: 200,
      role: 'editor'
    })
    expect((await whoIs(startedWith({ editors: ['alice'] }), carol)).status).toBe(401)
  })
})

describe('a refused write', () => {
  let lines: string[]

  beforeEach(() => {
    lines = []
    configureLogging({ level: 'info', format: 'json', write: (line) => lines.push(line) })
  })

  afterEach(() => {
    resetSync()
  })

  // Catches a viewer's attempted change leaving no trace (#383): the refusal is in the audit log
  // with who tried what.
  test("is in the audit log with the viewer's login, the method and the path", async () => {
    const answer = await adminRequest(adminApp(), {
      method: 'PUT',
      path: '/budgets/team%2Fother',
      role: 'viewer',
      body: { today: 1 }
    })

    expect(answer.status).toBe(403)
    expect(auditRecords(lines)).toMatchObject([
      { properties: { login: 'bob', method: 'PUT', path: '/admin/api/budgets/team%2Fother' } }
    ])
  })

  // Catches a refused write reaching only the general log (#385 review): a write without a
  // session, and one the guards refuse for its Host or Origin, are in the audit log too.
  test.each([
    { refused: 'no session', headers: { host: HOST, origin: ORIGIN }, status: 401 },
    {
      refused: 'a foreign Origin',
      headers: { host: HOST, origin: 'https://evil.example' },
      status: 403
    },
    { refused: 'a foreign Host', headers: { host: 'evil.example', origin: ORIGIN }, status: 403 }
  ])('with $refused is in the audit log', async ({ headers, status }) => {
    const answer = await adminApp().request('/admin/api/budgets/x', {
      method: 'PUT',
      headers: { ...headers, 'content-type': 'application/json' },
      body: '{"today":1}'
    })

    expect(answer.status).toBe(status)
    expect(auditRecords(lines)).toMatchObject([
      { properties: { method: 'PUT', path: '/admin/api/budgets/x' } }
    ])
  })
})
