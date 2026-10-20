/**
 * `/proxy status` and `/proxy stop` (`extensions/proxy/process.ts`) over a temp PID file and a
 * loopback stand-in for the proxy: what each reports, and which process each signals.
 *
 * Every process signalled here is a child this file spawns; the PID file lives in a temp agent
 * dir (`PI_CODING_AGENT_DIR`), so a real proxy or the developer's `~/.pi` are never touched.
 * The extension imports the package through its published subpaths, which resolve to `dist/`;
 * these tests point them at the sources, so they run before any build.
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SettingsManager } from '@earendil-works/pi-coding-agent'
import { DEFAULT_CONFIG } from '@proxy/config/schema'
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
  killStalePid,
  refreshStatus,
  showStatus,
  startProxy,
  stopProxy
} from '../../extensions/proxy/process'
import type { ProxyState } from '../../extensions/proxy/state'
import { fakeCommandContext } from '../fixtures/extension-context'
import { listenOnLoopback } from '../fixtures/local-server'

vi.mock('@vx-daniel/pi-switchboard/config', () => import('@proxy/config/schema'))
vi.mock('@vx-daniel/pi-switchboard/logging', () => import('@proxy/logging'))

/** HTTP 401, what a proxy with auth on answers a probe without the right token. */
const HTTP_UNAUTHORIZED = 401
/** A PID no Linux or macOS process can have (above both kernels' PID limits). */
const IMPOSSIBLE_PID = 2 ** 30
/** The status-bar key the extension owns. */
const STATUS_KEY = 'proxy'

/** Answers one request to the stand-in proxy. */
type Responder = (request: IncomingMessage, response: ServerResponse) => void

/**
 * Builds a responder that answers like a healthy proxy's `GET /v1/models`.
 *
 * @param count - how many models the list holds, with IDs `m0`, `m1`, …
 * @returns a responder that answers every request with 200 and that model list
 */
function healthy(count: number): Responder {
  return (_request, response) => {
    const data = Array.from({ length: count }, (_unused, index) => ({ id: `m${String(index)}` }))
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ object: 'list', data }))
  }
}

/**
 * Reads the PID of a spawned child.
 *
 * @param child - a child whose `spawn` event has fired, as {@link ownChild} awaits
 * @returns the child's PID
 * @throws Error when the child has no PID (it failed to spawn)
 */
function pidOf(child: ChildProcess): number {
  if (child.pid === undefined) throw new Error('child has no pid')
  return child.pid
}

/**
 * Finds a loopback port with nothing listening on it.
 *
 * @returns a port number that was free when its probe server closed
 */
async function closedPort(): Promise<number> {
  const server = createServer()
  const origin = await listenOnLoopback(server)
  server.close()
  await once(server, 'close')
  return Number(new URL(origin).port)
}

let agentDir: string
let server: Server
let port: number
let responder: Responder
let children: ChildProcess[]

/**
 * Returns the PID file path `process.ts` reads, inside the temp agent dir.
 *
 * @returns `<agentDir>/proxy.pid`
 */
function pidPath(): string {
  return join(agentDir, 'proxy.pid')
}

/**
 * Builds an extension state whose config points the probe at a loopback port.
 *
 * @param probePort - the port the probe connects to on 127.0.0.1
 * @param authToken - the proxy auth token the probe sends; empty (none) when omitted
 * @returns a state with no session process and no model registry
 */
function stateOn(probePort: number, authToken = ''): ProxyState {
  return {
    config: { ...DEFAULT_CONFIG, host: '127.0.0.1', port: probePort, authToken },
    sessionProcess: undefined,
    modelRegistry: undefined,
    settingsManager: SettingsManager.inMemory({}),
    packageRoot: agentDir
  }
}

/**
 * Starts a child that idles on an open stdin until signalled (the only kind of process these
 * tests stop), and remembers it for cleanup.
 *
 * @returns the child, once its `spawn` event has fired
 */
