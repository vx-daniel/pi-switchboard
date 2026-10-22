/**
 * What the headless CLI and the console (`pi-switchboard tui`, #61) share to start the proxy: the
 * server flags, the config with its logging, and the HTTP listener.
 *
 * @remarks
 * Config priority: CLI args > env vars > JSON config file > defaults. Logging is configured before
 * the config loads (loading logs too), and again with the resolved level.
 *
 * @packageDocumentation
 */

import type { ServerType } from '@hono/node-server'
import { serve } from '@hono/node-server'
import { getLogLevels, isLogLevel, type LogLevel } from '@logtape/logtape'
import {
  type CliOverrides,
  type InvalidAuthCause,
  loadConfig,
  type ServerConfig,
  UnusableProxyAuthError
} from '@proxy/config/env'
import { getConfigPath } from '@proxy/config/schema'
import {
  configureLogging,
  isLogFormat,
  LOG_FORMATS,
  proxyLogger,
  type SinkFormat
} from '@proxy/logging'
import { getAvailableModels } from '@proxy/pi/registry'
import { createApp } from '@proxy/server/app'
import type { ProxyAuthSwitch } from '@proxy/server/proxy-auth'
import { recordStatsToFile } from '@proxy/stats/recorder'

/** Logger for process lifecycle (`server` category). */
const lifecycleLogger = proxyLogger('server')

/** The server flags, as citty declares them; the CLI and the console both take them. */
export const SERVER_ARGS = {
  'host': {
    type: 'string',
    description: 'Bind address (default: from config or 127.0.0.1)'
  },
  'port': {
    type: 'string',
    description: 'Listen port (default: from config or 4141)'
  },
  'auth-token': {
    type: 'string',
    description: 'Bearer token for proxy authentication'
  },
  'remote-images': {
    type: 'boolean',
    description:
      'Fetch remote image URLs and inline them (off by default; public http/https hosts only, size, time and redirect limits)'
  },
  'docs-ui': {
    type: 'boolean',
    description:
      'Serve the Swagger UI docs page at /docs (off by default; its scripts load from a CDN)'
  },
  'stats': {
    type: 'boolean',
    description:
      'Keep per-minute traffic stats in pi-switchboard-stats.sqlite in pi’s agent dir, for the console (on by default; --no-stats turns it off)'
  },
  'max-body-size': {
    type: 'string',
    description: 'Maximum request body size in MB (default: from config or 50)'
  },
  'upstream-timeout': {
    type: 'string',
    description:
      'Seconds the upstream provider may send nothing before a call is aborted (default: from config or 120)'
  },
  'log-level': {
    type: 'string',
    description: `Lowest log level written: ${getLogLevels().join(', ')} (default: from config or info)`
  }
} as const

/** The server flags as citty parses them, before validation. */
export interface CliArgs {
  'host'?: string | undefined
  'port'?: string | undefined
  'auth-token'?: string | undefined
  'remote-images'?: boolean | undefined
  'docs-ui'?: boolean | undefined
  'stats'?: boolean | undefined
  'max-body-size'?: string | undefined
  'upstream-timeout'?: string | undefined
  'log-level'?: string | undefined
  'log-format'?: string | undefined
}

/**
 * Checks whether a bind address only accepts connections from this machine.
 *
 * @param host - The bind address.
 * @returns Whether `host` is `localhost`, `::1` or in `127.0.0.0/8`.
 */
export function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || host.startsWith('127.')
}

/**
 * Parses a CLI integer argument, warning when it is given but not a positive integer.
 *
 * @param name - The flag's name without `--`, for the warning.
 * @param value - The flag's value, or `undefined` when it is absent.
 * @returns The parsed integer, or `undefined` when absent or invalid.
 */
function parsePositiveIntArg(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number.parseInt(value, 10)
  if (Number.isFinite(parsed) && parsed > 0) return parsed
  lifecycleLogger.warn('Ignoring --{name}={value}: not a positive integer', { name, value })
  return undefined
}

/**
 * Checks the logging flags, so a typo fails the start with a message, never a stack trace.
 *
 * @param args - The parsed CLI flags.
 * @returns The error message for the first unusable logging flag, or `undefined`.
 */
