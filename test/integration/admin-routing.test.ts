/**
 * The admin UI's alias and login writes (#367, phase 2) against a real `proxy-config.json`: an
 * editor saves, renames and deletes aliases, orders, disables and labels logins, and ends
 * cooldowns; each change is logged with who made it, and what the console's editor would never
 * offer is refused without changing the file.
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { resetSync } from '@logtape/logtape'
import { configureLogging } from '@proxy/logging'
import { activeCooldowns, clearAllCooldowns, startCooldown } from '@proxy/pi/cooldowns'
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

/** A base URL nothing listens on: no test here calls a provider. */
const NOWHERE = 'http://127.0.0.1:9/v1'

let agentDir: FixtureAgentDir
let lines: string[]
let app: Hono

beforeAll(async () => {
  agentDir = await loadFixtureAgentDir({
    modelsJson: {
      providers: {
        'alpha': offlineProvider({ id: 'deep-mock', reasoning: true }, 'quick-mock'),
        // Two Opus models, for a family target and its pin (#231).
        'anthropic': offlineProvider('claude-opus-5', 'claude-opus-5-5'),
        // Two logins of one provider (#227): pi's built-in Groq catalog, never called.
        'groq': { baseUrl: NOWHERE, apiKey: 'notarealsecret-first-login-key' },
        'groq-2': { baseUrl: NOWHERE }
      }
    },
    authJson: { 'groq-2': { type: 'api_key', key: 'notarealsecret-second-login-key' } }
  })
  app = adminApp()
})

afterAll(() => {
  agentDir.remove()
  vi.unstubAllEnvs()
})