async function ownChild(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], {
    stdio: ['pipe', 'ignore', 'ignore']
  })
  await once(child, 'spawn')
  children.push(child)
  return child
}

/**
 * Makes `process.kill` answer EPERM for IMPOSSIBLE_PID, as it does for a live process of another
 * user, whatever the signal; any other pid is signalled for real. `afterEach` restores it.
 */
function answerEpermForImpossiblePid(): void {
  const realKill = process.kill.bind(process)
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid === IMPOSSIBLE_PID) throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
    return realKill(pid, signal)
  })
}

beforeAll(async () => {
  server = createServer((request, response) => {
    responder(request, response)
  })
  port = Number(new URL(await listenOnLoopback(server)).port)
})

afterAll(async () => {
  server.close()
  await once(server, 'close')
})

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), 'pi-proxy-process-'))
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDir)
  responder = healthy(2)
  children = []
})

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await once(child, 'exit')
    }
  }
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(agentDir, { recursive: true, force: true })
})

describe('showStatus', () => {
  // Catches `/proxy status` claiming a proxy runs, or crashing, when nothing answers and no PID
  // file exists.
  test('no server and no PID file: tells the user to start it', async () => {
    const { context, notifications, statuses } = fakeCommandContext({})
    await showStatus(stateOn(await closedPort()), context)
    expect(notifications).toEqual([
      { message: 'Proxy not running. Use /proxy start', level: 'info' }
    ])
    expect(statuses).toEqual([{ key: STATUS_KEY, text: undefined }])
  })

  // Catches the model count or the PID of a live proxy going missing from `/proxy status`.
  test('healthy proxy with a live PID: shows models and pid', async () => {
    const child = await ownChild()
    writeFileSync(pidPath(), `${String(pidOf(child))}\n`)
    const { context, notifications, statuses } = fakeCommandContext({})
    await showStatus(stateOn(port), context)
    expect(notifications).toEqual([
      {
        message: `http://127.0.0.1:${String(port)} -- 2 models available [pid ${String(pidOf(child))}]`,
        level: 'info'
      }
    ])
    expect(statuses).toEqual([
      { key: STATUS_KEY, text: `proxy: http://127.0.0.1:${String(port)} (2 models)` }
    ])
    expect(existsSync(pidPath())).toBe(true)
  })

  // Catches a garbage PID file being shown as a pid, or being deleted as if it were stale.
  test('garbage PID file: no pid shown, file left alone', async () => {
    writeFileSync(pidPath(), 'not-a-pid')
    const { context, notifications } = fakeCommandContext({})
    await showStatus(stateOn(port), context)
    expect(notifications).toEqual([
      { message: `http://127.0.0.1:${String(port)} -- 2 models available`, level: 'info' }
    ])
    expect(existsSync(pidPath())).toBe(true)
  })

  // Catches a PID file naming a dead process being shown, or left behind for the next start to
  // kill.
  test('stale PID file: no pid shown, file removed', async () => {
    writeFileSync(pidPath(), String(IMPOSSIBLE_PID))
    const { context, notifications } = fakeCommandContext({})
    await showStatus(stateOn(port), context)
    expect(notifications).toEqual([
      { message: `http://127.0.0.1:${String(port)} -- 2 models available`, level: 'info' }
    ])
    expect(existsSync(pidPath())).toBe(false)
  })

  // Catches another user's live proxy (kill(pid, 0) answers EPERM) being read as stale, which
  // deleted its PID file so `/proxy stop` and `status` lost track of it (#93).
  test("another user's process (EPERM): pid shown, file kept", async () => {
    writeFileSync(pidPath(), String(IMPOSSIBLE_PID))
    answerEpermForImpossiblePid()
    const { context, notifications } = fakeCommandContext({})
    await showStatus(stateOn(port), context)
    expect(notifications).toEqual([
      {
        message: `http://127.0.0.1:${String(port)} -- 2 models available [pid ${String(IMPOSSIBLE_PID)}]`,
        level: 'info'
      }
    ])
    expect(existsSync(pidPath())).toBe(true)
  })

  // Catches an unreadable PID file (a directory there) crashing `/proxy status`.
  test('unreadable PID file: treated as no pid', async () => {
    mkdirSync(pidPath())
    const { context, notifications } = fakeCommandContext({})
    await showStatus(stateOn(port), context)
    expect(notifications).toEqual([
      { message: `http://127.0.0.1:${String(port)} -- 2 models available`, level: 'info' }
    ])
  })
})

