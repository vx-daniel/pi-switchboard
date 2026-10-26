/**
 * The console's proxy server (#61, #288): the HTTP server, the config it runs with and its stats
 * recorder, which a restart from the Settings view replaces together.
 *
 * @remarks
 * Stats are recorded from process-wide events, not per server, so exactly one recorder runs at a
 * time: a restart stops the old one as the new server takes over, and requests still finishing on
 * the old server are counted once, by the new one. A new address is bound before the old server
 * closes, so a failed bind leaves the proxy serving where it was. The same address has to be
 * closed before it can be bound again; if binding it then fails, the old config is bound again.
 *
 * @packageDocumentation
 */

import type { ServerType } from '@hono/node-server'
import type { LogLevel } from '@logtape/logtape'
import type { ServerConfig } from '@proxy/config/env'
import { proxyLogger } from '@proxy/logging'
import type { ProxyAuthSwitch } from '@proxy/server/proxy-auth'
import { logEffectiveConfig, openServer } from '@proxy/server/startup'
import { recordStatsToFile } from '@proxy/stats/recorder'
import type { StatsView } from '@proxy/tui/dashboard'
import type { SettingOverrides } from '@proxy/tui/settings-view'
import { errorMessage } from '@proxy/utils/guards'

/** Logger for the server's lifecycle. */
const lifecycleLogger = proxyLogger('server')

/** What a restart did. */
export type RestartOutcome =
  | { readonly kind: 'restarted' }
  /** The new config could not be bound: the proxy still serves the old one, where it was. */
  | { readonly kind: 'kept'; readonly reason: string }

/** What a restart from the console did: as the server reports it, or refused before it began. */
export type RestartReport =
  | RestartOutcome
  /** The saved config can't be used (proxy auth set but unusable); the log says why. */
  | { readonly kind: 'refused' }

/** A server started, or why it could not listen. */
type Opened =
  | { readonly ok: true; readonly server: ServerType }
  | { readonly ok: false; readonly error: unknown }

/** The running proxy, as the console holds it. */
export interface ConsoleServer {
  /**
   * Reads the config the server runs with now.
   *
   * @returns the config
   */
  config(): ServerConfig
  /**
   * Reads the listening server, for its open connections.
   *
   * @returns the server
   */
  server(): ServerType
  /**
   * Replaces the server with one running `next`; requests in flight finish on the old one.
   *
   * @param next - the reloaded config
   * @returns whether the proxy now runs `next`, or still the old config and why
   * @throws Error when the same address, closed to be bound again, can't be bound with either
   *   config: the proxy is not listening, and the console stops
   */
  restart(next: ServerConfig): Promise<RestartOutcome>
  /** Closes the server and stops its stats recorder. */
  close(): void
}

/** What the server is started with: replaced in tests. */
export interface ServerParts {
  /** Starts a server and waits until it listens ({@link openServer}). */
  readonly open: (config: ServerConfig, proxyAuth: ProxyAuthSwitch) => Promise<ServerType>
  /** Starts the stats recorder ({@link recordStatsToFile}); `undefined` when the file won't open. */
  readonly recordStats: () => (() => void) | undefined
}

/** The production parts: the real server and the stats file. */
const REAL_PARTS: ServerParts = { open: openServer, recordStats: recordStatsToFile }

/**
 * Starts the console's server, and its stats recorder when stats are on.
 *
 * @param initial - the resolved config
 * @param proxyAuth - the auth the server applies, which the auth menu changes and a restart resets
 *   to the reloaded config's
 * @param parts - how a server and the recorder start; the real ones by default
 * @returns the running server
 * @throws Error when the server cannot listen, such as `EADDRINUSE`
 */
