/**
 * `/proxy start` spawning a proxy (`extensions/proxy/process.ts`: `spawnProxy`, `startDetached`,
 * `startSessionTied`, `waitForReady`), and the stop that ends each lifetime: what the user is
 * told, which process is tracked, and the PID file.
 *
 * The proxy is a real child: the extension runs `dist/index.mjs` under its package root, which
 * these tests point at a temp dir holding a stand-in script (`ProxyState.packageRoot`), so the
 * spawn, the environment and the readiness probe are the extension's own. The PID file and the
 * config live in the same temp dir (`PI_CODING_AGENT_DIR`); every child is killed after each test.
 * The clock is real: the proxy is another process and the probe is real HTTP, which fake timers
 * cannot drive, so the tests of a proxy that never answers sit out the extension's 3 s wait.
 * The checks before a spawn (refusals, a stale PID file) are in `extension-process.test.ts`.
 */

import { once } from 'node:events'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { SettingsManager } from '@earendil-works/pi-coding-agent'
import { DEFAULT_CONFIG, type ProxyConfig } from '@proxy/config/schema'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

import {
  getPidPath,
  startProxy,
  stopProxy,
  stopSessionProcess
} from '../../extensions/proxy/process'
import type { ProxyState } from '../../extensions/proxy/state'
import { fakeCommandContext } from '../fixtures/extension-context'
import { freePort } from '../fixtures/local-server'

vi.mock('@vx-daniel/pi-switchboard/config', () => import('@proxy/config/schema'))
vi.mock('@vx-daniel/pi-switchboard/logging', () => import('@proxy/logging'))

/** The status-bar key the extension owns. */
const STATUS_KEY = 'proxy'
/** How long `/proxy start` waits for a spawned proxy to answer (`READY_TIMEOUT_MS`). */
const EXTENSION_READY_TIMEOUT_MS = 3000
/**
 * Test timeout for a start that sits out the whole ready wait: the wait, plus room for the spawn
 * and the last probe on a loaded machine.
 */
const WAITS_OUT_READY_TEST_TIMEOUT_MS = 10_000
/** How long a slow stand-in waits before it listens: past two of the extension's 300 ms polls. */
const SLOW_START_MS = 700
/** How often {@link waitForExit} checks that a process has exited. */
const EXIT_POLL_MS = 10
/**
 * What `fetch` rejects with when nothing listens on a loopback port: matched on the socket's code,
 * not undici's message, which may change between Node versions.
 */
const REFUSED = { cause: { code: 'ECONNREFUSED' } }

/**
 * Builds a stand-in for the package's built entry: a server on the host and port the extension
 * passes in the environment that answers `GET /v1/models` with one model and any other path 404.
 *
 * @param listenAfterMs - how long it runs before it listens, as a slow-starting proxy would
 * @returns the entry's source, an ES module
 */
function standIn(listenAfterMs: number): string {
  return `
import { createServer } from 'node:http'
const server = createServer((request, response) => {
  if (request.url !== '/v1/models') {
    response.writeHead(404).end()
    return
  }
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ object: 'list', data: [{ id: 'stand-in' }] }))
})
setTimeout(() => {
  server.listen(Number(process.env.PI_SWITCHBOARD_PORT), process.env.PI_SWITCHBOARD_HOST)
}, ${String(listenAfterMs)})
`
}

/** An entry that runs and never listens: a proxy stuck before it serves. */
const NEVER_LISTENS = 'setInterval(() => {}, 60_000)\n'
/** An entry that exits at once with code 3: a proxy that refuses to start. */
const EXITS_AT_ONCE = 'process.exit(3)\n'
/** What names a stand-in's PID record: an empty file `started-<pid>` beside `dist/`. */
const PID_RECORD_PREFIX = 'started-'
/**
 * The first lines of every stand-in: it records its own PID, so `afterEach` kills it even when the
 * extension lost track of it (the bug a failing test reports).
 */
const RECORD_OWN_PID = `import { writeFileSync } from 'node:fs'
writeFileSync(new URL('../${PID_RECORD_PREFIX}' + String(process.pid), import.meta.url), '')
`

let agentDir: string

/**
 * Says whether a process is still running.
 *
 * @param pid - the process; `undefined` for none
 * @returns whether signal 0 reaches it; `false` for none
 */
function isAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Waits until a process has exited. A detached proxy is not a child this test can wait for, so
 * its PID is polled.
 *
 * @param pid - the process
 */
async function waitForExit(pid: number): Promise<void> {
  while (isAlive(pid)) await sleep(EXIT_POLL_MS)
}

/**
 * Finds the proxy process the extension keeps track of: its session child, or the process its PID
 * file names.
 *
 * @param state - the state `startProxy` ran with
 * @returns the PID, or `undefined` when it tracks none
 */