describe('refreshStatus', () => {
  // Catches a proxy with auth on looking down because the probe drops its bearer token.
  test('auth token: probe sends it and sees the proxy', async () => {
    const seen: (string | undefined)[] = []
    responder = (request, response) => {
      seen.push(request.headers.authorization)
      if (request.headers.authorization === 'Bearer s3cret') {
        healthy(1)(request, response)
      } else {
        response.writeHead(HTTP_UNAUTHORIZED)
        response.end()
      }
    }
    const { context, statuses } = fakeCommandContext({})
    await refreshStatus(stateOn(port, 's3cret'), context)
    expect(seen).toEqual(['Bearer s3cret'])
    expect(statuses).toEqual([
      { key: STATUS_KEY, text: `proxy: http://127.0.0.1:${String(port)} (1 models)` }
    ])
  })

  // Catches an empty auth token being sent as `Bearer ` to a proxy with auth off.
  test('no auth token: probe sends no authorization header', async () => {
    const seen: (string | undefined)[] = []
    responder = (request, response) => {
      seen.push(request.headers.authorization)
      healthy(0)(request, response)
    }
    const { context } = fakeCommandContext({})
    await refreshStatus(stateOn(port), context)
    expect(seen).toEqual([undefined])
  })

  // Catches an HTTP error answer (wrong token) showing the proxy as up in the status bar.
  test('HTTP error: status bar cleared', async () => {
    responder = (_request, response) => {
      response.writeHead(HTTP_UNAUTHORIZED)
      response.end()
    }
    const { context, statuses } = fakeCommandContext({})
    await refreshStatus(stateOn(port, 'wrong'), context)
    expect(statuses).toEqual([{ key: STATUS_KEY, text: undefined }])
  })

  // Catches a server that answers with no model list crashing the probe instead of showing 0
  // models.
  test('body without a data array: reachable with 0 models', async () => {
    responder = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ hello: 'world' }))
    }
    const { context, statuses } = fakeCommandContext({})
    await refreshStatus(stateOn(port), context)
    expect(statuses).toEqual([
      { key: STATUS_KEY, text: `proxy: http://127.0.0.1:${String(port)} (0 models)` }
    ])
  })
})

