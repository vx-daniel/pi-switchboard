/**
 * The names from before the rename to pi-switchboard (#65): the `PI_PROXY_*` env vars and the
 * `X-Pi-Upstream-Api-Key` header are not read. A still-set env var is warned about by name (the
 * old auth token refuses to start instead; `auth-misconfigured.test.ts`), and the old header is
 * rejected with 400, so a stale setup fails visibly instead of quietly doing something else.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resetSync } from '@logtape/logtape'
import { loadConfig } from '@proxy/config/env'
import { configureLogging } from '@proxy/logging'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

import { isErrorBody, jsonBody, testApp } from '../helpers'

const HTTP_BAD_REQUEST = 400
const DEFAULT_PORT = 4141
const OLD_PORT = '9999'
const OLD_KEY = 'notarealsecret-old-header-key'

let agentDir = ''
let lines: string[] = []

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), 'pi-switchboard-pre-rename-'))
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDir)
  lines = []
  configureLogging({ level: 'warning', format: 'json', write: (line) => lines.push(line) })
})

afterEach(() => {
  vi.unstubAllEnvs()
  resetSync()
  rmSync(agentDir, { recursive: true, force: true })
})

describe('a PI_PROXY_* env var still set', () => {
  // Catches the old name still read (it would keep working, and the rename would never finish),
  // or ignored without a word (the operator would not know why the setting stopped applying).
  test('is not read, and is warned about by name, with its replacement and not its value', () => {
    vi.stubEnv('PI_PROXY_PORT', OLD_PORT)
    vi.stubEnv('PI_PROXY_DOCS_UI', 'true')

    const config = loadConfig()

    expect([config.port, config.docsUiEnabled]).toEqual([DEFAULT_PORT, false])
    const renamed = lines
      .map((line): unknown => JSON.parse(line))
      .filter((record) => JSON.stringify(record).includes('no longer read'))
    expect(renamed.map((record) => JSON.stringify(record))).toEqual([
      expect.stringContaining('"oldName":"PI_PROXY_PORT","newName":"PI_SWITCHBOARD_PORT"'),
      expect.stringContaining('"oldName":"PI_PROXY_DOCS_UI","newName":"PI_SWITCHBOARD_DOCS_UI"')
    ])
    expect(lines.join('\n')).not.toContain(OLD_PORT)
  })

  // Catches the warning firing for the new names.
  test('nothing is warned about when only the new names are set', () => {
    vi.stubEnv('PI_SWITCHBOARD_PORT', OLD_PORT)

    expect(loadConfig().port).toBe(Number(OLD_PORT))
    expect(lines.join('\n')).not.toContain('no longer read')
  })
})

describe('the X-Pi-Upstream-Api-Key header', () => {
  // Catches the old header ignored: the request would run on pi's stored credential instead of
  // the key the client sent, billing another account; or the key echoed back in the error.
  test('is rejected with 400 naming the new header, without echoing the key', async () => {
    const response = await testApp().request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Pi-Upstream-Api-Key': OLD_KEY },
      body: JSON.stringify({ model: 'any/model', messages: [{ role: 'user', content: 'Hi' }] })
    })
    const body = await jsonBody(response)

    expect(response.status).toBe(HTTP_BAD_REQUEST)
    expect(isErrorBody(body) ? body.error.message : undefined).toContain(
      'X-Switchboard-Upstream-Api-Key'
    )
    expect(JSON.stringify(body)).not.toContain(OLD_KEY)
    expect(lines.join('\n')).not.toContain(OLD_KEY)
  })
})
