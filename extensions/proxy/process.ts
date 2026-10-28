/**
 * Proxy process management: PID file, reachability probe, start/stop/status.
 *
 * @packageDocumentation
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { type ExtensionContext, getAgentDir } from '@earendil-works/pi-coding-agent'
import {
  configFileAuthTokenInvalid,
  configFileProblem,
  configToEnv,
  describeConfigFileProblem,
  loadConfigFromFile,
  parseIntText,
  type ProxyConfig
} from '@vx-daniel/pi-switchboard/config'
import { proxyLogger } from '@vx-daniel/pi-switchboard/logging'
import * as z from 'zod'

import { type ProxyState, proxyUrl } from './state'

/** What the PID file holds: one process ID, a positive integer. */
const PidSchema = z.int().min(1)
/** Abort a reachability probe after this long. */
const PROBE_TIMEOUT_MS = 2000
/** How long `/proxy start` waits for a freshly spawned proxy to answer. */
const READY_TIMEOUT_MS = 3000
/** Poll interval while waiting for a spawned proxy to answer. */
const READY_POLL_INTERVAL_MS = 300
/** Pause after killing a proxy so its port is released before the next start. */
const PROCESS_SETTLE_DELAY_MS = 500

/** Logger for proxy process start, stop and status. */
const processLogger = proxyLogger('extension', 'process')

/** What a reachability probe found: whether the proxy answered, and its model count. */
interface RuntimeStatus {
  reachable: boolean
  models: number
}

/** What the probe needs from `GET /v1/models`: the model count. */
const ProbeBodySchema = z.object({ data: z.array(z.unknown()) })

/**
 * Resolves the proxy entry point: the built `dist/index.mjs` this package ships beside the
 * extension, or failing that the package's `pi-switchboard` bin on PATH.
 *
 * @param packageRoot - the package root holding `dist/`
 * @returns the absolute path of the built entry, or the bare bin name
 */
function findProxyBinary(packageRoot: string): string {
  const localBin = resolve(packageRoot, 'dist', 'index.mjs')
  if (existsSync(localBin)) {
    processLogger.debug('Resolved proxy binary to built entry {bin}', { bin: localBin })
    return localBin
  }
  processLogger.debug('No built entry at {localBin}; using {bin} from PATH', {
    localBin,
    bin: 'pi-switchboard'
  })
  return 'pi-switchboard'
}

/**
 * Builds the spawn command for a proxy entry point. A built entry runs on the runtime hosting pi
 * (Node); anything else is an executable on PATH.
 *
 * @param bin - the entry point from {@link findProxyBinary}
 * @returns the command and its arguments
 */
function proxyCommand(bin: string): { command: string; args: string[] } {
  return bin.endsWith('.mjs')
    ? { command: process.execPath, args: [bin] }
    : { command: bin, args: [] }
}

// --- PID file ---

/**
 * Returns the PID file path: `proxy.pid` in pi's agent dir, beside the config file.
 *
 * @remarks
 * The directory is pi's {@link getAgentDir}, as for the config file. Reading `HOME` directly made a
 * relative `./~/.pi/agent` when it was unset (#111).
 *
 * @returns the absolute PID file path
 */
export function getPidPath(): string {
  return resolve(getAgentDir(), 'proxy.pid')
}

/**
 * Checks for the EPERM `process.kill` throws for a live process of another user (#93).
 *
 * @param error - the caught error
 * @returns whether `error` is an EPERM error
 */
function isPermissionDenied(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EPERM'
}

/**
 * Reads the PID file and checks that the process it names exists.
 *
 * @remarks
 * A missing process (ESRCH) makes the file stale, so it is removed. A process of another user
 * (EPERM) still counts as live (#93).
 *
 * @returns the PID, or undefined when there is no file, its content is not a PID, the process is
 *   gone, or the file cannot be read
 */