describe('stopProxy', () => {
  // Catches `/proxy stop` not signalling the session-tied proxy it spawned.
  test('session proxy: SIGTERMs it and clears the status', async () => {
    const child = await ownChild()
    const state = stateOn(await closedPort())
    state.sessionProcess = child
    const exited = once(child, 'exit')
    const { context, notifications, statuses } = fakeCommandContext({})
    await stopProxy(state, context)
    expect(await exited).toEqual([null, 'SIGTERM'])
    expect(state.sessionProcess).toBeUndefined()
    expect(notifications).toEqual([{ message: 'Session proxy stopped', level: 'info' }])
    expect(statuses).toEqual([{ key: STATUS_KEY, text: undefined }])
  })

  // Catches `/proxy stop` reporting a session proxy stopped when no signal was delivered because it
  // had already exited (#111).
  test('session proxy that already exited: says so', async () => {
    const child = await ownChild()
    child.kill('SIGKILL')
    await once(child, 'exit')
    const state = stateOn(await closedPort())
    state.sessionProcess = child
    const { context, notifications, statuses } = fakeCommandContext({})

    await stopProxy(state, context)

    expect({ sessionProcess: state.sessionProcess, notifications, statuses }).toEqual({
      sessionProcess: undefined,
      notifications: [{ message: 'Session proxy had already exited', level: 'info' }],
      statuses: [{ key: STATUS_KEY, text: undefined }]
    })
  })

  // Catches `/proxy stop` leaving a detached proxy running or its PID file behind.
  test('detached proxy from the PID file: SIGTERMs it and removes the file', async () => {
    const child = await ownChild()
    writeFileSync(pidPath(), String(pidOf(child)))
    const exited = once(child, 'exit')
    const { context, notifications, statuses } = fakeCommandContext({})
    await stopProxy(stateOn(port), context)
    expect(await exited).toEqual([null, 'SIGTERM'])
    expect(existsSync(pidPath())).toBe(false)
    expect(notifications).toEqual([
      { message: `Proxy stopped (pid ${String(pidOf(child))})`, level: 'info' }
    ])
    expect(statuses).toEqual([{ key: STATUS_KEY, text: undefined }])
  })

  // Catches `/proxy stop` claiming success on a proxy it did not start and cannot stop.
  test('stale PID file and a foreign proxy answering: says to stop it manually', async () => {
    writeFileSync(pidPath(), String(IMPOSSIBLE_PID))
    const { context, notifications, statuses } = fakeCommandContext({})
    await stopProxy(stateOn(port), context)
    expect(existsSync(pidPath())).toBe(false)
    expect(notifications).toEqual([
      {
        message: `Proxy at http://127.0.0.1:${String(port)} was not started by /proxy -- stop it manually`,
        level: 'info'
      }
    ])
    expect(statuses).toEqual([])
  })

  // Catches `/proxy stop` with nothing running erroring or leaving a stale status in the bar.
  test('nothing running: says so and clears the status', async () => {
    const { context, notifications, statuses } = fakeCommandContext({})
    await stopProxy(stateOn(await closedPort()), context)
    expect(notifications).toEqual([{ message: 'Proxy is not running', level: 'info' }])
    expect(statuses).toEqual([{ key: STATUS_KEY, text: undefined }])
  })

  // Catches `/proxy stop` deleting the PID file of another user's live proxy (SIGTERM answers
  // EPERM) and then saying it was not started by /proxy, so status and stop lose it (#93).
  test("another user's proxy (EPERM) answering: says so, keeps the PID file", async () => {
    writeFileSync(pidPath(), String(IMPOSSIBLE_PID))
    answerEpermForImpossiblePid()
    const { context, notifications, statuses } = fakeCommandContext({})
    await stopProxy(stateOn(port), context)
    expect(existsSync(pidPath())).toBe(true)
    expect(notifications).toEqual([
      {
        message: `Proxy at http://127.0.0.1:${String(port)} runs as another user (pid ${String(IMPOSSIBLE_PID)}) -- stop it as that user`,
        level: 'warning'
      }
    ])
    expect(statuses).toEqual([])
  })

  // Catches an EPERM pid with no proxy answering (a PID recycled by another user's process) being
  // kept forever: it is stale, like a missing process.
  test('EPERM pid and nothing answering: treated as stale', async () => {
    writeFileSync(pidPath(), String(IMPOSSIBLE_PID))
    answerEpermForImpossiblePid()
    const { context, notifications } = fakeCommandContext({})
    await stopProxy(stateOn(await closedPort()), context)
    expect(existsSync(pidPath())).toBe(false)
    expect(notifications).toEqual([{ message: 'Proxy is not running', level: 'info' }])
  })
})