beforeEach(() => {
  writeProxyConfig(agentDir.path, { port: 4141, aliases: { old: 'alpha/quick-mock' } })
  clearAllCooldowns()
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

describe('admin aliases', () => {
  // Catches an editor offered a model the proxy doesn't expose, an effort a model doesn't run at,
  // or a family without its members, newest first. pi's built-in Anthropic models are exposed too,
  // beside the fixture's two Opus models.
  test('offers the exposed models with their efforts, and the families', async () => {
    const response = await send({ method: 'GET', path: '/models', role: 'viewer' })

    expect(await response.json()).toMatchObject({
      options: {
        models: expect.arrayContaining([
          { id: 'alpha/quick-mock', efforts: ['none'] },
          expect.objectContaining({
            id: 'alpha/deep-mock',
            efforts: expect.arrayContaining(['high'])
          })
        ]),
        families: expect.arrayContaining([
          expect.objectContaining({
            family: 'anthropic/claude-opus',
            members: expect.arrayContaining([
              'anthropic/claude-opus-5-5',
              'anthropic/claude-opus-5'
            ]),
            newest: 'anthropic/claude-opus-5-5'
          })
        ]),
        failures: expect.arrayContaining(['rate_limit'])
      }
    })
  })

  // Catches an alias saved in another shape than the console writes, or saved with no record of
  // who made it.
  test("saves an editor's alias in its shortest form, and logs it", async () => {
    const response = await send({
      method: 'PUT',
      path: '/aliases/fast',
      body: { targets: [{ model: 'alpha/deep-mock', reasoningEffort: 'high' }], fallbackOn: [] }
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ configured: { fast: expect.anything() } })
    expect(savedConfig(agentDir.path)).toMatchObject({
      aliases: {
        old: 'alpha/quick-mock',
        fast: { model: 'alpha/deep-mock', reasoningEffort: 'high' }
      }
    })
    expect(auditRecords(lines)).toMatchObject([
      {
        properties: {
          login: 'alice',
          alias: 'fast',
          before: 'none',
          after: 'alpha/deep-mock at high'
        }
      }
    ])
  })

  // Catches a rename that leaves the old alias behind, or a chain written without its order or
  // its fallback classes.
  test('renames an alias into a chain, in its place', async () => {
    await send({
      method: 'PUT',
      path: '/aliases/renamed',
      body: {
        previousName: 'old',
        targets: [
          { family: 'anthropic/claude-opus', pin: 'anthropic/claude-opus-5' },
          { model: 'alpha/quick-mock' }
        ],
        fallbackOn: ['rate_limit']
      }
    })

    expect(savedConfig(agentDir.path)).toMatchObject({
      aliases: {
        renamed: {
          targets: [
            { family: 'anthropic/claude-opus', pin: 'anthropic/claude-opus-5' },
            'alpha/quick-mock'
          ],
          fallbackOn: ['rate_limit']
        }
      }
    })
    expect(savedConfig(agentDir.path)['aliases']).not.toHaveProperty('old')
  })

  // Catches what the console's editor never offers reaching the file: an unexposed model, an
  // effort the model doesn't run at, a pin outside the family, a name a model has, a target that
  // mixes a model and a family, or a viewer's change.
  test.each([
    {
      refused: 'an unexposed model',
      targets: [{ model: 'alpha/gone' }],
      status: 400,
      code: 'invalid_target'
    },
    {
      refused: 'an effort the model lacks',
      targets: [{ model: 'alpha/quick-mock', reasoningEffort: 'high' }],
      status: 400,
      code: 'invalid_target'
    },
    {
      refused: 'a pin outside the family',
      targets: [{ family: 'anthropic/claude-opus', pin: 'alpha/deep-mock' }],
      status: 400,
      code: 'invalid_target'
    },
    {
      refused: 'a model and a family in one target',
      targets: [{ model: 'alpha/deep-mock', family: 'anthropic/claude-opus' }],
      status: 400,
      code: 'invalid_body'
    },
    {
      refused: "a model's ID as the name",
      name: 'alpha/deep-mock',
      targets: [{ model: 'alpha/quick-mock' }],
      status: 400,
      code: 'invalid_name'
    },
    {
      refused: "a viewer's alias",
      role: 'viewer',
      targets: [{ model: 'alpha/quick-mock' }],
      status: 403,
      code: 'editor_only'
    }
  ] as const)('refuses $refused', async (refusal) => {
    const before = savedConfig(agentDir.path)

    const response = await send({
      method: 'PUT',
      path: `/aliases/${encodeURIComponent('name' in refusal ? refusal.name : 'new')}`,
      role: 'role' in refusal ? refusal.role : 'editor',
      body: { targets: refusal.targets, fallbackOn: [] }
    })

    expect(response.status).toBe(refusal.status)
    expect(await response.json()).toMatchObject({ error: { code: refusal.code } })
    expect(savedConfig(agentDir.path)).toEqual(before)
    expect(auditRecords(lines)).toEqual([])
  })

  // Catches a delete that leaves the alias, or one of an alias that was never there answered as
  // done.
  test('deletes an alias, and refuses one that is not there', async () => {
    expect((await send({ method: 'DELETE', path: '/aliases/old' })).status).toBe(200)
    expect(savedConfig(agentDir.path)['aliases']).toEqual({})

    const missing = await send({ method: 'DELETE', path: '/aliases/old' })
    expect(missing.status).toBe(404)
    expect(auditRecords(lines)).toHaveLength(1)
  })

  // Catches the admin UI writing over a file it can't parse, which would lose the aliases in it.
  test('never writes over an unusable file', async () => {
    writeFileSync(join(agentDir.path, 'proxy-config.json'), '{ not json')

    const response = await send({ method: 'DELETE', path: '/aliases/old' })

    expect(response.status).toBe(409)
  })
})

describe('admin logins', () => {
  // Catches the order written for the wrong provider, or with the other login dropped.
  test('puts a login first among its provider’s logins', async () => {
    const response = await send({ method: 'POST', path: '/logins/groq-2/first' })

    expect(response.status).toBe(200)
    expect(savedConfig(agentDir.path)).toMatchObject({
      routing: { logins: { order: { groq: ['groq-2', 'groq'] } } }
    })
    expect(auditRecords(lines)).toMatchObject([
      { properties: { operator: 'alice', login: 'groq-2' } }
    ])
  })

  // Catches a provider's every login disabled with no warning, which withdraws its models: the
  // last enabled one needs a confirmation, as in the console.
  test('asks before disabling a provider’s last enabled login', async () => {
    expect(
      (await send({ method: 'PUT', path: '/logins/groq-2/disabled', body: { disabled: true } }))
        .status
    ).toBe(200)

    const unconfirmed = await send({
      method: 'PUT',
      path: '/logins/groq/disabled',
      body: { disabled: true }
    })
    expect(unconfirmed.status).toBe(400)
    expect(await unconfirmed.json()).toMatchObject({ error: { code: 'confirm_required' } })

    await send({
      method: 'PUT',
      path: '/logins/groq/disabled',
      body: { disabled: true, confirm: true }
    })
    expect(savedConfig(agentDir.path)).toMatchObject({
      routing: { logins: { disabled: ['groq-2', 'groq'] } }
    })
  })

  // Catches a label kept with its whitespace, or an empty one written rather than removed.
  test('labels a login, and removes the label when it is empty', async () => {
    await send({ method: 'PUT', path: '/logins/groq/label', body: { label: '  work  ' } })
    expect(savedConfig(agentDir.path)).toMatchObject({ labels: { groq: 'work' } })

    await send({ method: 'PUT', path: '/logins/groq/label', body: { label: '' } })
    expect(savedConfig(agentDir.path)['labels']).toEqual({})
  })

  // Catches a change to a login pi has no credential for written to the file.
  test('refuses a login pi does not have', async () => {
    const response = await send({ method: 'POST', path: '/logins/groq-9/first' })

    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: { code: 'unknown_login' } })
  })

  // Catches cooldowns left running, another login's ended, or an unknown login answered as done.
  test('ends a login’s cooldowns', async () => {
    startCooldown(
      { provider: 'groq', canonicalId: 'groq/llama-3.1-8b-instant' },
      'rate_limit',
      60_000
    )
    startCooldown(
      { provider: 'groq-2', canonicalId: 'groq/llama-3.1-8b-instant' },
      'rate_limit',
      60_000
    )

    const response = await send({ method: 'DELETE', path: '/cooldowns?provider=groq' })

    expect(await response.json()).toMatchObject({
      ended: [expect.objectContaining({ provider: 'groq' })]
    })
    expect(activeCooldowns().map((cooldown) => cooldown.provider)).toEqual(['groq-2'])
    const unknown = await send({ method: 'DELETE', path: '/cooldowns?provider=nobody' })
    expect(unknown.status).toBe(404)
  })
})