function readPid(): number | undefined {
  const pidPath = getPidPath()
  if (!existsSync(pidPath)) {
    processLogger.debug('No PID file at {pidPath}', { pidPath })
    return undefined
  }
  try {
    const pid = parseIntText(readFileSync(pidPath, 'utf-8'), PidSchema)
    if (pid === undefined) {
      processLogger.warn('Ignoring PID file {pidPath}: content is not a valid PID', { pidPath })
      return undefined
    }
    try {
      process.kill(pid, 0)
      processLogger.debug('PID file {pidPath} names live process {pid}', { pidPath, pid })
      return pid
    } catch (error: unknown) {
      // EPERM: the process exists but belongs to another user (a proxy started with sudo, say). Only
      // a missing process (ESRCH) makes the file stale (#93).
      if (isPermissionDenied(error)) {
        processLogger.debug(
          'PID file {pidPath} names process {pid}, which this user cannot signal',
          {
            pidPath,
            pid
          }
        )
        return pid
      }
      processLogger.info('Removing stale PID file {pidPath}: process {pid} is not running', {
        pidPath,
        pid
      })
      unlinkSync(pidPath)
      return undefined
    }
  } catch (error: unknown) {
    processLogger.warn('Could not read PID file {pidPath}; treating as no PID', { pidPath, error })
    return undefined
  }
}

/**
 * Writes `pid` to the PID file, creating its directory.
 *
 * @param pid - the spawned proxy's PID
 */
function writePid(pid: number): void {
  const pidPath = getPidPath()
  mkdirSync(dirname(pidPath), { recursive: true })
  writeFileSync(pidPath, String(pid), 'utf-8')
  processLogger.debug('Wrote PID {pid} to {pidPath}', { pid, pidPath })
}

/** Removes the PID file if it exists; a failed removal is logged and ignored. */
function removePid(): void {
  const pidPath = getPidPath()
  if (existsSync(pidPath)) {
    try {
      unlinkSync(pidPath)
      processLogger.debug('Removed PID file {pidPath}', { pidPath })
    } catch (error: unknown) {
      processLogger.warn('Could not remove PID file {pidPath}; ignoring', { pidPath, error })
    }
  }
}

// --- Reachability ---

/**
 * Probes `GET /v1/models` with the configured auth token, giving up after
 * {@link PROBE_TIMEOUT_MS}.
 *
 * @param state - the extension state; its config supplies the URL and token
 * @returns reachable with the model count on HTTP 2xx (count 0 for a JSON body without a `data`
 *   array), otherwise unreachable with 0 models; a 2xx body that is not JSON counts as unreachable
 */
async function probe(state: ProxyState): Promise<RuntimeStatus> {
  const url = `${proxyUrl(state.config)}/v1/models`
  try {
    const headers: Record<string, string> = {}
    if (state.config.authToken.length > 0) {
      headers['authorization'] = `Bearer ${state.config.authToken}`
    }
    const response = await fetch(url, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers
    })
    if (response.ok) {
      const body = ProbeBodySchema.safeParse(await response.json())
      let modelCount = 0
      if (body.success) {
        modelCount = body.data.data.length
      } else {
        processLogger.warn('Probe of {url} returned a body without a data array', { url })
      }
      processLogger.debug('Probe of {url}: reachable with {modelCount} models', { url, modelCount })
      return { reachable: true, models: modelCount }
    }
    processLogger.debug('Probe of {url}: not reachable (HTTP {status})', {
      url,
      status: response.status
    })
  } catch (error: unknown) {
    processLogger.debug('Probe of {url}: not reachable', { url, error })
  }
  return { reachable: false, models: 0 }
}

/**
 * Probes until the proxy answers or `timeoutMs` passes, every {@link READY_POLL_INTERVAL_MS}.
 *
 * @param state - the extension state
 * @param timeoutMs - how long to keep probing, in milliseconds
 * @returns the first reachable status, or unreachable with 0 models
 */
async function waitForReady(state: ProxyState, timeoutMs: number): Promise<RuntimeStatus> {
  const start = Date.now()
  let attempts = 0
  while (Date.now() - start < timeoutMs) {
    attempts += 1
    const status = await probe(state)
    if (status.reachable) {
      processLogger.debug(
        'Proxy ready after {attempts} probe(s) in {durationMs} ms with {modelCount} models',
        { attempts, durationMs: Date.now() - start, modelCount: status.models }
      )
      return status
    }
    await sleep(READY_POLL_INTERVAL_MS)
  }
  processLogger.debug('Proxy not ready after {attempts} probe(s) in {durationMs} ms', {
    attempts,
    durationMs: Date.now() - start
  })
  return { reachable: false, models: 0 }
}