describe('killStalePid', () => {
  // Catches a PID file naming a dead process surviving into the next start. `readPid` finds it
  // gone and removes the file, so there is nothing to signal and nothing to warn about.
  test('PID file of a dead process: removed, nothing signalled', async () => {
    writeFileSync(pidPath(), String(IMPOSSIBLE_PID))
    const { context, notifications } = fakeCommandContext({})
    await killStalePid(context)
    expect(existsSync(pidPath())).toBe(false)
    expect(notifications).toEqual([])
  })

  // Catches a leftover proxy of this user surviving into the next start (two would then fight over
  // the port): it is signalled, and the file goes.
  test("this user's leftover process: SIGTERMed, file removed", async () => {
    const child = await ownChild()
    writeFileSync(pidPath(), String(pidOf(child)))
    const exited = once(child, 'exit')
    const { context, notifications } = fakeCommandContext({})
    await killStalePid(context)
    expect(await exited).toEqual([null, 'SIGTERM'])
    expect(existsSync(pidPath())).toBe(false)
    expect(notifications).toEqual([
      { message: `Stale proxy process ${String(pidOf(child))} -- killing`, level: 'warning' }
    ])
  })

  // Catches a start blocked forever by another user's process (EPERM), or the user told it was
  // killed when it could not be: the file is replaced and the message says why (#93).
  test("another user's process (EPERM): file replaced, not claimed killed", async () => {
    writeFileSync(pidPath(), String(IMPOSSIBLE_PID))
    answerEpermForImpossiblePid()
    const { context, notifications } = fakeCommandContext({})
    await killStalePid(context)
    expect(existsSync(pidPath())).toBe(false)
    expect(notifications).toEqual([
      {
        message: `PID file named process ${String(IMPOSSIBLE_PID)}, which belongs to another user and is not answering -- starting a new proxy`,
        level: 'warning'
      }
    ])
  })

  // Catches the user told a stale process is being killed when it exited between reading the PID
  // file and the signal (#111): there was nothing to kill, so nothing to say; the file still goes.
  test('process gone by the time it is signalled: file removed, nothing claimed', async () => {
    writeFileSync(pidPath(), String(IMPOSSIBLE_PID))
    // Alive when readPid checks (signal 0), gone when SIGTERM is sent.
    vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 0) return true
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
    })
    const { context, notifications } = fakeCommandContext({})

    await killStalePid(context)

    expect({ fileKept: existsSync(pidPath()), notifications }).toEqual({
      fileKept: false,
      notifications: []
    })
  })
})

describe('startProxy', () => {
  // Catches `/proxy start` spawning a proxy that refuses to start: its output is discarded, so the
  // user would only hear that it never answered. The refusal names the cause and comes before
  // anything is touched (the stale PID file stays, no "starting" status).
  test.each([
    {
      label: 'a non-string authToken in the file',
      authToken: 12345,
      inherited: undefined,
      message:
        'Proxy not started: authToken in proxy-config.json is not a string, and the proxy refuses to start with it. Set a new token in /proxy config.'
    },
    {
      label: "an empty PI_PROXY_AUTH_TOKEN in pi's environment",
      authToken: '',
      inherited: '',
      message:
        "Proxy not started: PI_PROXY_AUTH_TOKEN is set but empty in pi's environment, and the proxy refuses to start with an empty token. Unset it, or set a token in /proxy config."
    }
  ])(
    '$label: refused with the reason, nothing spawned',
    async ({ authToken, inherited, message }) => {
      const freePort = await closedPort()
      writeFileSync(
        join(agentDir, 'proxy-config.json'),
        JSON.stringify({ host: '127.0.0.1', port: freePort, authToken })
      )
      vi.stubEnv('PI_PROXY_AUTH_TOKEN', inherited)
      writeFileSync(pidPath(), String(IMPOSSIBLE_PID))
      const { context, notifications, statuses } = fakeCommandContext({})

      await startProxy(stateOn(freePort), context)

      expect({ notifications, statuses, pidFileKept: existsSync(pidPath()) }).toEqual({
        notifications: [{ message, level: 'error' }],
        statuses: [],
        pidFileKept: true
      })
    }
  )
})
