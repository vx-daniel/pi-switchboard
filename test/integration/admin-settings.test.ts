/**
 * The admin UI's settings (#367, phase 2) against a real `proxy-config.json`: an editor's change is
 * saved and logged with who made it; a viewer's, the proxy token, a bad value and a write over an
 * unreadable file are refused.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { resetSync } from '@logtape/logtape'
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
  ADMIN_HOST,
  adminApp,
  adminRequest,
  auditRecords,
  savedConfig,
  sessionCookie,
  type TestRole
} from '../fixtures/admin-app'
import {
  type FixtureAgentDir,
  loadFixtureAgentDir,
  offlineProvider,
  writeProxyConfig
} from '../fixtures/agent-dir'

const TOKEN = 'notarealsecret-proxy-token'

let agentDir: FixtureAgentDir
let lines: string[]
let app: Hono

beforeAll(async () => {
  agentDir = await loadFixtureAgentDir({
    modelsJson: { providers: { local: offlineProvider('alpha') } }
  })
  // A running proxy without proxy auth, with `--port` given.
  app = adminApp({ overrides: { port: '--port' } })
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
 * Changes a setting from the admin UI.
 *
 * @param role - who changes it
 * @param key - the setting
 * @param body - what is sent
 * @returns the response
 */
function put(role: TestRole, key: string, body: unknown): Promise<Response> {
  return adminRequest(app, { method: 'PUT', path: `/settings/${key}`, role, body })
}

describe('admin settings', () => {
  // Catches the page told nothing of the token, or given it: proxy auth shows on or off only, a
  // setting a flag holds says so, and a restart-only setting says when it applies.
  test('lists each setting with its value, its input and what holds it', async () => {
    const response = await adminRequest(app, { method: 'GET', path: '/settings', role: 'viewer' })
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
    expect(savedConfig(agentDir.path)).toMatchObject({ upstreamTimeoutSec: 300, authToken: TOKEN })
    expect(auditRecords(lines)).toMatchObject([
      {
        properties: {
          login: 'alice',
          setting: 'upstreamTimeoutSec',
          before: '120 s',
          after: '300 s'
        }
      }
    ])
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
    const before = savedConfig(agentDir.path)

    const response = await put(role, key, body)

    expect(response.status).toBe(status)
    expect(await response.json()).toMatchObject({ error: { code } })
    expect(savedConfig(agentDir.path)).toEqual(before)
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
    const response = await app.request('/admin/api/settings/stats', {
      method: 'PUT',
      headers: {
        'host': ADMIN_HOST,
        'cookie': sessionCookie('editor'),
        'content-type': 'application/json'
      },
      body: JSON.stringify({ value: false })
    })

    expect(response.status).toBe(403)
    expect(savedConfig(agentDir.path)).not.toHaveProperty('stats')
  })
})