export function invalidLoggingFlag(args: CliArgs): string | undefined {
  const level = args['log-level']
  if (level !== undefined && !isLogLevel(level)) {
    return `--log-level must be one of: ${getLogLevels().join(', ')}`
  }
  const format = args['log-format']
  if (format !== undefined && !isLogFormat(format)) {
    return `--log-format must be one of: ${LOG_FORMATS.join(', ')}`
  }
  return undefined
}

/**
 * Builds CLI overrides from parsed args; invalid numbers are warned about and left out.
 *
 * @param args - The parsed CLI flags.
 * @returns The overrides for {@link loadConfig}.
 */
function buildCliOverrides(args: CliArgs): CliOverrides {
  const cli: CliOverrides = {}
  if (args.host !== undefined) {
    cli.host = args.host
  }
  const port = parsePositiveIntArg('port', args.port)
  if (port !== undefined) cli.port = port
  if (args['auth-token'] !== undefined) {
    cli.authToken = args['auth-token']
  }
  if (args['remote-images'] !== undefined) {
    cli.remoteImages = args['remote-images']
  }
  if (args['docs-ui'] !== undefined) {
    cli.docsUi = args['docs-ui']
  }
  if (args.stats !== undefined) {
    cli.stats = args.stats
  }
  const mb = parsePositiveIntArg('max-body-size', args['max-body-size'])
  if (mb !== undefined) cli.maxBodySizeMb = mb
  const sec = parsePositiveIntArg('upstream-timeout', args['upstream-timeout'])
  if (sec !== undefined) cli.upstreamTimeoutSec = sec
  const logLevel = args['log-level']
  if (logLevel !== undefined && isLogLevel(logLevel)) cli.logLevel = logLevel
  return cli
}

/**
 * Logs why the proxy refuses to start: proxy auth is set but cannot be applied.
 *
 * @remarks
 * At `fatal`, which no log level filters out, so the reason always reaches the operator. Never the
 * token: it is what the operator meant as a secret. A `switch` on the cause, so the lint's
 * exhaustiveness check flags a cause added without a message.
 *
 * @param invalid - why the configured auth cannot be applied
 */
function logUnusableProxyAuth(invalid: InvalidAuthCause): void {
  switch (invalid.cause) {
    case 'empty-override':
      lifecycleLogger.fatal(
        'Refusing to start: {source} is set but empty. Set a token, or unset it to use the config file',
        { source: invalid.source }
      )
      break
    case 'file-token-not-string':
      lifecycleLogger.fatal(
        'Refusing to start: authToken in {configPath} is not a string. Fix it, or set a token with --auth-token or PI_SWITCHBOARD_AUTH_TOKEN',
        { configPath: getConfigPath() }
      )
      break
    case 'renamed-env-var':
      lifecycleLogger.fatal(
        'Refusing to start: PI_PROXY_AUTH_TOKEN is set but no longer read; rename it PI_SWITCHBOARD_AUTH_TOKEN (#65), or unset it'
      )
      break
  }
}

/** Where log lines go, and in which format; the CLI picks them from its flags, the console its own. */
export interface LogOutput {
  /** The format: the CLI's `pretty` or `json`, or the console's narrow `console` layout. */
  readonly format: SinkFormat
  /** Where formatted lines go; `undefined` writes to stderr. */
  readonly write?: ((line: string) => void) | undefined
}

/**
 * Configures logging, then loads the config.
 *
 * @remarks
 * Config loading logs too, so logging is configured first with the level the CLI or env asks for,
 * then again with the fully resolved level (which may come from the config file). The logging
 * flags have already been checked ({@link invalidLoggingFlag}).
 *
 * @param args - The parsed CLI flags.
 * @param output - Where log lines go, and in which format.
 * @returns The config; `undefined` when proxy auth is set but cannot be applied, which is logged
 *   and must stop the proxy from starting.
 * @throws whatever loading the config throws, other than {@link UnusableProxyAuthError}
 */
