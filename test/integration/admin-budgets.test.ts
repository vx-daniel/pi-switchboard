/**
 * The admin UI's budget writes (#366, #367) against a real `proxy-config.json`: an editor sets,
 * replaces and removes a project's budget, each change logged with who made it; a label the
 * header would refuse, an amount that isn't one, and a viewer's write are refused without
 * changing the file.
 */

import { resetSync } from '@logtape/logtape'
import { configureLogging } from '@proxy/logging'
import type { Hono } from 'hono'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vite-plus/test'

import {
  adminApp,
  type AdminCall,
  adminRequest,
  auditRecords,
  savedConfig
} from '../fixtures/admin-app'
import {
  type FixtureAgentDir,
  loadFixtureAgentDir,
  offlineProvider,
  writeProxyConfig
} from '../fixtures/agent-dir'

/** A project as clients name it: `owner/repository`, which holds a `/`. */
const PROJECT = 'vx-daniel/pi-switchboard'

/** The path of {@link PROJECT}'s budget, URL-encoded as the admin page sends it. */
const PROJECT_PATH = `/budgets/${encodeURIComponent(PROJECT)}`

/** The budgets saved before each test: another project's, which no write here may touch. */
const OTHER_BUDGETS = { 'other-project': { today: 5 } }

let agentDir: FixtureAgentDir
let lines: string[]
let app: Hono

beforeAll(async () => {
  agentDir = await loadFixtureAgentDir({
    modelsJson: { providers: { alpha: offlineProvider('quick-mock') } }
  })
  app = adminApp()
})

afterAll(() => {
  agentDir.remove()
})

beforeEach(() => {
  writeProxyConfig(agentDir.path, { port: 4141, budgets: OTHER_BUDGETS })
  lines = []
  configureLogging({ level: 'info', format: 'json', write: (line) => lines.push(line) })
})

afterEach(() => {
  resetSync()
})

/**
 * Sends an editor's request, unless another role is named.
 *
 * @param call - the method, path and body, and the role when not an editor
 * @returns the response
 */
function send(
  call: Omit<AdminCall, 'role'> & { readonly role?: AdminCall['role'] }
): Promise<Response> {
  return adminRequest(app, { role: 'editor', ...call })
}

describe('admin budgets', () => {
  // Catches a label holding `/` split by the router into another path, a budget saved over the
  // other projects', or saved with no record of who set it.
  test("sets an editor's budget for a project named with a slash, and logs it", async () => {
    const response = await send({ method: 'PUT', path: PROJECT_PATH, body: { week: 50, all: 150 } })

    expect(response.status).toBe(200)
    const budgets = { ...OTHER_BUDGETS, [PROJECT]: { week: 50, all: 150 } }
    expect(await response.json()).toEqual({ budgets })
    expect(savedConfig(agentDir.path)).toMatchObject({ budgets })
    expect(auditRecords(lines)).toMatchObject([
      {
        properties: {
          login: 'alice',
          project: PROJECT,
          before: 'none',
          after: 'week $50.00, all $150.00'
        }
      }
    ])
  })

  // Catches a new budget merged into the old one, which would keep a window the editor cleared.
  test('replaces a budget whole, and removes it', async () => {
    await send({ method: 'PUT', path: PROJECT_PATH, body: { week: 50, all: 150 } })
    await send({ method: 'PUT', path: PROJECT_PATH, body: { today: 2 } })

    expect(savedConfig(agentDir.path)).toMatchObject({
      budgets: { [PROJECT]: { today: 2 } }
    })

    const removed = await send({ method: 'DELETE', path: PROJECT_PATH })

    expect(await removed.json()).toEqual({ budgets: OTHER_BUDGETS })
    expect(auditRecords(lines).at(-1)).toMatchObject({
      properties: { before: 'today $2.00', after: 'none' }
    })
  })

  // Catches a budget saved under a name no request could carry, or an amount the config would
  // drop on its next read, either of which shows a budget that never applies.
  test.each([
    { name: 'a label the header refuses', path: '/budgets/has%20space', body: { today: 1 } },
    { name: 'an amount of 0', path: PROJECT_PATH, body: { today: 0 } },
    { name: 'a window that is none', path: PROJECT_PATH, body: { month: 1 } }
  ])('refuses $name without changing the file', async ({ path, body }) => {
    const response = await send({ method: 'PUT', path, body })

    expect(response.status).toBe(400)
    expect(savedConfig(agentDir.path)).toMatchObject({ budgets: OTHER_BUDGETS })
    expect(auditRecords(lines)).toEqual([])
  })

  // Catches a viewer who can change what the budgets report, though they may read them.
  test("refuses a viewer's change, but lets them read the budgets", async () => {
    const write = await send({
      method: 'PUT',
      path: PROJECT_PATH,
      body: { today: 1 },
      role: 'viewer'
    })
    const read = await send({ method: 'GET', path: '/budgets', role: 'viewer' })

    expect(write.status).toBe(403)
    expect(await read.json()).toEqual({ budgets: OTHER_BUDGETS })
  })
})
