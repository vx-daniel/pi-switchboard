/**
 * The CLI entry (src/index.ts), run in-process the way `pi-switchboard` runs it: argv in, then
 * what the user sees (stdout, stderr, exit code) and what the started server answers on loopback.
 */

import { once } from 'node:events'
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'

import { resetSync } from '@logtape/logtape'
import { isRecord } from '@proxy/utils/guards'
import {
  afterEach,
  assert,
  beforeEach,
  describe,
  expect,
  onTestFinished,
  test,
  vi
} from 'vite-plus/test'

import packageJson from '../../package.json' with { type: 'json' }
import { type FixtureAgentDir, loadFixtureAgentDir, offlineProvider } from '../fixtures/agent-dir'
import { listenOnLoopback } from '../fixtures/local-server'

/**
 * Every `PI_SWITCHBOARD_*` variable the CLI entry reads (`loadConfig`'s, plus `PI_SWITCHBOARD_LOG_FORMAT`):
 * the developer's own settings must not reach a test.
 */
const PROXY_ENV_VARIABLES = [
  'PI_SWITCHBOARD_HOST',
  'PI_SWITCHBOARD_PORT',
  'PI_SWITCHBOARD_AUTH_TOKEN',
  'PI_SWITCHBOARD_REMOTE_IMAGES',
  'PI_SWITCHBOARD_DOCS_UI',
  'PI_SWITCHBOARD_STATS',
  'PI_SWITCHBOARD_MAX_BODY_SIZE',
  'PI_SWITCHBOARD_UPSTREAM_TIMEOUT_MS',
  'PI_SWITCHBOARD_AGENTIC',
  'PI_SWITCHBOARD_LOG_LEVEL',
  'PI_SWITCHBOARD_LOG_FORMAT'
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
/** How long an info flag's test waits for a server it must not have started, in milliseconds. */
const SERVER_SETTLE_MS = 1000

const originalArgv = process.argv
let agentDir: FixtureAgentDir | undefined
let stdout: string[] = []
let stderr: string[] = []
/** The shutdown signal listeners present before the entry ran: only its own are removed. */
let signalListenersBefore = new Set<unknown>()

/**
 * Captures what is written to a stream instead of letting it reach the terminal.
 *
 * @param stream - the stream whose `write` is replaced (stdout or stderr)
 * @param sink - the array each written chunk is appended to, as UTF-8 text
 */
function captureWrites(stream: NodeJS.WriteStream, sink: string[]): void {
  vi.spyOn(stream, 'write').mockImplementation((chunk: string | Uint8Array) => {
    sink.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  })
}

/**
 * Writes `proxy-config.json` into the fixture agent dir, where the proxy reads its config file.
 *
 * @param contents - the config object, written as JSON
 * @throws AssertionError when no fixture agent dir is loaded
 */
function writeConfigFile(contents: Record<string, unknown>): void {
  assert(agentDir !== undefined, 'no fixture agent dir')
  writeFileSync(join(agentDir.path, 'proxy-config.json'), JSON.stringify(contents))
}

/**
 * Runs the CLI entry with these arguments, as `pi-switchboard <args>` would.
 *
 * @param args - the command-line arguments after the program name
 */
async function runCli(args: readonly string[]): Promise<void> {
  process.argv = [process.execPath, 'pi-switchboard', ...args]
  vi.resetModules()
  // Dynamic and fresh each time: evaluating the entry module is what runs the CLI on process.argv.
  await import('@proxy/index')
}

/**
 * Parses the JSON log records written to stderr so far.
 *
 * @returns every stderr line that starts with `{`, parsed, in write order
 * @throws AssertionError when such a line is not a JSON object
 */
function logRecords(): Record<string, unknown>[] {
  return stderr
    .filter((line) => line.startsWith('{'))
    .map((line) => {
      const record: unknown = JSON.parse(line)
      assert(isRecord(record), 'a log line is not a JSON object')
      return record
    })
}

/**
 * Finds a loopback port nothing listens on right now.
 *
 * @returns a port number that was free when its probe server closed
 */
async function freePort(): Promise<number> {
  const probe = createServer()
  const origin = await listenOnLoopback(probe)
  probe.close()
  await once(probe, 'close')
  return Number(new URL(origin).port)
}

/**
 * Lists the listeners the entry added for a signal: those not present before it ran.
 *
 * @typeParam Signal - the shutdown signal, `SIGTERM` or `SIGINT`
 * @param signal - the signal whose listeners are listed
 * @returns the added listeners, in registration order
 */
function addedListeners<Signal extends 'SIGTERM' | 'SIGINT'>(signal: Signal) {
  return process.listeners(signal).filter((listener) => !signalListenersBefore.has(listener))
}

/**
 * Runs the entry's shutdown handlers as a signal would, with its forced-exit timer faked so it can
 * never end the test process. The handlers stay registered; `afterEach` removes them.
 */
function deliverShutdownSignals(): void {
  vi.useFakeTimers({ toFake: ['setTimeout'] })
  for (const listener of addedListeners('SIGTERM')) listener('SIGTERM')
  for (const listener of addedListeners('SIGINT')) listener('SIGINT')
  vi.clearAllTimers()
  vi.useRealTimers()
}

/**
 * Waits until the started proxy answers on this origin.
 *
 * @remarks
 * Asks the liveness check, `/healthz`, which answers without proxy auth; only a refused connection
 * keeps it waiting.
 *
 * @param origin - the proxy's origin, such as `http://127.0.0.1:4141`
 */
async function waitForListening(origin: string): Promise<void> {
  await vi.waitFor(async () => {
    await fetch(`${origin}/healthz`)
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

  // Catches --config printing the config and exiting 0 past an unusable flag, where every other
  // path refuses it with the valid values (#95; CONSTITUTION.md, principle II).
  test('--config with an invalid --log-level refuses too, printing no config', async () => {
    await runCli(['--config', '--log-level', 'loud'])

    await vi.waitFor(() => {
      expect(process.exitCode).toBe(1)
    })
    expect({ stderr, stdout }).toEqual({
      stderr: ['--log-level must be one of: trace, debug, info, warning, error, fatal\n'],
      stdout: []
    })
  })
})

describe('--version and --help', () => {
  // Catches the version missing (citty exits 1 with "No version specified", #168) or taken from
  // anywhere but package.json, which semantic-release bumps in each release commit.
  test.each(['--version', '-v'])('%s prints the package version and exits 0', async (flag) => {
    const printed: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => {
      printed.push(parts.map(String).join(' '))
    })

    await runCli([flag])

    await vi.waitFor(() => {
      expect(printed).toEqual([packageJson.version])
    })
    expect(process.exitCode).toBeUndefined()
    expect(stderr).toEqual([])
  })

  // Catches an info flag starting the proxy: the image's entrypoint runs these four alone without
  // a token (#168) because citty prints and exits for them without calling `run`. A change that
  // calls `run` anyway (a citty upgrade, or `runCommand` in place of `runMain`) would serve the pi
  // login on every interface with auth off.
  test.each([
    ['--version', []],
    ['-v', []],
    ['--help', [0]],
    ['-h', [0]]
  ])('%s alone starts no server', async (flag, expectedExits) => {
    const port = await freePort()
    writeConfigFile({ port })
    const printed: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => {
      printed.push(parts.map(String).join(' '))
    })
    // citty ends --help with process.exit(0). Vitest throws on that, and citty's catch then calls
    // process.exit(1) outside any test, so the call is recorded instead. Replaced, not spied:
    // a spy's stub must return `never`, and this one returns.
    const exits: unknown[] = []
    const realExit = process.exit
    Object.defineProperty(process, 'exit', {
      configurable: true,
      value: (code?: unknown) => {
        exits.push(code)
      }
    })
    onTestFinished(() => {
      Object.defineProperty(process, 'exit', { configurable: true, value: realExit })
    })

    await runCli([flag])
    await vi.waitFor(() => {
      expect(printed).not.toEqual([])
    })
    // Long enough for a server the flag wrongly started to listen: the tests that start one
    // (below) listen well within it.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, SERVER_SETTLE_MS)
    })

    await expect(fetch(`http://127.0.0.1:${String(port)}/healthz`)).rejects.toThrow()
    expect(addedListeners('SIGTERM')).toEqual([])
    expect(exits).toEqual(expectedExits)
  })
})

