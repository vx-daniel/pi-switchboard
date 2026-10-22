/**
 * The compiled standalone binary (`dist-bin/pi-switchboard`, built by `scripts/build-binary.ts`),
 * run as a real process. Bun is not the runtime the other suites run on, so these are the only
 * checks that the shipped bytes work. Run with `pnpm run test:binary`, which builds first.
 *
 * Offline like the rest: the binary gets a fixture agent dir, the local mock provider, and an
 * environment with no credentials. The one request that would leave the machine, an OAuth token
 * refresh, is sent through a local HTTPS proxy that records the CONNECT and drops it.
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'
import {
  finishChunk,
  type MockProvider,
  sse,
  startMockProvider,
  textChunks
} from '../fixtures/mock-provider'

const BINARY = resolve('dist-bin/pi-switchboard')
const READY_TIMEOUT_MS = 5000
const READY_POLL_MS = 50

/** An expired subscription login: verifying it makes pi refresh the token. */
const EXPIRED_ANTHROPIC_LOGIN = {
  anthropic: {
    type: 'oauth',
    refresh: 'notarealsecret-refresh',
    access: 'notarealsecret-access',
    expires: 0
  }
}

interface RunningBinary {
  readonly url: string
  readonly output: () => string
}

let mock: MockProvider
let agentDir: FixtureAgentDir
let httpsProxy: Server
const proxyConnects: string[] = []
const children: ChildProcess[] = []
/** Temporary home directories, removed after each test once its binary has exited. */
const homes: string[] = []

/**
 * A fresh temporary directory for the binary's home, removed after the test.
 *
 * @returns its path
 */
function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'pi-proxy-binary-home-'))
  homes.push(home)
  return home
}

/**
 * The TCP port a listening server got.
 *
 * @param server - a listening server
 * @returns its port
 */
function portOf(server: { address(): ReturnType<Server['address']> }): number {
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('server is not on TCP')
  return address.port
}

/**
 * A free local port, for the binary to listen on.
 *
 * @returns a port nothing listened on a moment ago
 */
async function freePort(): Promise<number> {
  const server = createNetServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = portOf(server)
  server.close()
  await once(server, 'close')
  return port
}

/**
 * Starts the binary with only these variables, and waits until `/healthz` answers.
 *
 * @param env - the binary's whole environment
 * @param cwd - the directory it starts in
 * @returns the running binary
 */
async function startBinary(env: Record<string, string>, cwd = tmpdir()): Promise<RunningBinary> {
  const port = await freePort()
  const child = spawn(BINARY, ['--port', String(port)], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  children.push(child)
  let output = ''
  child.stdout.on('data', (data: Buffer) => (output += data.toString()))
  child.stderr.on('data', (data: Buffer) => (output += data.toString()))
  const running: RunningBinary = {
    url: `http://127.0.0.1:${String(port)}`,
    output: () => output
  }
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${running.url}/healthz`)).ok) return running
    } catch {
      // Not listening yet.
    }
    await sleep(READY_POLL_MS)
  }
  throw new Error(
    `binary did not answer /healthz within ${String(READY_TIMEOUT_MS)} ms:\n${output}`
  )
}

/**
 * The environment a binary gets: the fixture agent dir and nothing inherited, so no credentials
 * and no `PATH` (the proxy runs no commands).
 *
 * @param home - the fixture agent dir
 * @returns the variables to start the binary with
 */
function baseEnv(home: string): Record<string, string> {
  return {
    HOME: home,
    PI_CODING_AGENT_DIR: agentDir.path,
    PI_SWITCHBOARD_LOG_FORMAT: 'json'
  }
}

beforeAll(async () => {
  if (!existsSync(BINARY)) {
    throw new Error(`${BINARY} is missing: run \`pnpm run test:binary\`, which builds it first`)
  }
  mock = await startMockProvider({
    echo: sse([...textChunks('compiled', ' hello'), finishChunk('stop')])
  })
  agentDir = await loadFixtureAgentDir({
    modelsJson: { providers: { 'binary-mock': mock.provider() } },
    authJson: EXPIRED_ANTHROPIC_LOGIN
  })
  httpsProxy = createServer((_request, response) => {
    response.writeHead(502)
    response.end()
  })
  httpsProxy.on('connect', (request, socket) => {
    proxyConnects.push(request.url ?? '')
    socket.destroy()
  })
  httpsProxy.listen(0, '127.0.0.1')
  await once(httpsProxy, 'listening')
})

afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return
      const exited = once(child, 'exit')
      child.kill()
      await exited
    })
  )
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

afterAll(async () => {
  agentDir.remove()
  await mock.close()
  httpsProxy.close()
})

describe('standalone binary', () => {
  // Catches a binary that starts but cannot answer: the bundle missing pi's provider code, or the
  // proxy's own routes.
  test('answers a chat completion from a fixture provider', async () => {
    const binary = await startBinary(baseEnv(tempHome()))
    const response = await fetch(`${binary.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'binary-mock/echo',
        messages: [{ role: 'user', content: 'hi' }]
      })
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      choices: [{ message: { role: 'assistant', content: 'compiled hello' } }]
    })
  })

  // Catches the OAuth flows left out of the bundle (pi-ai loads them by a variable specifier): the
  // binary would then serve until a token expired and fail every request after. A refresh that
  // reaches the network, here the recording proxy, proves the flow was loaded.
  test('refreshes an expired OAuth login with the flow embedded', async () => {
    const binary = await startBinary({
      ...baseEnv(tempHome()),
      HTTPS_PROXY: `http://127.0.0.1:${String(portOf(httpsProxy))}`,
      NO_PROXY: '127.0.0.1,localhost'
    })
    const response = await fetch(`${binary.url}/healthz/creds?verify=true`)
    const body = await response.text()
    expect(body).toContain('"provider":"anthropic"')
    expect(body).not.toContain('Cannot find module')
    expect(proxyConnects).toContain('platform.claude.com:443')
  })

  // Catches the compile flags dropped: a compiled Bun binary otherwise reads `.env` from the
  // directory it starts in, and a stray one could turn proxy auth on, off, or to a known token.
  // Auth staying off shows it: no token and a wrong token are both let through.
  test('ignores a .env in its working directory', async () => {
    const home = tempHome()
    writeFileSync(join(home, '.env'), 'PI_SWITCHBOARD_AUTH_TOKEN=from-dotenv\n')
    const binary = await startBinary(baseEnv(home), home)
    expect((await fetch(`${binary.url}/v1/models`)).status).toBe(200)
    const wrongToken = await fetch(`${binary.url}/v1/models`, {
      headers: { Authorization: 'Bearer not-the-token' }
    })
    expect(wrongToken.status).toBe(200)
  })

  // Catches `--no-compile-autoload-bunfig` dropped: a compiled Bun binary otherwise reads
  // `bunfig.toml` from the directory it starts in, and its `preload` runs code in the proxy's
  // process. This preload leaves a marker file and turns proxy auth on; neither may happen.
  test('ignores a bunfig.toml in its working directory', async () => {
    const home = tempHome()
    const marker = join(home, 'preload-ran')
    writeFileSync(
      join(home, 'preload.js'),
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')\n` +
        "process.env.PI_SWITCHBOARD_AUTH_TOKEN = 'from-bunfig'\n"
    )
    writeFileSync(join(home, 'bunfig.toml'), 'preload = ["./preload.js"]\n')
    const binary = await startBinary(baseEnv(home), home)
    expect((await fetch(`${binary.url}/v1/models`)).status).toBe(200)
    expect(existsSync(marker)).toBe(false)
  })
})
