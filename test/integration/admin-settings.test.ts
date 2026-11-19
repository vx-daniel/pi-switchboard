/**
 * The admin UI's settings (#367, phase 2) against a real `proxy-config.json`: an editor's change is
 * saved and logged with who made it; a viewer's, the proxy token, a bad value and a write over an
 * unreadable file are refused.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { resetSync } from '@logtape/logtape'
import { createAdminApp } from '@proxy/admin/app'
import { createSealer } from '@proxy/admin/sealed'
import { resolveAdminUi } from '@proxy/config/admin'
import { ADMIN_UI_DEFAULTS } from '@proxy/config/admin-schema'
import { configureLogging } from '@proxy/logging'
import type { Hono } from 'hono'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi
} from 'vite-plus/test'

import {
  type FixtureAgentDir,
  loadFixtureAgentDir,
  offlineProvider,
  writeProxyConfig
} from '../fixtures/agent-dir'
import { testConfig } from '../helpers'

const HOST = '127.0.0.1:4142'
const ORIGIN = 'http://127.0.0.1:4142'
const SESSION_KEY = 'notarealsecret-session-key-0123456789abcdef'
const TOKEN = 'notarealsecret-proxy-token'
const MINUTE_MS = 60_000
const ENV = {
  PI_SWITCHBOARD_GITHUB_CLIENT_ID: 'Iv1.notarealclient',
  PI_SWITCHBOARD_GITHUB_CLIENT_SECRET: 'notarealsecret-client-secret',
  PI_SWITCHBOARD_ADMIN_SESSION_KEY: SESSION_KEY
}

let agentDir: FixtureAgentDir
let lines: string[]

beforeAll(async () => {
  agentDir = await loadFixtureAgentDir({
    modelsJson: { providers: { local: offlineProvider('alpha') } }
  })
})

afterAll(() => {
  agentDir.remove()
  vi.unstubAllEnvs()
})

beforeEach(() => {
  writeProxyConfig(agentDir.path, { authToken: TOKEN, port: 4141 })
  lines = []
  configureLogging({ level: 'info', format: 'json', write: (line) => lines.push(line) })
})

afterEach(() => {
  resetSync()
})

/**
 * Creates the admin app over a running proxy without proxy auth and with `--port` given.
 *
 * @returns the app
 */
function adminApp(): Hono {
  const settings = resolveAdminUi({ ...ADMIN_UI_DEFAULTS, enabled: true, editors: ['alice'] }, ENV)
  const { signIn } = settings
  if (signIn === undefined) throw new Error('sign-in should be configured')
  return createAdminApp({
    settings: { ...settings, signIn },
    server: { running: testConfig(), overrides: { port: '--port' }, proxyAuth: false }
  })
}

/**
 * Makes a session cookie, as sign-in would set it.
 *
 * @param role - the operator's role
 * @returns the `Cookie` header
 */
function cookie(role: 'editor' | 'viewer'): string {
  const sealed = createSealer(SESSION_KEY).seal(
    'session',
    { login: role === 'editor' ? 'alice' : 'bob', id: 1, role },
    Date.now() + MINUTE_MS
  )
  return `pi_switchboard_admin=${sealed}`
}

/**
 * Changes a setting from the admin UI.
 *
 * @param role - who changes it
 * @param key - the setting
 * @param body - what is sent
 * @returns the response
 */
function put(role: 'editor' | 'viewer', key: string, body: unknown): Promise<Response> {
  return Promise.resolve(
    adminApp().request(`/admin/api/settings/${key}`, {
      method: 'PUT',
      headers: {
        'host': HOST,
        'origin': ORIGIN,
        'cookie': cookie(role),
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    })
  )
}

/**
 * Reads the config file as saved.
 *
 * @returns its contents
 */
function savedFile(): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(join(agentDir.path, 'proxy-config.json'), 'utf8'))
  return typeof parsed === 'object' && parsed !== null ? { ...parsed } : {}
}

