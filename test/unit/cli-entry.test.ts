/**
 * The CLI entry (src/index.ts), run in-process the way `pi-openai-proxy` runs it: argv in, then
 * what the user sees (stdout, stderr, exit code) and what the started server answers on loopback.
 */

import { once } from 'node:events'
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'

import { resetSync } from '@logtape/logtape'
import { isRecord } from '@proxy/utils/guards'
import { afterEach, assert, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir, offlineProvider } from '../fixtures/agent-dir'
import { listenOnLoopback } from '../fixtures/local-server'

/** Every variable `loadConfig` reads: the developer's own settings must not reach a test. */
const PROXY_ENV_VARIABLES = [
  'PI_PROXY_HOST',
  'PI_PROXY_PORT',
  'PI_PROXY_AUTH_TOKEN',
  'PI_PROXY_REMOTE_IMAGES',
  'PI_PROXY_MAX_BODY_SIZE',
  'PI_PROXY_UPSTREAM_TIMEOUT_MS',
  'PI_PROXY_AGENTIC',
  'PI_PROXY_LOG_LEVEL',
  'PI_PROXY_LOG_FORMAT'
]

const FIXTURE_TOKEN = 'notarealsecret-cli-entry-token'
const FIXTURE_MODEL = 'fixture-model'
const HTTP_OK = 200
const HTTP_UNAUTHORIZED = 401
const BODY_SIZE_MB = 3
const BYTES_PER_MB = 1_048_576
const UPSTREAM_TIMEOUT_SEC = 7
const MS_PER_SECOND = 1000
/** The four warnings the invalid-input test provokes, logged before anything else. */
const WARNING_COUNT = 4

const originalArgv = process.argv
let agentDir: FixtureAgentDir | undefined
let stdout: string[] = []
let stderr: string[] = []
/** The shutdown signal listeners present before the entry ran: only its own are removed. */
let signalListenersBefore = new Set<unknown>()

/** Capture what is written to this stream instead of letting it reach the terminal. */
function captureWrites(stream: NodeJS.WriteStream, sink: string[]): void {
  vi.spyOn(stream, 'write').mockImplementation((chunk: string | Uint8Array) => {
    sink.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  })
}

/** Write `proxy-config.json` into the fixture agent dir, where the proxy reads its config file. */
function writeConfigFile(contents: Record<string, unknown>): void {
  assert(agentDir !== undefined, 'no fixture agent dir')
  writeFileSync(join(agentDir.path, 'proxy-config.json'), JSON.stringify(contents))
}

/** Run the CLI entry with these arguments, as `pi-openai-proxy <args>` would. */
async function runCli(args: readonly string[]): Promise<void> {
  process.argv = [process.execPath, 'pi-openai-proxy', ...args]
  vi.resetModules()
  // Dynamic and fresh each time: evaluating the entry module is what runs the CLI on process.argv.
  await import('@proxy/index')
}

/** The JSON log records written to stderr so far. */
function logRecords(): Record<string, unknown>[] {
  return stderr
    .filter((line) => line.startsWith('{'))
    .map((line) => {
      const record: unknown = JSON.parse(line)
      assert(isRecord(record), 'a log line is not a JSON object')
      return record
    })
}

/** A port nothing listens on right now. */
async function freePort(): Promise<number> {
  const probe = createServer()
  const origin = await listenOnLoopback(probe)
  probe.close()
  await once(probe, 'close')
  return Number(new URL(origin).port)
}

/** The signal listeners the entry added, for this signal. */
function addedListeners<Signal extends 'SIGTERM' | 'SIGINT'>(signal: Signal) {
  return process.listeners(signal).filter((listener) => !signalListenersBefore.has(listener))
}

/**
 * Run the entry's shutdown handlers as a signal would, with its forced-exit timer faked so it can
 * never end the test process, then remove them.
 */
function deliverShutdownSignals(): void {
  vi.useFakeTimers({ toFake: ['setTimeout'] })
  for (const listener of addedListeners('SIGTERM')) listener('SIGTERM')
  for (const listener of addedListeners('SIGINT')) listener('SIGINT')
  vi.clearAllTimers()
  vi.useRealTimers()
}

/** Wait until the started proxy answers on this origin. */
async function waitForListening(origin: string): Promise<void> {
  await vi.waitFor(async () => {
    await fetch(`${origin}/health`)
  })
}

beforeEach(async () => {
  for (const variableName of PROXY_ENV_VARIABLES) vi.stubEnv(variableName, undefined)
  agentDir = await loadFixtureAgentDir({
    modelsJson: { providers: { fixture: offlineProvider(FIXTURE_MODEL) } }
  })
  stdout = []
  stderr = []
  captureWrites(process.stdout, stdout)
  captureWrites(process.stderr, stderr)
  signalListenersBefore = new Set([...process.listeners('SIGTERM'), ...process.listeners('SIGINT')])
})

