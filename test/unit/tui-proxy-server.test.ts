/**
 * The console's server and its restart (`src/tui/proxy-server.ts`, #288). On real sockets: a new
 * address is bound before the old one closes, a failed bind keeps the proxy where it was, the same
 * address is bound again, and exactly one stats recorder runs at a time. Around it: a reload the
 * proxy can't use refuses, the log level and the Stats view follow only a restart that happened,
 * and a restart asked for twice runs once.
 */

import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { createServer as createNetServer, type Server as NetServer } from 'node:net'

import type { ServerConfig } from '@proxy/config/env'
import { createProxyAuthSwitch } from '@proxy/server/proxy-auth'
import type { StatsView } from '@proxy/tui/dashboard'
import {
  type ConsoleServer,
  createRestart,
  type RestartOutcome,
  type RestartReport,
  type ServerParts,
  startConsoleServer
} from '@proxy/tui/proxy-server'
import { afterEach, describe, expect, test } from 'vite-plus/test'

import { testConfig } from '../helpers'

/** Servers a test opened, closed after it. */
const opened: (Server | NetServer)[] = []

afterEach(async () => {
  await Promise.all(
    opened.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
          if ('closeAllConnections' in server) server.closeAllConnections()
        })
    )
  )
})

/**
 * Finds a port free on loopback now.
 *
 * @returns the port
 */
async function freePort(): Promise<number> {
  const probe = createNetServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const address = probe.address()
  probe.close()
  await once(probe, 'close')
  if (address === null || typeof address === 'string') throw new Error('probe not on TCP')
  return address.port
}

/**
 * Holds a port, so binding it fails with `EADDRINUSE`.
 *
 * @param port - the port to hold
 */
async function occupy(port: number): Promise<void> {
  const holder = createNetServer()
  holder.listen(port, '127.0.0.1')
  await once(holder, 'listening')
  opened.push(holder)
}

/**
 * Builds a config on loopback.
 *
 * @param port - its port
 * @param fields - the fields to change
 * @returns the config
 */
function configOn(port: number, fields: Partial<ServerConfig> = {}): ServerConfig {
  return { ...testConfig(), host: '127.0.0.1', port, statsEnabled: true, ...fields }
}

/** What the fake parts did, in order: each server bound and each recorder started and stopped. */
interface Recorded {
  readonly events: string[]
  readonly parts: ServerParts
}

/**
 * Makes server parts that bind a plain HTTP server, and record when stats start and stop.
 *
 * @returns the parts and their log
 */
function recordingParts(): Recorded {
  const events: string[] = []
  let recorders = 0
  const parts: ServerParts = {
    open: async (config) => {
      const server = createServer((_request, response) => response.end('ok'))
      server.listen(config.port, config.host)
      await new Promise<void>((resolve, reject) => {
        server.once('listening', resolve)
        server.once('error', reject)
      })
      opened.push(server)
      events.push(`listen ${String(config.port)}`)
      server.once('close', () => events.push(`closed ${String(config.port)}`))
      return server
    },
    recordStats: () => {
      recorders += 1
      const recorder = recorders
      events.push(`stats ${String(recorder)} on`)
      return () => events.push(`stats ${String(recorder)} off`)
    }
  }
  return { events, parts }
}