/**
 * Probes the proxy and sets pi's `proxy` status line: URL and model count, or cleared when the
 * proxy does not answer.
 *
 * @param state - the extension state
 * @param context - the extension context, used for the status line
 */
export async function refreshStatus(state: ProxyState, context: ExtensionContext): Promise<void> {
  const status = await probe(state)
  if (status.reachable) {
    context.ui.setStatus(
      'proxy',
      `proxy: ${proxyUrl(state.config)} (${String(status.models)} models)`
    )
  } else {
    context.ui.setStatus('proxy', undefined)
  }
}

// --- Start ---

/**
 * Spawns a detached proxy that outlives the pi session and records its PID.
 *
 * @param bin - the entry point from {@link findProxyBinary}
 * @param env - the config as environment variables, added to pi's environment
 * @throws Error when spawn returns no PID
 */
function startDetached(bin: string, env: Record<string, string>): void {
  const { command, args } = proxyCommand(bin)

  const child = spawn(command, args, {
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true,
    env: { ...process.env, ...env }
  })

  child.once('error', (error) => {
    processLogger.error('Detached proxy process {command} failed: {message}', {
      command,
      message: error.message,
      error
    })
    if (child.pid !== undefined) removePid()
  })

  if (child.pid === undefined) {
    throw new Error('No PID returned from spawn')
  }

  child.unref()
  processLogger.info('Spawned proxy {pid} with lifetime {lifetime}', {
    pid: child.pid,
    lifetime: 'detached',
    command
  })
  writePid(child.pid)
}

/**
 * Spawns a proxy tied to the pi session, unless one is already running.
 *
 * @remarks
 * No PID file is written; the child is kept in `state.sessionProcess`, cleared when it exits or
 * fails, and stopped at session shutdown by {@link stopSessionProcess}.
 *
 * @param state - the extension state that holds the session process
 * @param context - the extension context, used for notifications and the status line
 * @param bin - the entry point from {@link findProxyBinary}
 * @param env - the config as environment variables, added to pi's environment
 */
function startSessionTied(
  state: ProxyState,
  context: ExtensionContext,
  bin: string,
  env: Record<string, string>
): void {
  if (state.sessionProcess !== undefined) {
    processLogger.debug('Session proxy {pid} already running; not spawning another', {
      pid: state.sessionProcess.pid
    })
    context.ui.notify('Session proxy already running', 'info')
    return
  }

  const { command, args } = proxyCommand(bin)

  const child = spawn(command, args, {
    // Discard the proxy's output. A pipe nobody reads fills after ~64 KiB, and Node then queues
    // every later stderr write in the proxy's memory, without limit, for as long as it runs.
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: false,
    env: { ...process.env, ...env }
  })
  state.sessionProcess = child
  processLogger.info('Spawned proxy {pid} with lifetime {lifetime}', {
    pid: child.pid,
    lifetime: 'session',
    command
  })
  processLogger.debug("Session proxy {pid}: the proxy's own stdout/stderr are discarded", {
    pid: child.pid
  })

  child.on('exit', (code, signal) => {
    state.sessionProcess = undefined
    if (code !== null && code !== 0) {
      processLogger.warn('Session proxy {pid} exited with code {code}', { pid: child.pid, code })
      context.ui.notify(`Proxy exited with code ${String(code)}`, 'warning')
    } else {
      processLogger.info('Session proxy {pid} exited (code {code}, signal {signal})', {
        pid: child.pid,
        code,
        signal
      })
    }
    context.ui.setStatus('proxy', undefined)
  })

  child.on('error', (err) => {
    processLogger.error('Session proxy process {command} failed: {message}', {
      command,
      message: err.message,
      error: err
    })
    state.sessionProcess = undefined
    context.ui.notify(`Proxy error: ${err.message}`, 'error')
    context.ui.setStatus('proxy', undefined)
  })
}