function trackedPid(state: ProxyState): number | undefined {
  if (state.sessionProcess !== undefined) return state.sessionProcess.pid
  return existsSync(getPidPath()) ? Number(readFileSync(getPidPath(), 'utf-8')) : undefined
}

/**
 * Writes a config that starts the proxy on a free loopback port with `lifetime`, and builds the
 * state `startProxy` runs with.
 *
 * @param lifetime - the configured proxy lifetime
 * @returns the state, whose package root is the temp dir, and the proxy's URL
 */
async function configure(
  lifetime: ProxyConfig['lifetime']
): Promise<{ state: ProxyState; url: string }> {
  const port = await freePort()
  writeFileSync(
    join(agentDir, 'proxy-config.json'),
    JSON.stringify({ host: '127.0.0.1', port, lifetime })
  )
  const state: ProxyState = {
    config: { ...DEFAULT_CONFIG, host: '127.0.0.1', port },
    sessionProcess: undefined,
    modelRegistry: undefined,
    settingsManager: SettingsManager.inMemory({}),
    packageRoot: agentDir
  }
  return { state, url: `http://127.0.0.1:${String(port)}` }
}

/**
 * Installs `script` as the package's built entry (`dist/index.mjs` under the temp package root),
 * after {@link RECORD_OWN_PID}, then {@link configure}s the proxy.
 *
 * @param script - the entry's source, an ES module run by Node
 * @param lifetime - the configured proxy lifetime
 * @returns the state and the proxy's URL
 */
async function installEntry(
  script: string,
  lifetime: ProxyConfig['lifetime']
): Promise<{ state: ProxyState; url: string }> {
  mkdirSync(join(agentDir, 'dist'))
  writeFileSync(join(agentDir, 'dist', 'index.mjs'), RECORD_OWN_PID + script)
  return configure(lifetime)
}

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), 'pi-proxy-start-'))
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDir)
})

afterEach(async () => {
  const records = readdirSync(agentDir).filter((fileName) => fileName.startsWith(PID_RECORD_PREFIX))
  for (const pid of records.map((record) => Number(record.slice(PID_RECORD_PREFIX.length)))) {
    if (isAlive(pid)) {
      process.kill(pid, 'SIGKILL')
      await waitForExit(pid)
    }
  }
  vi.unstubAllEnvs()
  rmSync(agentDir, { recursive: true, force: true })
})