describe('startConsoleServer', () => {
  // Catches a move to another port that closes the old server first (a failed bind would leave
  // nothing listening) or leaves both recorders running, counting every request twice.
  test('moves to a new address: binds it first, then hands the recorder over and closes the old', async () => {
    const [from, to] = [await freePort(), await freePort()]
    const { events, parts } = recordingParts()
    const auth = createProxyAuthSwitch({ kind: 'off' })
    const server = await startConsoleServer(configOn(from), auth, parts)
    const first = server.server()

    const outcome = await server.restart(
      configOn(to, { proxyAuth: { kind: 'token', token: 'next' } })
    )

    expect(outcome).toEqual({ kind: 'restarted' })
    expect(server.config().port).toBe(to)
    expect(server.server().listening).toBe(true)
    expect(first.listening).toBe(false)
    expect(auth.current()).toEqual({ kind: 'token', token: 'next' })
    expect(events.slice(0, 5)).toEqual([
      `listen ${String(from)}`,
      'stats 1 on',
      `listen ${String(to)}`,
      'stats 1 off',
      'stats 2 on'
    ])
    server.close()
  })

  // Catches a failed bind on the new address taking the proxy down, or changing its config, auth
  // or recorder as if the restart had happened.
  test('keeps serving the old config when the new address is in use', async () => {
    const [from, taken] = [await freePort(), await freePort()]
    await occupy(taken)
    const { events, parts } = recordingParts()
    const auth = createProxyAuthSwitch({ kind: 'off' })
    const server = await startConsoleServer(configOn(from), auth, parts)

    const outcome = await server.restart(
      configOn(taken, { proxyAuth: { kind: 'token', token: 'next' } })
    )

    expect(outcome.kind).toBe('kept')
    expect(outcome.kind === 'kept' && outcome.reason).toContain('EADDRINUSE')
    expect(server.config().port).toBe(from)
    expect(server.server().listening).toBe(true)
    expect(auth.current()).toEqual({ kind: 'off' })
    expect(events).toEqual([`listen ${String(from)}`, 'stats 1 on'])
    server.close()
  })

  // Catches a restart on the same address failing with EADDRINUSE against its own old listener,
  // or a stats switch-off left running.
  test('binds the same address again, and stops recording when stats were turned off', async () => {
    const port = await freePort()
    const { events, parts } = recordingParts()
    const server = await startConsoleServer(
      configOn(port),
      createProxyAuthSwitch({ kind: 'off' }),
      parts
    )

    const outcome = await server.restart(configOn(port, { statsEnabled: false }))

    expect(outcome).toEqual({ kind: 'restarted' })
    expect(server.server().listening).toBe(true)
    expect(server.config().statsEnabled).toBe(false)
    expect(events).toContain('stats 1 off')
    expect(events.filter((event) => event.endsWith(' on'))).toEqual(['stats 1 on'])
    server.close()
  })

  // Catches the same address left unbound when the new config can't start on it: the old config
  // must take it back, so the proxy keeps serving.
  test('binds the old config again when the new one fails on the same address', async () => {
    const port = await freePort()
    const { parts } = recordingParts()
    const refusing: ServerParts = {
      ...parts,
      open: async (config, auth) => {
        if (config.maxBodySize === 1) throw new Error('cannot start')
        return parts.open(config, auth)
      }
    }
    const server = await startConsoleServer(
      configOn(port),
      createProxyAuthSwitch({ kind: 'off' }),
      refusing
    )

    const outcome = await server.restart(configOn(port, { maxBodySize: 1 }))

    expect(outcome).toEqual({ kind: 'kept', reason: 'cannot start' })
    expect(server.config().maxBodySize).not.toBe(1)
    expect(server.server().listening).toBe(true)
    server.close()
  })

  // Catches closing the console leaving the stats recorder running past the server.
  test('close stops the recorder and the server', async () => {
    const port = await freePort()
    const { events, parts } = recordingParts()
    const server = await startConsoleServer(
      configOn(port),
      createProxyAuthSwitch({ kind: 'off' }),
      parts
    )

    server.close()
    await once(server.server(), 'close')

    expect(events).toEqual([
      `listen ${String(port)}`,
      'stats 1 on',
      'stats 1 off',
      `closed ${String(port)}`
    ])
  })
})

/** What a {@link createRestart} test recorded. */
interface RestartLog {
  /** Log levels applied, Stats views opened and closed, refreshes, crashes, reloads. */
  readonly events: string[]
  readonly restart: () => Promise<RestartReport>
}

/**
 * Makes a Stats view that records being closed.
 *
 * @param name - what it is called in the log
 * @param events - the log
 * @returns the view
 */
function statsView(name: string, events: string[]): StatsView {
  return {
    rows: () => [],
    todayCostUsd: () => undefined,
    frameNote: () => '',
    close: () => events.push(`close ${name}`)
  }
}