/** How sending SIGTERM to a process went: delivered, already gone, or it belongs to another user. */
type SignalOutcome = 'signalled' | 'gone' | 'foreign'

/**
 * Sends SIGTERM to `pid` and says how it went; EPERM means another user's process (#93).
 *
 * @param pid - the process to signal
 * @returns `signalled`, `foreign` on EPERM, or `gone` on any other error
 */
function terminate(pid: number): SignalOutcome {
  try {
    process.kill(pid, 'SIGTERM')
    return 'signalled'
  } catch (error: unknown) {
    if (isPermissionDenied(error)) return 'foreign'
    processLogger.debug('Process {pid} already exited', { pid, error })
    return 'gone'
  }
}

/**
 * Clears a PID file left behind before starting.
 *
 * @remarks
 * `startProxy` calls this only when no proxy answers, so a process the file names is stale: it is
 * sent SIGTERM, and the file goes. Another user's process cannot be signalled (a recycled PID, or
 * a proxy this user cannot stop); the file is still removed so a start is never blocked, and the
 * user is told it was not killed (#93). A process that exits between reading the file and the
 * signal needs no message: there was nothing left to kill (#111).
 *
 * @param context - the extension context, used for the warning
 */
export async function killStalePid(context: ExtensionContext): Promise<void> {
  const existingPid = readPid()
  if (existingPid === undefined) return
  const outcome = terminate(existingPid)
  if (outcome === 'foreign') {
    processLogger.warn(
      'PID file names process {pid} of another user, which is not answering; replacing the file',
      {
        pid: existingPid
      }
    )
    context.ui.notify(
      `PID file named process ${String(existingPid)}, which belongs to another user and is not answering -- starting a new proxy`,
      'warning'
    )
  } else if (outcome === 'signalled') {
    processLogger.warn('Killed stale proxy process {pid} before starting', { pid: existingPid })
    context.ui.notify(`Stale proxy process ${String(existingPid)} -- killing`, 'warning')
  } else {
    processLogger.debug('Process {pid} in the PID file exited before it could be stopped', {
      pid: existingPid
    })
  }
  removePid()
  await sleep(PROCESS_SETTLE_DELAY_MS)
}

/**
 * Spawns the proxy with the configured lifetime, waits up to {@link READY_TIMEOUT_MS} for it to
 * answer, and notifies the result.
 *
 * @param state - the extension state
 * @param context - the extension context, used for notifications and the status line
 * @throws Error when a detached spawn returns no PID
 */
async function spawnProxy(state: ProxyState, context: ExtensionContext): Promise<void> {
  const proxyEnv = configToEnv(state.config)
  const bin = findProxyBinary(state.packageRoot)
  processLogger.debug('Starting proxy for {url} with lifetime {lifetime}', {
    url: proxyUrl(state.config),
    lifetime: state.config.lifetime
  })

  if (state.config.lifetime === 'detached') {
    startDetached(bin, proxyEnv)
  } else {
    startSessionTied(state, context, bin, proxyEnv)
  }

  const ready = await waitForReady(state, READY_TIMEOUT_MS)
  if (ready.reachable) {
    const mode = state.config.lifetime === 'detached' ? 'background' : 'session'
    processLogger.info('Proxy started at {url} with {modelCount} models', {
      url: proxyUrl(state.config),
      modelCount: ready.models,
      lifetime: state.config.lifetime
    })
    context.ui.notify(
      `Proxy started at ${proxyUrl(state.config)} (${String(ready.models)} models) [${mode}]`,
      'info'
    )
  } else {
    processLogger.warn('Proxy spawned but not reachable at {url} within {timeoutMs} ms', {
      url: proxyUrl(state.config),
      timeoutMs: READY_TIMEOUT_MS
    })
    context.ui.notify(`Proxy spawned but not yet reachable at ${proxyUrl(state.config)}`, 'warning')
  }
  await refreshStatus(state, context)
}