describe('admin settings', () => {
  // Catches the page told nothing of the token, or given it: proxy auth shows on or off only, a
  // setting a flag holds says so, and a restart-only setting says when it applies.
  test('lists each setting with its value, its input and what holds it', async () => {
    const response = await adminApp().request('/admin/api/settings', {
      headers: { host: HOST, cookie: cookie('viewer') }
    })
    const text = await response.text()

    expect(text).not.toContain(TOKEN)
    expect(JSON.parse(text)).toMatchObject({
      fileProblem: null,
      settings: expect.arrayContaining([
        expect.objectContaining({
          key: 'authToken',
          saved: 'on',
          value: null,
          input: { kind: 'console' }
        }),
        expect.objectContaining({
          key: 'port',
          override: '--port',
          applies: 'restart',
          input: { kind: 'int', min: 1, max: 65_535 }
        }),
        expect.objectContaining({
          key: 'customModels',
          input: { kind: 'many', options: ['local/alpha'] }
        })
      ])
    })
  })

  // Catches an editor's change not saved where the proxy reads it, or saved with no record of who
  // made it.
  test("saves an editor's change and logs who made it", async () => {
    const response = await put('editor', 'upstreamTimeoutSec', { value: 300 })

    expect(response.status).toBe(200)
    expect(savedFile()).toMatchObject({ upstreamTimeoutSec: 300, authToken: TOKEN })
    const audit = lines
      .map((line): unknown => JSON.parse(line))
      .find((record) => JSON.stringify(record).includes('pi-switchboard.admin.audit'))
    expect(audit).toMatchObject({
      properties: { login: 'alice', setting: 'upstreamTimeoutSec', before: '120 s', after: '300 s' }
    })
  })

  // Catches a viewer, the proxy token, a value the file would refuse, or listening beyond loopback
  // without confirming getting through: none changes the file.
  test.each([
    {
      refused: "a viewer's change",
      role: 'viewer',
      key: 'stats',
      body: { value: false },
      status: 403,
      code: 'editor_only'
    },
    {
      refused: 'the proxy token',
      role: 'editor',
      key: 'authToken',
      body: { value: 'x' },
      status: 400,
      code: 'console_only'
    },
    {
      refused: 'a port out of range',
      role: 'editor',
      key: 'port',
      body: { value: 70_000 },
      status: 400,
      code: 'invalid_value'
    },
    {
      refused: 'an unknown setting',
      role: 'editor',
      key: 'colour',
      body: { value: 1 },
      status: 404,
      code: 'unknown_setting'
    },
    {
      refused: 'listening everywhere unconfirmed',
      role: 'editor',
      key: 'host',
      body: { value: '0.0.0.0' },
      status: 400,
      code: 'confirm_required'
    }
  ] as const)('refuses $refused', async ({ role, key, body, status, code }) => {
    const before = savedFile()

    const response = await put(role, key, body)

    expect(response.status).toBe(status)
    expect(await response.json()).toMatchObject({ error: { code } })
    expect(savedFile()).toEqual(before)
  })

  // Catches the admin UI writing over a file it can't parse, which would lose what the operator had.
  test('never writes over an unusable file', async () => {
    writeFileSync(join(agentDir.path, 'proxy-config.json'), '{ not json')

    const response = await put('editor', 'stats', { value: false })

    expect(response.status).toBe(409)
    expect(readFileSync(join(agentDir.path, 'proxy-config.json'), 'utf8')).toBe('{ not json')
  })

  // Catches a cross-site page changing settings through an editor's browser: a write without the
  // admin UI's Origin is refused before it reaches the setting.
  test('refuses a write without the admin UI’s Origin', async () => {
    const response = await adminApp().request('/admin/api/settings/stats', {
      method: 'PUT',
      headers: { 'host': HOST, 'cookie': cookie('editor'), 'content-type': 'application/json' },
      body: JSON.stringify({ value: false })
    })

    expect(response.status).toBe(403)
    expect(savedFile()).not.toHaveProperty('stats')
  })
})