/**
 * Builds a restart over a fake server that answers `outcome`, running `before` and reloading
 * `next`.
 *
 * @param before - the config running
 * @param next - what a reload gives; `undefined` as when proxy auth can't be applied
 * @param outcome - what the server's restart does: an outcome, or an error it throws
 * @returns the restart and its log
 */
function restartWith(
  before: ServerConfig,
  next: ServerConfig | undefined,
  outcome: RestartOutcome | Error
): RestartLog {
  const events: string[] = []
  let running = before
  const server: ConsoleServer = {
    config: () => running,
    server: () => {
      throw new Error('not used')
    },
    restart: async (config) => {
      events.push('server restart')
      await Promise.resolve()
      if (outcome instanceof Error) throw outcome
      if (outcome.kind === 'restarted') running = config
      return outcome
    },
    close: () => undefined
  }
  const restart = createRestart({
    server,
    startup: {
      overrides: {},
      reload: () => {
        events.push('reload')
        return next
      },
      logAt: (level) => events.push(`log at ${level}`)
    },
    stats: { view: statsView('old stats', events) },
    openStats: (enabled) => {
      events.push(`open stats ${enabled ? 'on' : 'off'}`)
      return statsView('new stats', events)
    },
    crashed: (error) => events.push(`crashed: ${String(error)}`),
    refresh: async () => {
      events.push('refresh')
    }
  })
  return { events, restart }
}

describe('createRestart', () => {
  // Catches a reload the proxy can't start with (proxy auth set but unusable) going on to restart
  // the server, which would refuse to start it anyway.
  test('refuses without touching the server when the reloaded config is unusable', async () => {
    const { events, restart } = restartWith(configOn(4141), undefined, { kind: 'restarted' })

    expect(await restart()).toEqual({ kind: 'refused' })
    expect(events).toEqual(['reload'])
  })

  // Catches the log level or the Stats view left on the old config after a restart, or the Stats
  // view reopened when stats were not turned on or off.
  test('applies the log level and reopens the Stats view once the restart happened', async () => {
    const next = configOn(4141, { logLevel: 'debug', statsEnabled: false })
    const { events, restart } = restartWith(configOn(4141), next, { kind: 'restarted' })

    expect(await restart()).toEqual({ kind: 'restarted' })
    expect(events).toEqual([
      'reload',
      'server restart',
      'log at debug',
      'close old stats',
      'open stats off',
      'refresh'
    ])
  })

  // Catches a restart that kept the old server still switching the log level or the Stats view to
  // a config that is not running.
  test('leaves the log level and the Stats view alone when the old server was kept', async () => {
    const next = configOn(4142, { logLevel: 'debug', statsEnabled: false })
    const { events, restart } = restartWith(configOn(4141), next, {
      kind: 'kept',
      reason: 'listen EADDRINUSE'
    })

    expect(await restart()).toEqual({ kind: 'kept', reason: 'listen EADDRINUSE' })
    expect(events).toEqual(['reload', 'server restart', 'refresh'])
  })

  // Catches a server that could bind neither config (nothing listens) leaving the console up as if
  // it still served.
  test('stops the console when the server could not listen at all', async () => {
    const { events, restart } = restartWith(configOn(4141), configOn(4141), new Error('EADDRINUSE'))

    expect(await restart()).toEqual({ kind: 'kept', reason: 'EADDRINUSE' })
    expect(events).toContain('crashed: Error: EADDRINUSE')
  })

  // Catches a second `r` while a restart runs starting another, which would race the first for
  // the address.
  test('a restart asked for while one runs gets the one running', async () => {
    const { events, restart } = restartWith(configOn(4141), configOn(4142), { kind: 'restarted' })

    const [first, second] = await Promise.all([restart(), restart()])

    expect(first).toEqual({ kind: 'restarted' })
    expect(second).toBe(first)
    expect(events.filter((event) => event === 'server restart')).toHaveLength(1)
    await restart()
    expect(events.filter((event) => event === 'server restart')).toHaveLength(2)
  })
})