/**
 * Says why a proxy spawned with this config would refuse to start, before it is spawned.
 *
 * @remarks
 * The proxy refuses to start when its auth is set but cannot be applied (`UnusableProxyAuthError`).
 * Its output is discarded, so without this check the reason would be lost and `/proxy start`
 * would only report a proxy that never answered. Mirrors what the child sees: the token
 * {@link configToEnv} passes wins over pi's own `PI_SWITCHBOARD_AUTH_TOKEN`, which the child
 * inherits, and either wins over the file. pi's environment may still hold the old
 * `PI_PROXY_AUTH_TOKEN` (#65): with no new token, the child refuses to start over it.
 *
 * @param config - the config the proxy would be spawned with
 * @returns why it would refuse, or `undefined` when it would start
 */
function startRefusal(config: ProxyConfig): string | undefined {
  const token =
    configToEnv(config)['PI_SWITCHBOARD_AUTH_TOKEN'] ?? process.env.PI_SWITCHBOARD_AUTH_TOKEN
  if (token === '') {
    return "PI_SWITCHBOARD_AUTH_TOKEN is set but empty in pi's environment, and the proxy refuses to start with an empty token. Unset it, or set a token in /proxy config."
  }
  if (token === undefined && process.env['PI_PROXY_AUTH_TOKEN'] !== undefined) {
    return "PI_PROXY_AUTH_TOKEN is set in pi's environment but no longer read, and the proxy refuses to start over it. Rename it PI_SWITCHBOARD_AUTH_TOKEN, or set a token in /proxy config."
  }
  // The config this extension holds came from the defaults when the file could not be used, so
  // its '' says nothing about the token the file may hold; the child refuses over the file.
  const fileProblem = token === undefined ? configFileProblem() : undefined
  if (fileProblem !== undefined) {
    return `proxy-config.json exists but ${describeConfigFileProblem(fileProblem)}, and the proxy refuses to start over it: the file may hold a token. Fix or remove the file, or set PI_SWITCHBOARD_AUTH_TOKEN in pi's environment.`
  }
  if (token === undefined && configFileAuthTokenInvalid()) {
    return 'authToken in proxy-config.json is not a string, and the proxy refuses to start with it. Set a new token in /proxy config.'
  }
  return undefined
}

/**
 * Handles `/proxy start`: reloads the config and starts the proxy unless one already answers.
 *
 * @remarks
 * Refuses, with the reason, a config the proxy would refuse to start with ({@link startRefusal});
 * clears a stale PID file; a failed start is notified, not thrown.
 *
 * @param state - the extension state; its config is replaced by the file's
 * @param context - the extension context, used for notifications and the status line
 */
export async function startProxy(state: ProxyState, context: ExtensionContext): Promise<void> {
  state.config = loadConfigFromFile()

  const status = await probe(state)
  if (status.reachable) {
    processLogger.info('Proxy already running at {url} with {modelCount} models; not starting', {
      url: proxyUrl(state.config),
      modelCount: status.models
    })
    context.ui.notify(
      `Proxy already running at ${proxyUrl(state.config)} (${String(status.models)} models)`,
      'info'
    )
    await refreshStatus(state, context)
    return
  }

  const refusal = startRefusal(state.config)
  if (refusal !== undefined) {
    processLogger.error('Not starting the proxy: {reason}', { reason: refusal })
    context.ui.notify(`Proxy not started: ${refusal}`, 'error')
    return
  }

  await killStalePid(context)

  context.ui.setStatus('proxy', 'proxy: starting...')

  try {
    await spawnProxy(state, context)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    processLogger.error('Failed to start proxy: {message}', { message, error: err })
    context.ui.notify(`Failed to start proxy: ${message}`, 'error')
    context.ui.setStatus('proxy', undefined)
  }
}

// --- Stop / restart / status ---

/**
 * Handles `/proxy stop`: stops the session proxy, or the proxy the PID file names.
 *
 * @remarks
 * A proxy of another user that still answers keeps its PID file and is left running (#93); a
 * proxy this extension did not start is left running with a hint.
 *
 * @param state - the extension state
 * @param context - the extension context, used for notifications and the status line
 */