export async function startConsoleServer(
  initial: ServerConfig,
  proxyAuth: ProxyAuthSwitch,
  parts: ServerParts = REAL_PARTS
): Promise<ConsoleServer> {
  let config = initial
  let server = await parts.open(initial, proxyAuth)
  let stopStats = initial.statsEnabled ? parts.recordStats() : undefined

  /**
   * Makes `opened` the server, running `next`: the recorder moves to it and auth follows `next`.
   *
   * @param opened - the new server, listening
   * @param next - its config
   */
  const takeOver = (opened: ServerType, next: ServerConfig): void => {
    stopStats?.()
    stopStats = next.statsEnabled ? parts.recordStats() : undefined
    server = opened
    config = next
    proxyAuth.set(next.proxyAuth)
  }

  /**
   * Starts a server for `next`, reporting a failure to bind rather than throwing it.
   *
   * @param next - the config to bind
   * @returns the server, or why it could not listen
   */
  const tryOpen = async (next: ServerConfig): Promise<Opened> => {
    try {
      return { ok: true, server: await parts.open(next, proxyAuth) }
    } catch (error) {
      return { ok: false, error }
    }
  }

  /**
   * Restarts on another address: the new server listens before the old one closes.
   *
   * @param next - the reloaded config
   * @returns what the restart did
   */
  const moveTo = async (next: ServerConfig): Promise<RestartOutcome> => {
    const previous = server
    const opened = await tryOpen(next)
    if (!opened.ok) return kept(next, opened.error)
    takeOver(opened.server, next)
    previous.close()
    return { kind: 'restarted' }
  }

  /**
   * Restarts on the same address: the old server stops listening, then the new one binds it, or
   * the old config does when the new one can't.
   *
   * @param next - the reloaded config
   * @returns what the restart did
   */
  const rebind = async (next: ServerConfig): Promise<RestartOutcome> => {
    await closeListener(server)
    const opened = await tryOpen(next)
    if (opened.ok) {
      takeOver(opened.server, next)
      return { kind: 'restarted' }
    }
    // Free a moment ago: bind it again as it was. Failing that, nothing listens: thrown.
    server = await parts.open(config, proxyAuth)
    return kept(next, opened.error)
  }

  return {
    config: () => config,
    server: () => server,
    restart: async (next) => {
      lifecycleLogger.info('Restarting on {host}:{port}', { host: next.host, port: next.port })
      const sameAddress = next.host === config.host && next.port === config.port
      const outcome = sameAddress ? await rebind(next) : await moveTo(next)
      if (outcome.kind === 'restarted') lifecycleLogger.info('Restarted')
      return outcome
    },
    close: () => {
      stopStats?.()
      stopStats = undefined
      server.close()
    }
  }
}

/**
 * Logs and reports a restart that kept the old server.
 *
 * @param next - the config that could not be bound
 * @param failure - why
 * @returns the outcome
 */
function kept(next: ServerConfig, failure: unknown): RestartOutcome {
  const reason = errorMessage(failure)
  lifecycleLogger.error('Cannot listen on {host}:{port}: {error}; still serving the old config', {
    host: next.host,
    port: next.port,
    error: reason
  })
  return { kind: 'kept', reason }
}

/**
 * Stops a server listening, leaving its open connections to finish, and waits until its address is
 * free to bind again.
 *
 * @param server - the server
 */
async function closeListener(server: ServerType): Promise<void> {
  server.close()
  // `close` stops accepting at once; the socket's handle is released on the next turn of the loop.
  await new Promise<void>((resolve) => {
    setImmediate(resolve)
  })
}

/** What the console was started with, to restart the server the same way (#288). */
export interface ConsoleStartup {
  /** The settings a flag or env var holds, which the config file can't change. */
  readonly overrides: SettingOverrides
  /**
   * Loads the config again with the flags the console was started with.
   *
   * @returns the config; `undefined` when proxy auth is set but can't be applied, which is logged
   */
  reload(): ServerConfig | undefined
  /**
   * Logs at another level from now on.
   *
   * @param level - the lowest level logged
   */
  logAt(level: LogLevel): void
}

/** What a restart from the console touches. */
export interface RestartParts {
  readonly server: ConsoleServer
  readonly startup: ConsoleStartup
  /** The Stats view, replaced when a restart turns stats on or off. */
  readonly stats: { view: StatsView }
  /** Opens the Stats view for stats on or off (`openStatsView`). */
  readonly openStats: (statsEnabled: boolean) => StatsView
  /** Ends the console: the server could not listen at all. */
  readonly crashed: (error: unknown) => void
  /** Reads the status again, so the views show the new config. */
  readonly refresh: () => Promise<void>
}

/**
 * Follows a config the server now runs: its log level, and stats turned on or off.
 *
 * @param parts - the startup, the Stats view and how to open it
 * @param next - the config now running
 * @param before - the config it replaced
 */
function followRestart(parts: RestartParts, next: ServerConfig, before: ServerConfig): void {
  parts.startup.logAt(next.logLevel)
  logEffectiveConfig(next)
  if (next.statsEnabled === before.statsEnabled) return
  parts.stats.view.close()
  parts.stats.view = parts.openStats(next.statsEnabled)
}

/**
 * Makes the console's restart (#288): reloads the config with the flags it started with, restarts
 * the server, then applies the log level and opens the Stats view anew if stats were turned on or
 * off. A second restart asked for while one runs gets the one running.
 *
 * @param parts - the server, the startup, the Stats view, and how to crash and refresh
 * @returns the restart
 */
export function createRestart(parts: RestartParts): () => Promise<RestartReport> {
  const { server, startup } = parts
  const restart = async (): Promise<RestartReport> => {
    const next = startup.reload()
    if (next === undefined) return { kind: 'refused' }
    const before = server.config()
    let outcome: RestartOutcome
    try {
      outcome = await server.restart(next)
    } catch (error) {
      // The address was closed to be bound again and neither config could bind it: nothing
      // listens, so the console stops and says why, as a failed start does.
      parts.crashed(error)
      return { kind: 'kept', reason: errorMessage(error) }
    }
    if (outcome.kind === 'restarted') followRestart(parts, next, before)
    await parts.refresh()
    return outcome
  }
  let running: Promise<RestartReport> | undefined
  return () => {
    running ??= restart().finally(() => {
      running = undefined
    })
    return running
  }
}