afterEach(() => {
  deliverShutdownSignals()
  for (const listener of addedListeners('SIGTERM')) process.removeListener('SIGTERM', listener)
  for (const listener of addedListeners('SIGINT')) process.removeListener('SIGINT', listener)
  process.argv = originalArgv
  process.exitCode = undefined
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  resetSync()
  agentDir?.remove()
  agentDir = undefined
})

describe('logging flags', () => {
  // Catches a mistyped --log-level starting the proxy anyway, or dying with a stack trace instead
  // of naming the levels the user can pick from.
  test('an invalid --log-level refuses to start and lists the valid levels', async () => {
    await runCli(['--log-level', 'loud'])

    await vi.waitFor(() => {
      expect(process.exitCode).toBe(1)
    })
    expect(stderr).toEqual([
      '--log-level must be one of: trace, debug, info, warning, error, fatal\n'
    ])
    expect(stdout).toEqual([])
  })

  // Catches a mistyped --log-format starting the proxy anyway, or not naming the valid formats.
  test('an invalid --log-format refuses to start and lists the valid formats', async () => {
    await runCli(['--log-format', 'xml'])

    await vi.waitFor(() => {
      expect(process.exitCode).toBe(1)
    })
    expect(stderr).toEqual(['--log-format must be one of: pretty, json\n'])
    expect(stdout).toEqual([])
  })
})

describe('--config', () => {
  // Catches the effective-config output, which users paste into issues, leaking the auth token.
  test('prints the config file path and the config with the auth token masked', async () => {
    writeConfigFile({ authToken: FIXTURE_TOKEN })

    await runCli(['--config'])

    await vi.waitFor(() => {
      expect(stdout).toHaveLength(2)
    })
    assert(agentDir !== undefined, 'no fixture agent dir')
    expect(stdout[0]).toBe(`Config file: ${join(agentDir.path, 'proxy-config.json')}\n`)
    const shown: unknown = JSON.parse(stdout[1] ?? '')
    assert(isRecord(shown), 'the config output is not a JSON object')
    expect(shown['authToken']).toBe('***')
    expect(stdout.join('')).not.toContain(FIXTURE_TOKEN)
    expect(process.exitCode).toBeUndefined()
  })

  // Catches a config without a token being shown as if one were set.
  test('shows an empty auth token as empty, not masked', async () => {
    await runCli(['--config'])

    await vi.waitFor(() => {
      expect(stdout).toHaveLength(2)
    })
    const shown: unknown = JSON.parse(stdout[1] ?? '')
    assert(isRecord(shown), 'the config output is not a JSON object')
    expect(shown['authToken']).toBe('')
  })

  // Catches `--config` showing a token it cannot read as empty, which reads as auth off (#82).
  test('shows an authToken that is not a string as invalid', async () => {
    writeConfigFile({ authToken: 987654321 })

    await runCli(['--config'])

    await vi.waitFor(() => {
      expect(stdout).toHaveLength(2)
    })
    const shown: unknown = JSON.parse(stdout[1] ?? '')
    assert(isRecord(shown), 'the config output is not a JSON object')
    expect(shown['authToken']).toBe('<invalid: not a string>')
    expect(stdout.join('')).not.toContain('987654321')
  })
})