export async function stopProxy(state: ProxyState, context: ExtensionContext): Promise<void> {
  if (state.sessionProcess !== undefined) {
    const sent = state.sessionProcess.kill('SIGTERM')
    processLogger.info('Stopped session proxy {pid} (signal delivered: {sent})', {
      pid: state.sessionProcess.pid,
      sent
    })
    state.sessionProcess = undefined
    // No signal delivered means the process had already exited (#111).
    context.ui.notify(sent ? 'Session proxy stopped' : 'Session proxy had already exited', 'info')
    context.ui.setStatus('proxy', undefined)
    return
  }

  const pid = readPid()
  const outcome = pid === undefined ? undefined : terminate(pid)
  if (pid !== undefined && outcome === 'signalled') {
    removePid()
    processLogger.info('Stopped proxy {pid}', { pid })
    context.ui.notify(`Proxy stopped (pid ${String(pid)})`, 'info')
    context.ui.setStatus('proxy', undefined)
    return
  }

  const status = await probe(state)
  // Another user's process that answers as the proxy: keep its PID file, it is still running (#93).
  // One that does not answer is a recycled PID, or not this proxy: stale, like a missing process.
  if (pid !== undefined && outcome === 'foreign' && status.reachable) {
    processLogger.info('Proxy {pid} at {url} runs as another user; leaving it and its PID file', {
      pid,
      url: proxyUrl(state.config)
    })
    context.ui.notify(
      `Proxy at ${proxyUrl(state.config)} runs as another user (pid ${String(pid)}) -- stop it as that user`,
      'warning'
    )
    return
  }
  if (pid !== undefined) {
    processLogger.warn('Could not signal proxy {pid}; removing its PID file', { pid, outcome })
    removePid()
  }

  if (status.reachable) {
    processLogger.info('Proxy at {url} was not started by this extension; leaving it running', {
      url: proxyUrl(state.config)
    })
    context.ui.notify(
      `Proxy at ${proxyUrl(state.config)} was not started by /proxy -- stop it manually`,
      'info'
    )
  } else {
    processLogger.debug('Stop requested but no proxy is running')
    context.ui.notify('Proxy is not running', 'info')
    context.ui.setStatus('proxy', undefined)
  }
}

/**
 * Handles `/proxy restart`: stops, waits {@link PROCESS_SETTLE_DELAY_MS}, then starts.
 *
 * @param state - the extension state
 * @param context - the extension context
 */
export async function restartProxy(state: ProxyState, context: ExtensionContext): Promise<void> {
  processLogger.info('Restarting proxy')
  await stopProxy(state, context)
  await sleep(PROCESS_SETTLE_DELAY_MS)
  await startProxy(state, context)
}

/**
 * Handles `/proxy status`: notifies the URL, model count and PID, or that the proxy is not
 * running, and refreshes the status line.
 *
 * @param state - the extension state
 * @param context - the extension context
 */
export async function showStatus(state: ProxyState, context: ExtensionContext): Promise<void> {
  const status = await probe(state)
  const pid = readPid()
  const pidTag = pid === undefined ? '' : ` [pid ${String(pid)}]`
  processLogger.debug('Status: reachable {reachable}, {modelCount} models, pid {pid}', {
    reachable: status.reachable,
    modelCount: status.models,
    pid
  })

  if (status.reachable) {
    context.ui.notify(
      `${proxyUrl(state.config)} -- ${String(status.models)} models available${pidTag}`,
      'info'
    )
  } else {
    context.ui.notify('Proxy not running. Use /proxy start', 'info')
  }
  await refreshStatus(state, context)
}

/**
 * Sends SIGTERM to a session-tied proxy when the pi session ends.
 *
 * @param state - the extension state holding the session process
 */
export function stopSessionProcess(state: ProxyState): void {
  if (state.sessionProcess !== undefined) {
    processLogger.info('Stopping session proxy {pid} at session shutdown', {
      pid: state.sessionProcess.pid
    })
    state.sessionProcess.kill('SIGTERM')
    state.sessionProcess = undefined
  }
}
