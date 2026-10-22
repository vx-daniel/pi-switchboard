/**
 * A chat request whose provider credential fails to resolve: the 502
 * `upstream_credentials_missing` has fixed text, and the default-level logs carry pi's summary of
 * the failure, never the detail after it.
 *
 * pi's OAuth errors run `<summary>. url=…; body=<token endpoint response>; details=…;
 * stack=<install paths>`. Refreshing a real token is not possible offline, so this uses a
 * models.json key command that resolves to nothing: pi's error then quotes the command, which is
 * written in that shape.
 */

import { resetSync } from '@logtape/logtape'
import { configureLogging } from '@proxy/logging'
import { isRecord } from '@proxy/utils/guards'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'
import { testApp } from '../helpers'

const LEAKED_DETAIL = 'notarealsecret-token-endpoint-response'
const LEAKED_PATH = 'notarealsecret-install-path'

let agentDir: FixtureAgentDir
/** The answer for a provider pi has no usable credential for (#128): fixed, quoting nothing. */
const CREDENTIALS_MISSING = {
  error: {
    message:
      "pi has no usable credential for the model's provider. Log in with pi on the proxy's host.",
    type: 'server_error',
    param: null,
    code: 'upstream_credentials_missing'
  }
}
/**
 * Every JSON log line written, with its LogTape level (`TRACE`, `DEBUG`, `INFO`, `WARN`, …) and
 * logger.
 */
const records: { level: string; logger: string; line: string }[] = []
const BELOW_DEFAULT_LEVEL = new Set(['TRACE', 'DEBUG'])

beforeAll(async () => {
  agentDir = await loadFixtureAgentDir({
    modelsJson: {
      providers: {
        'auth-broken': {
          baseUrl: 'http://127.0.0.1:9/v1',
          api: 'openai-completions',
          // Prints nothing (its last part runs a command that does not exist, so it exits 127):
          // pi treats the key as unresolved and quotes the command in its error.
          apiKey: `!true; body=${LEAKED_DETAIL}; stack=at file:///${LEAKED_PATH}/index.js`,
          models: [{ id: 'broken-model' }]
        }
      }
    }
  })
  configureLogging({
    level: 'trace',
    format: 'json',
    write: (line) => {
      const parsed: unknown = JSON.parse(line)
      const field = (name: string): string =>
        isRecord(parsed) && typeof parsed[name] === 'string' ? parsed[name] : ''
      records.push({ level: field('level'), logger: field('logger'), line })
    }
  })
})

afterAll(() => {
  resetSync()
  vi.unstubAllEnvs()
  agentDir.remove()
})

describe('chat request with a credential that fails to resolve', () => {
  // Catches pi's raw credential error, which can quote the token endpoint's response and the
  // install's paths, reaching the client or a log line a default deployment writes; and a missing
  // login answered as a 401, which a client reads as its own key being wrong (#128).
  test('answers 502 upstream_credentials_missing, and keeps the detail out of default-level logs', async () => {
    const response = await testApp().request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'auth-broken/broken-model',
        messages: [{ role: 'user', content: 'Hello' }]
      })
    })
    const text = await response.text()

    expect(response.status).toBe(502)
    expect(JSON.parse(text)).toEqual(CREDENTIALS_MISSING)
    expect(text).not.toContain(LEAKED_DETAIL)
    expect(text).not.toContain(LEAKED_PATH)

    const atInfoOrAbove = records.filter((record) => !BELOW_DEFAULT_LEVEL.has(record.level))
    // The failure is still reported where a default deployment sees it, as a warning.
    expect(
      atInfoOrAbove.some(
        (record) => record.level === 'WARN' && record.logger === 'pi-switchboard.pi.registry'
      )
    ).toBe(true)
    for (const record of atInfoOrAbove) {
      expect(record.line).not.toContain(LEAKED_DETAIL)
      expect(record.line).not.toContain(LEAKED_PATH)
    }

    // The detail is kept for whoever turns debug on, but pi's stack never is.
    const debugDetail = records.filter(
      (record) => record.level === 'DEBUG' && record.line.includes(LEAKED_DETAIL)
    )
    expect(debugDetail).not.toEqual([])
    for (const record of records) expect(record.line).not.toContain(LEAKED_PATH)
  })

  // Catches the credential check moving after the stream starts: a streaming client would then get
  // a 200 and a generic upstream error frame instead of a 502 that says what to configure.
  test('answers a streaming request with the same 502, before any stream', async () => {
    const response = await testApp().request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'auth-broken/broken-model',
        stream: true,
        messages: [{ role: 'user', content: 'Hello' }]
      })
    })

    expect(response.status).toBe(502)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(JSON.parse(await response.text())).toEqual(CREDENTIALS_MISSING)
  })
})
