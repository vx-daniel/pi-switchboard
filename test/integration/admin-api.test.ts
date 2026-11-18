/**
 * The admin UI's read API (#367, phase 1), against a fixture agent dir: every route needs a
 * session, the pages read the running proxy's own state, and no answer carries a credential.
 */

import { type AdminAppOptions, createAdminApp } from '@proxy/admin/app'
import { createSealer } from '@proxy/admin/sealed'
import { resolveAdminUi } from '@proxy/config/admin'
import { ADMIN_UI_DEFAULTS } from '@proxy/config/admin-schema'
import { createApp } from '@proxy/server/app'
import type { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vite-plus/test'

import {
  type FixtureAgentDir,
  loadFixtureAgentDir,
  offlineProvider,
  writeProxyConfig
} from '../fixtures/agent-dir'
import { testConfig } from '../helpers'

const HOST = '127.0.0.1:4142'
const SESSION_KEY = 'notarealsecret-session-key-0123456789abcdef'
/** The key `offlineProvider` puts in models.json. */
const MODELS_JSON_KEY = 'notarealsecret-fixture-provider-key'
/** A key stored in pi's auth.json, as a login would. */
const STORED_KEY = 'notarealsecret-stored-groq-key'
const ENV = {
  PI_SWITCHBOARD_GITHUB_CLIENT_ID: 'Iv1.notarealclient',
  PI_SWITCHBOARD_GITHUB_CLIENT_SECRET: 'notarealsecret-client-secret',
  PI_SWITCHBOARD_ADMIN_SESSION_KEY: SESSION_KEY
}
const MINUTE_MS = 60_000

let agentDir: FixtureAgentDir

beforeAll(async () => {
  agentDir = await loadFixtureAgentDir({
    modelsJson: { providers: { local: offlineProvider('alpha', 'beta') } },
    authJson: { groq: { type: 'api_key', key: STORED_KEY } }
  })
  writeProxyConfig(agentDir.path, {
    modelExposureMode: 'all',
    aliases: { quick: 'local/alpha' },
    labels: { local: 'work' }
  })
})

afterAll(() => {
  agentDir.remove()
  vi.unstubAllEnvs()
})

/**
 * Creates the admin app as the listener would, on loopback, with stats off.
 *
 * @param overrides - options to change
 * @returns the app
 */
function adminApp(overrides: Partial<AdminAppOptions> = {}): Hono {
  const settings = resolveAdminUi({ ...ADMIN_UI_DEFAULTS, enabled: true, viewers: ['alice'] }, ENV)
  const { signIn } = settings
  if (signIn === undefined) throw new Error('sign-in should be configured')
  return createAdminApp({
    settings: { ...settings, signIn },
    fetch: () => Promise.reject(new Error('GitHub is not asked by the API')),
    server: { host: '127.0.0.1', docsUiEnabled: false, statsEnabled: false, proxyAuth: false },
    ...overrides
  })
}

/**
 * Makes a viewer's session cookie, as sign-in would set it.
 *
 * @returns the `Cookie` header
 */
function viewerCookie(): string {
  const sealed = createSealer(SESSION_KEY).seal(
    'session',
    { login: 'alice', id: 1, role: 'viewer' },
    Date.now() + MINUTE_MS
  )
  return `pi_switchboard_admin=${sealed}`
}

/**
 * Reads an API path as a signed-in viewer.
 *
 * @param app - the admin app
 * @param path - the path under `/admin/api`
 * @returns the response
 */
function read(app: Hono, path: string): Promise<Response> {
  return Promise.resolve(
    app.request(`/admin/api${path}`, { headers: { host: HOST, cookie: viewerCookie() } })
  )
}

describe('admin API', () => {
  // Catches a page's data served to someone signed out, or an unknown path telling them it is not
  // there (and so what is).
  test.each([
    '/session',
    '/requests',
    '/requests/stream',
    '/accounts',
    '/models',
    '/stats',
    '/doctor',
    '/nope'
  ])('%s answers 401 without a session', async (path) => {
    const response = await adminApp().request(`/admin/api${path}`, { headers: { host: HOST } })

    expect(response.status).toBe(401)
  })

  // Catches a credential reaching the admin UI (constitution III): neither models.json's key nor
  // auth.json's appears in any page's answer.
  test.each(['/accounts', '/models', '/doctor', '/requests'])(
    '%s carries no credential',
    async (path) => {
      const text = await (await read(adminApp(), path)).text()

      expect(text).not.toContain(MODELS_JSON_KEY)
      expect(text).not.toContain(STORED_KEY)
    }
  )

  // Catches the Accounts page missing a login, its label, or its routing place.
  test('lists each login with its label and place', async () => {
    const accounts: unknown = await (await read(adminApp(), '/accounts')).json()

    expect(accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'local',
          base: 'local',
          label: 'work',
          availableModelCount: 2,
          quota: null,
          cooldowns: [],
          place: expect.objectContaining({ position: 1, first: true, disabled: false })
        }),
        expect.objectContaining({ provider: 'groq', type: 'api_key', label: null })
      ])
    )
  })

  // Catches the Models page showing other models than a request would reach, or losing an alias.
  test('lists the exposed models and the aliases', async () => {
    const models: unknown = await (await read(adminApp(), '/models')).json()

    expect(models).toMatchObject({
      models: expect.arrayContaining([
        expect.objectContaining({ id: 'alpha', provider: 'local' }),
        expect.objectContaining({ id: 'beta', provider: 'local' })
      ]),
      configured: { quick: 'local/alpha' },
      aliases: [expect.objectContaining({ id: 'quick' })]
    })
  })

  // Catches the Requests page reading another store than the one the API listener fills: a
  // request to the API shows up on it.
  test('shows a request the API listener answered', async () => {
    await createApp(testConfig()).request('/v1/models')

    const snapshot: unknown = await (await read(adminApp(), '/requests')).json()

    expect(snapshot).toMatchObject({
      requests: expect.arrayContaining([
        expect.objectContaining({ method: 'GET', path: '/v1/models', status: 200 })
      ])
    })
  })

  // Catches the live stream not sending the snapshot first, so the page would stay empty until
  // the next request.
  test('the requests stream sends a snapshot at once', async () => {
    const response = await read(adminApp(), '/requests/stream')
    const reader = response.body?.getReader()
    const first = await reader?.read()
    await reader?.cancel()

    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(new TextDecoder().decode(first?.value)).toContain('event: requests')
  })

  // Catches a window that is no window read as one, and stats off answered as empty usage.
  test.each([
    { path: '/stats?window=year', status: 400 },
    { path: '/doctor?window=year', status: 400 },
    { path: '/stats', status: 503 }
  ])('$path answers $status', async ({ path, status }) => {
    expect((await read(adminApp(), path)).status).toBe(status)
  })

  // Catches the Doctor page judging another window than it was asked for.
  test('judges the doctor over the window asked for', async () => {
    const report: unknown = await (await read(adminApp(), '/doctor?window=week')).json()

    expect(report).toMatchObject({ window: 'week', statsAvailable: false })
  })
})