describe('starting the server', () => {
  // Catches a CLI flag being dropped on its way to the server: the port it binds, the token it
  // demands, the body and timeout limits, remote images and the log level.
  test('the flags configure the server that starts', async () => {
    const port = await freePort()
    const origin = `http://127.0.0.1:${String(port)}`

    await runCli([
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--auth-token',
      FIXTURE_TOKEN,
      '--remote-images',
      '--max-body-size',
      String(BODY_SIZE_MB),
      '--upstream-timeout',
      String(UPSTREAM_TIMEOUT_SEC),
      '--log-level',
      'debug',
      '--log-format',
      'json'
    ])
    await waitForListening(origin)

    const unauthorized = await fetch(`${origin}/v1/models`)
    expect(unauthorized.status).toBe(HTTP_UNAUTHORIZED)
    const models = await fetch(`${origin}/v1/models`, {
      headers: { authorization: `Bearer ${FIXTURE_TOKEN}` }
    })
    expect(models.status).toBe(HTTP_OK)
    expect(JSON.stringify(await models.json())).toContain(FIXTURE_MODEL)

    const effective = logRecords().find((record) => record['message'] === 'Effective config')
    assert(effective !== undefined, 'no effective-config log line')
    expect(effective['properties']).toEqual({
      configPath: expect.any(String) as string,
      host: '127.0.0.1',
      port,
      proxyAuthMode: 'token',
      agenticEnabled: false,
      remoteImagesEnabled: true,
      maxBodySize: BODY_SIZE_MB * BYTES_PER_MB,
      upstreamTimeoutMs: UPSTREAM_TIMEOUT_SEC * MS_PER_SECOND,
      publicModelIdMode: expect.any(String) as string,
      modelExposureMode: expect.any(String) as string,
      customModelCount: 0,
      providerPrefixCount: 0,
      logLevel: 'debug'
    })
    expect(JSON.stringify(logRecords())).not.toContain(FIXTURE_TOKEN)
  })

  // Catches a typo in the environment or a bad numeric flag stopping the proxy, or silently
  // changing what it does, instead of being ignored with a warning.
  test('invalid env vars and numeric flags are ignored with a warning', async () => {
    const port = await freePort()
    writeConfigFile({ port })
    vi.stubEnv('PI_PROXY_LOG_FORMAT', 'xml')
    vi.stubEnv('PI_PROXY_LOG_LEVEL', 'loud')

    await runCli(['--port', 'abc', '--max-body-size', '0', '--log-format', 'json'])
    await waitForListening(`http://127.0.0.1:${String(port)}`)

    // String values are quoted in JSON log messages on purpose, so a value can never pose as message
    // text (#94, closed as intended).
    expect(
      logRecords()
        .map((record) => record['message'])
        .slice(0, WARNING_COUNT)
    ).toEqual([
      'Ignoring --"port"="abc": not a positive integer',
      'Ignoring --"max-body-size"="0": not a positive integer',
      'Ignoring PI_PROXY_LOG_LEVEL="loud": not one of ["trace","debug","info","warning","error","fatal"]; using "info"',
      'Ignoring PI_PROXY_LOG_FORMAT="xml": not one of ["pretty","json"]'
    ])
    expect(process.exitCode).toBeUndefined()
  })

  // Catches SIGTERM leaving the port bound, or a second signal logging a second shutdown.
  test('a shutdown signal closes the server once', async () => {
    const port = await freePort()
    const origin = `http://127.0.0.1:${String(port)}`

    await runCli(['--port', String(port), '--log-format', 'json'])
    await waitForListening(origin)
    deliverShutdownSignals()

    await vi.waitFor(async () => {
      await expect(fetch(`${origin}/health`)).rejects.toThrow()
    })
    const messages = logRecords().map((record) => String(record['message']))
    expect(messages.filter((message) => message.startsWith('Received'))).toEqual([
      'Received "SIGTERM", shutting down'
    ])
  })

  // Catches a non-string authToken starting the proxy with auth off (#82) without a word at the
  // default level, or the error quoting the value.
  test('a non-string authToken logs an error naming the field, and requests are refused', async () => {
    const port = await freePort()
    const origin = `http://127.0.0.1:${String(port)}`
    writeConfigFile({ port, authToken: 987654321 })

    await runCli(['--log-format', 'json'])
    await waitForListening(origin)

    assert(agentDir !== undefined, 'no fixture agent dir')
    const configFile = join(agentDir.path, 'proxy-config.json')
    const errors = logRecords().filter((record) => record['level'] === 'ERROR')
    expect(errors.map((record) => record['message'])).toEqual([
      `Proxy auth is misconfigured: authToken in "${configFile}" is not a string. Every /v1 request is refused with 401 until it is fixed, or a token is set with --auth-token or PI_PROXY_AUTH_TOKEN`
    ])
    expect(JSON.stringify(logRecords())).not.toContain('987654321')
    expect((await fetch(`${origin}/v1/models`)).status).toBe(HTTP_UNAUTHORIZED)
  })

  // Catches --auth-token not winning over a non-string authToken in the file (#82), which would
  // leave an operator no way to run the proxy short of editing the file.
  test('--auth-token wins over a non-string authToken, with no error', async () => {
    const port = await freePort()
    const origin = `http://127.0.0.1:${String(port)}`
    writeConfigFile({ port, authToken: 987654321 })

    await runCli(['--auth-token', FIXTURE_TOKEN, '--log-format', 'json'])
    await waitForListening(origin)

    const authorized = await fetch(`${origin}/v1/models`, {
      headers: { Authorization: `Bearer ${FIXTURE_TOKEN}` }
    })
    expect(authorized.status).toBe(HTTP_OK)
    expect((await fetch(`${origin}/v1/models`)).status).toBe(HTTP_UNAUTHORIZED)
    expect(logRecords().filter((record) => record['level'] === 'ERROR')).toEqual([])
  })
})