describe('startProxy spawning a proxy', () => {
  // Catches `/proxy start` never actually starting a proxy, or reporting it before it answers:
  // with nothing answering, the extension must spawn the package's built entry with the config as
  // environment, wait until it answers, then report its URL, model count and lifetime.
  test.each([
    { lifetime: 'session', mode: 'session', kept: { sessionChild: true, pidFile: false } },
    { lifetime: 'detached', mode: 'background', kept: { sessionChild: false, pidFile: true } }
  ] as const)(
    '$lifetime: spawns the built entry, waits until it answers, and reports it',
    async ({ lifetime, mode, kept }) => {
      const { state, url } = await installEntry(standIn(0), lifetime)
      const { context, notifications, statuses } = fakeCommandContext({})

      await startProxy(state, context)

      expect(notifications).toEqual([
        { message: `Proxy started at ${url} (1 models) [${mode}]`, level: 'info' }
      ])
      expect(statuses.at(-1)).toEqual({ key: STATUS_KEY, text: `proxy: ${url} (1 models)` })
      expect({
        sessionChild: state.sessionProcess !== undefined,
        pidFile: existsSync(getPidPath())
      }).toEqual(kept)
      expect(isAlive(trackedPid(state))).toBe(true)
    }
  )

  // Catches `/proxy start` giving up on a proxy that is still starting: the probe is repeated until
  // the proxy answers, so one that listens only after a few polls is reported started, not
  // unreachable.
  test('a proxy that listens only after a few polls: waited for, then reported', async () => {
    const { state, url } = await installEntry(standIn(SLOW_START_MS), 'session')
    const { context, notifications, statuses } = fakeCommandContext({})

    await startProxy(state, context)

    expect({ notifications, status: statuses.at(-1) }).toEqual({
      notifications: [{ message: `Proxy started at ${url} (1 models) [session]`, level: 'info' }],
      status: { key: STATUS_KEY, text: `proxy: ${url} (1 models)` }
    })
  })

  // Catches a detached proxy that `/proxy stop` cannot find or stop: `/proxy start` must record the
  // spawned proxy's own PID, and `/proxy stop` must stop that process and remove the file.
  test('detached: the PID file names the proxy, and /proxy stop stops it and removes the file', async () => {
    const { state, url } = await installEntry(standIn(0), 'detached')
    const { context, notifications } = fakeCommandContext({})

    await startProxy(state, context)
    const pid = Number(readFileSync(getPidPath(), 'utf-8'))
    await stopProxy(state, context)
    await waitForExit(pid)

    expect({ notifications, pidFile: existsSync(getPidPath()) }).toEqual({
      notifications: [
        { message: `Proxy started at ${url} (1 models) [background]`, level: 'info' },
        { message: `Proxy stopped (pid ${String(pid)})`, level: 'info' }
      ],
      pidFile: false
    })
    // The PID was the proxy's own: with that process gone, nothing answers.
    await expect(fetch(`${url}/v1/models`)).rejects.toMatchObject(REFUSED)
  })

  // Catches a session-tied proxy outliving its pi session: at session shutdown the extension
  // SIGTERMs the child it spawned, which stops serving; no PID file ever pointed at it.
  test('session: stopped when its pi session shuts down, never in the PID file', async () => {
    const { state, url } = await installEntry(standIn(0), 'session')
    const { context, statuses } = fakeCommandContext({})
    await startProxy(state, context)
    const child = state.sessionProcess
    if (child === undefined) throw new Error('no session proxy was spawned')
    const exited = once(child, 'exit')

    stopSessionProcess(state)

    expect(await exited).toEqual([null, 'SIGTERM'])
    expect({
      sessionProcess: state.sessionProcess,
      pidFile: existsSync(getPidPath()),
      status: statuses.at(-1)
    }).toEqual({
      sessionProcess: undefined,
      pidFile: false,
      status: { key: STATUS_KEY, text: undefined }
    })
    await expect(fetch(`${url}/v1/models`)).rejects.toMatchObject(REFUSED)
  })

  // Catches `/proxy start` hanging on a proxy that never answers, or losing track of it: after the
  // ready wait the user is told it is not reachable, and the process is still tracked, so
  // `/proxy stop` (or session shutdown) can still stop it.
  test.each(['session', 'detached'] as const)(
    '%s proxy that never answers: warned after the ready wait, still tracked',
    async (lifetime) => {
      const { state, url } = await installEntry(NEVER_LISTENS, lifetime)
      const { context, notifications, statuses } = fakeCommandContext({})
      const startedAt = Date.now()

      await startProxy(state, context)

      expect({
        waitedOut: Date.now() - startedAt >= EXTENSION_READY_TIMEOUT_MS,
        notifications,
        statuses,
        running: isAlive(trackedPid(state))
      }).toEqual({
        waitedOut: true,
        notifications: [
          { message: `Proxy spawned but not yet reachable at ${url}`, level: 'warning' }
        ],
        statuses: [
          { key: STATUS_KEY, text: 'proxy: starting...' },
          { key: STATUS_KEY, text: undefined }
        ],
        running: true
      })
    },
    WAITS_OUT_READY_TEST_TIMEOUT_MS
  )

  // Catches a proxy that dies on start being reported as merely slow, or as still running: the user
  // hears its exit code, then that it never answered, and the extension stops tracking it.
  test(
    'session proxy that exits at once: exit code reported, then not reachable',
    async () => {
      const { state, url } = await installEntry(EXITS_AT_ONCE, 'session')
      const { context, notifications, statuses } = fakeCommandContext({})

      await startProxy(state, context)

      expect({
        notifications,
        sessionProcess: state.sessionProcess,
        status: statuses.at(-1)
      }).toEqual({
        notifications: [
          { message: 'Proxy exited with code 3', level: 'warning' },
          { message: `Proxy spawned but not yet reachable at ${url}`, level: 'warning' }
        ],
        sessionProcess: undefined,
        status: { key: STATUS_KEY, text: undefined }
      })
    },
    WAITS_OUT_READY_TEST_TIMEOUT_MS
  )

  // Catches a detached spawn that fails leaving a PID file, a "starting" status, or an exception
  // out of `/proxy start`: with no built entry and no `pi-switchboard` on PATH, the start fails
  // with a notification and nothing is left behind.
  test('detached, nothing to run: start reported failed, no PID file, status cleared', async () => {
    const { state } = await configure('detached')
    const emptyBin = join(agentDir, 'bin')
    mkdirSync(emptyBin)
    vi.stubEnv('PATH', emptyBin)
    const { context, notifications, statuses } = fakeCommandContext({})

    await startProxy(state, context)

    expect({ notifications, statuses, pidFile: existsSync(getPidPath()) }).toEqual({
      notifications: [
        { message: 'Failed to start proxy: No PID returned from spawn', level: 'error' }
      ],
      statuses: [
        { key: STATUS_KEY, text: 'proxy: starting...' },
        { key: STATUS_KEY, text: undefined }
      ],
      pidFile: false
    })
  })
})