export function loadConfigWithLogging(args: CliArgs, output: LogOutput): ServerConfig | undefined {
  const { format, write } = output
  const earlyLogLevel =
    [args['log-level'], process.env.PI_SWITCHBOARD_LOG_LEVEL].find(
      (candidate): candidate is LogLevel => candidate !== undefined && isLogLevel(candidate)
    ) ?? 'info'
  configureLogging({ level: earlyLogLevel, format, write })

  let config: ServerConfig
  try {
    config = loadConfig(buildCliOverrides(args))
  } catch (error) {
    if (!(error instanceof UnusableProxyAuthError)) throw error
    logUnusableProxyAuth(error.invalid)
    return undefined
  }
  configureLogging({ level: config.logLevel, format, write })
  const envFormat = process.env.PI_SWITCHBOARD_LOG_FORMAT
  if (envFormat !== undefined && !isLogFormat(envFormat)) {
    lifecycleLogger.warn('Ignoring PI_SWITCHBOARD_LOG_FORMAT={value}: not one of {formats}', {
      value: envFormat,
      formats: LOG_FORMATS
    })
  }
  lifecycleLogger.debug('Logging at {level} as {format}', { level: config.logLevel, format })
  return config
}

/**
 * Logs the effective config and how proxy auth is set, never the token itself.
 *
 * @remarks
 * Auth off is a warning when the proxy listens beyond loopback, and debug otherwise; a token needs
 * no line.
 *
 * @param config - the resolved server config
 */
export function logEffectiveConfig(config: ServerConfig): void {
  lifecycleLogger.debug('Effective config', {
    configPath: getConfigPath(),
    host: config.host,
    port: config.port,
    proxyAuthMode: config.proxyAuth.kind,
    agenticEnabled: config.agenticEnabled,
    remoteImagesEnabled: config.remoteImagesEnabled,
    docsUiEnabled: config.docsUiEnabled,
    statsEnabled: config.statsEnabled,
    maxBodySize: config.maxBodySize,
    upstreamTimeoutMs: config.upstreamTimeoutMs,
    publicModelIdMode: config.publicModelIdMode,
    modelExposureMode: config.modelExposureMode,
    customModelCount: config.customModels.length,
    providerPrefixCount: Object.keys(config.providerPrefixes).length,
    logLevel: config.logLevel
  })
  if (config.proxyAuth.kind === 'token') return
  if (isLoopbackHost(config.host)) {
    lifecycleLogger.debug('Proxy auth is disabled: /v1 endpoints accept unauthenticated requests')
  } else {
    // Off-loopback without auth is an exposure worth seeing at the default level.
    lifecycleLogger.warn(
      'Proxy auth is disabled and the proxy listens on {host}: any client that can reach it can use your provider credentials',
      { host: config.host }
    )
  }
}

/**
 * Starts the HTTP server and waits until it listens. The model runtime must be initialized
 * (`initRegistry`).
 *
 * @remarks
 * A port in use or an address that cannot be bound rejects here, before the caller goes on (the
 * console takes over the terminal only after this), instead of surfacing later as an uncaught
 * `error` event.
 *
 * @param config - the resolved server config
 * @param proxyAuth - the proxy auth the server applies; by default one made from
 *   `config.proxyAuth`. The console passes its own, to change auth without a restart
 * @returns the listening server
 * @throws Error when the server cannot listen, such as `EADDRINUSE`
 */
export async function listen(
  config: ServerConfig,
  proxyAuth?: ProxyAuthSwitch
): Promise<ServerType> {
  const app = createApp(config, undefined, undefined, proxyAuth)
  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host })
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error): void => {
      server.off('listening', listening)
      reject(error)
    }
    const listening = (): void => {
      server.off('error', failed)
      resolve()
    }
    server.once('error', failed)
    server.once('listening', listening)
  })
  lifecycleLogger.info('Listening on http://{host}:{port} with {modelCount} models', {
    host: config.host,
    port: config.port,
    modelCount: getAvailableModels().length,
    logLevel: config.logLevel
  })
  // Written until the server closes, or the process exits without closing it.
  const stopStats = config.statsEnabled ? recordStatsToFile() : undefined
  if (stopStats !== undefined) server.once('close', stopStats)
  return server
}