describe('starting', () => {
  // Catches a port already in use surfacing as an uncaught exception with a stack trace (and, in
  // the console, after it took over the terminal): it is a fatal line naming the address, exit 1.
  test('a port in use refuses to start with a fatal line and exit 1', async () => {
    const occupied = createServer()
    const origin = await listenOnLoopback(occupied)
    writeConfigFile({ port: Number(new URL(origin).port) })

    try {
      await runCli([])
      await vi.waitFor(() => {
        expect(process.exitCode).toBe(1)
      })
    } finally {
      occupied.close()
    }
    expect(logRecords()).toContainEqual(
      expect.objectContaining({
        level: 'FATAL',
        message: expect.stringContaining('Cannot listen on') as unknown
      })
    )
  })
})

describe('tui', () => {
  // Catches the console started where there is no terminal to draw on (a script, a service),
  // which would hang or corrupt its output: it refuses and names the headless command.
  test.each([
    ['tui', ['tui']],
    ['tui after flags', ['--port', '4999', 'tui']],
    ['tui after a --flag=value', ['--log-level=info', 'tui']]
  ])('%s without a terminal refuses with exit 1', async (_case, args) => {
    await runCli(args)

    await vi.waitFor(() => {
      expect(process.exitCode).toBe(1)
    })
    expect(stderr.join('')).toContain('pi-switchboard tui needs an interactive terminal')
  })

  // Catches a flag's value taken for the subcommand: `--log-format tui` is the headless CLI with
  // an invalid format, not the console (third #195 review).
  test('a flag whose value is tui stays headless', async () => {
    await runCli(['--log-format', 'tui'])

    await vi.waitFor(() => {
      expect(process.exitCode).toBe(1)
    })
    expect(stderr).toEqual(['--log-format must be one of: pretty, json\n'])
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
  // demands, the body and timeout limits, remote images, the docs UI and the log level.
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
      '--docs-ui',
      '--responses-api',
      '--no-stats',
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
      docsUiEnabled: true,
      responsesApiEnabled: true,
      statsEnabled: false,
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
    vi.stubEnv('PI_SWITCHBOARD_LOG_FORMAT', 'xml')
    vi.stubEnv('PI_SWITCHBOARD_LOG_LEVEL', 'loud')

    await runCli(['--port', 'abc', '--max-body-size', '0', '--log-format', 'json'])
    await waitForListening(`http://127.0.0.1:${String(port)}`)

    // String values are quoted in JSON log messages on purpose, so a value can never pose as
    // message text (#94, closed as intended).
    expect(
      logRecords()
        .map((record) => record['message'])
        .slice(0, WARNING_COUNT)
    ).toEqual([
      'Ignoring --"port"="abc": not a positive integer',
      'Ignoring --"max-body-size"="0": not a positive integer',
      'Ignoring PI_SWITCHBOARD_LOG_LEVEL="loud": not one of ["trace","debug","info","warning","error","fatal"]; using "info"',
      'Ignoring PI_SWITCHBOARD_LOG_FORMAT="xml": not one of ["pretty","json"]'
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
      await expect(fetch(`${origin}/healthz`)).rejects.toThrow()
    })
    const messages = logRecords().map((record) => String(record['message']))
    expect(messages.filter((message) => message.startsWith('Received'))).toEqual([
      'Received "SIGTERM", shutting down'
    ])
  })

  // Catches a non-string authToken starting the proxy (#82): with auth off, any client reaches the
  // provider logins; refusing every request hides the mistake behind a running process. Also
  // catches the reason missing, filtered out by the log level, or quoting the value.
  test('a non-string authToken refuses to start, naming the field', async () => {
    const port = await freePort()
    writeConfigFile({ port, authToken: 987654321 })

    await runCli(['--log-format', 'json', '--log-level', 'fatal'])
    await vi.waitFor(() => {
      expect(process.exitCode).toBe(1)
    })

    assert(agentDir !== undefined, 'no fixture agent dir')
    const configFile = join(agentDir.path, 'proxy-config.json')
    expect(
      logRecords().map((record) => ({ level: record['level'], message: record['message'] }))
    ).toEqual([
      {
        level: 'FATAL',
        message: `Refusing to start: authToken in "${configFile}" is not a string. Fix it, or set a token with --auth-token or PI_SWITCHBOARD_AUTH_TOKEN`
      }
    ])
    expect(JSON.stringify(logRecords())).not.toContain('987654321')
    await expect(fetch(`http://127.0.0.1:${String(port)}/healthz`)).rejects.toThrow()
  })

  // Catches `--auth-token ''` starting a proxy (#99) that refuses every request, or one with auth
  // off: the CLI exits 1 and names the flag.
  test("--auth-token '' refuses to start, naming the flag", async () => {
    const port = await freePort()
    writeConfigFile({ port })

    await runCli(['--auth-token', '', '--log-format', 'json'])
    await vi.waitFor(() => {
      expect(process.exitCode).toBe(1)
    })

    expect(logRecords().filter((record) => record['level'] === 'FATAL')).toEqual([
      expect.objectContaining({
        message:
          'Refusing to start: "--auth-token" is set but empty. Set a token, or unset it to use the config file'
      }) as unknown
    ])
    await expect(fetch(`http://127.0.0.1:${String(port)}/healthz`)).rejects.toThrow()
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
