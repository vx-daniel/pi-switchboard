/**
 * The citty CLI (args, help, version) that configures logging, loads the config and starts the
 * HTTP server. `src/index.ts` loads it, and answers a missing pi package with a clear error.
 *
 * @remarks
 * Config priority: CLI args > env vars > JSON config file > defaults. Evaluating this module runs
 * the CLI on `process.argv`.
 *
 * @packageDocumentation
 */

import { serve } from '@hono/node-server'
import { getLogLevels, isLogLevel, type LogLevel } from '@logtape/logtape'
import {
  type CliOverrides,
  type InvalidAuthCause,
  loadConfig,
  type ServerConfig,
  UnusableProxyAuthError
} from '@proxy/config/env'
import { configFileAuthTokenInvalid, getConfigPath, loadConfigFromFile } from '@proxy/config/schema'
import {
  configureLogging,
  isLogFormat,
  LOG_FORMATS,
  proxyLogger,
  resolveLogFormat
} from '@proxy/logging'
import { getAvailableModels, initRegistry } from '@proxy/pi/registry'
import { createApp } from '@proxy/server/app'
import { defineCommand, runMain } from 'citty'

/** Logger for process lifecycle (`server` category). */
const lifecycleLogger = proxyLogger('server')

/** Indentation of the `--config` JSON output. */
const JSON_INDENT = 2
/** What `--config` shows for a non-empty `authToken`. */
const MASKED_TOKEN = '***'
/** What `--config` shows for an `authToken` in the file that is not a string (#82). */
const INVALID_TOKEN_SHOWN = '<invalid: not a string>'

/**
 * Returns the auth token as `--config` shows it.
 *
 * @param fileToken - The config file's normalized `authToken`.
 * @returns `<invalid: not a string>` when the file's `authToken` is not a string, `***` for a
 *   non-empty token, '' when auth is off.
 */
function shownAuthToken(fileToken: string): string {
  if (configFileAuthTokenInvalid()) return INVALID_TOKEN_SHOWN
  return fileToken.length > 0 ? MASKED_TOKEN : ''
}

/**
 * Checks whether a bind address only accepts connections from this machine.
 *
 * @param host - The bind address.
 * @returns Whether `host` is `localhost`, `::1` or in `127.0.0.0/8`.
 */
function isLoopbackHost(host: string): boolean {
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

/** The CLI flags as citty parses them, before validation. */
interface CliArgs {
  'host'?: string | undefined
  'port'?: string | undefined
  'auth-token'?: string | undefined
  'remote-images'?: boolean | undefined
  'docs-ui'?: boolean | undefined
  'max-body-size'?: string | undefined
  'upstream-timeout'?: string | undefined
  'log-level'?: string | undefined
  'log-format'?: string | undefined
}

/**
 * Checks the logging flags, so a typo fails the start with a message, never a stack trace.
 *
 * @param args - The parsed CLI flags.
 * @returns The error message for the first unusable logging flag, or `undefined`.
 */
function invalidLoggingFlag(args: CliArgs): string | undefined {
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
  const mb = parsePositiveIntArg('max-body-size', args['max-body-size'])
  if (mb !== undefined) cli.maxBodySizeMb = mb
  const sec = parsePositiveIntArg('upstream-timeout', args['upstream-timeout'])
  if (sec !== undefined) cli.upstreamTimeoutSec = sec
  const logLevel = args['log-level']
  if (logLevel !== undefined && isLogLevel(logLevel)) cli.logLevel = logLevel
  return cli
}

/**
 * Configures logging, then loads the config.
 *
 * @remarks
 * Config loading logs too, so logging is configured first with the level the CLI or env asks for,
 * then again with the fully resolved level (which may come from the config file). The logging
 * flags have already been checked (`run`).
 *
 * @param args - The parsed CLI flags.
 * @returns The config; `undefined` when proxy auth is set but cannot be applied, which is logged
 *   and must stop the proxy from starting.
 * @throws whatever loading the config throws, other than {@link UnusableProxyAuthError}
 */
function loadConfigWithLogging(args: CliArgs): ServerConfig | undefined {
  const format = resolveLogFormat(args['log-format'], process.env.PI_SWITCHBOARD_LOG_FORMAT)
  const earlyLogLevel =
    [args['log-level'], process.env.PI_SWITCHBOARD_LOG_LEVEL].find(
      (candidate): candidate is LogLevel => candidate !== undefined && isLogLevel(candidate)
    ) ?? 'info'
  configureLogging({ level: earlyLogLevel, format })

  let config: ServerConfig
  try {
    config = loadConfig(buildCliOverrides(args))
  } catch (error) {
    if (!(error instanceof UnusableProxyAuthError)) throw error
    logUnusableProxyAuth(error.invalid)
    return undefined
  }
  configureLogging({ level: config.logLevel, format })
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

/**
 * Logs how proxy auth is set, at the level its risk deserves.
 *
 * @remarks
 * Auth off is a warning when the proxy listens beyond loopback, and debug otherwise; a token needs
 * no line.
 *
 * @param config - the resolved server config
 */
function logProxyAuth(config: ServerConfig): void {
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

/** The `pi-switchboard` command: its flags, and `run`, which starts the server. */
const main = defineCommand({
  meta: {
    name: 'pi-switchboard',
    description: "OpenAI-compatible HTTP API over pi's models, logins and providers"
  },
  args: {
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
    },
    'log-format': {
      type: 'string',
      description: `Log output: ${LOG_FORMATS.join(', ')} (default: pretty on a terminal, json otherwise)`
    },
    'config': {
      type: 'boolean',
      description:
        "Show the config file's contents and exit (not the effective config: flags and env vars are not applied)"
    }
  },
  run: async ({ args }) => {
    // An unusable flag refuses every path, `--config` included, with the valid values (#95).
    const invalidFlag = invalidLoggingFlag(args)
    if (invalidFlag !== undefined) {
      process.stderr.write(`${invalidFlag}\n`)
      process.exitCode = 1
      return
    }

    // --config: show the config file's values (not CLI or env overrides) and exit. Command
    // output, not a log line, so it goes to stdout, where it is easily piped or captured: the
    // token is masked.
    if (args.config === true) {
      const file = loadConfigFromFile()
      const shown = { ...file, authToken: shownAuthToken(file.authToken) }
      process.stdout.write(`Config file: ${getConfigPath()}\n`)
      process.stdout.write(`${JSON.stringify(shown, null, JSON_INDENT)}\n`)
      return
    }

    const config = loadConfigWithLogging(args)
    // Proxy auth set but unusable: logged, and the proxy does not start.
    if (config === undefined) {
      process.exitCode = 1
      return
    }

    // Never the auth token itself: only how proxy auth is set (`off` or `token`).
    lifecycleLogger.debug('Effective config', {
      configPath: getConfigPath(),
      host: config.host,
      port: config.port,
      proxyAuthMode: config.proxyAuth.kind,
      agenticEnabled: config.agenticEnabled,
      remoteImagesEnabled: config.remoteImagesEnabled,
      docsUiEnabled: config.docsUiEnabled,
      maxBodySize: config.maxBodySize,
      upstreamTimeoutMs: config.upstreamTimeoutMs,
      publicModelIdMode: config.publicModelIdMode,
      modelExposureMode: config.modelExposureMode,
      customModelCount: config.customModels.length,
      providerPrefixCount: Object.keys(config.providerPrefixes).length,
      logLevel: config.logLevel
    })
    logProxyAuth(config)

    // Initialize pi integration; initRegistry logs a models.json load failure itself.
    await initRegistry()

    const models = getAvailableModels()
    const app = createApp(config)

    lifecycleLogger.info('Listening on http://{host}:{port} with {modelCount} models', {
      host: config.host,
      port: config.port,
      modelCount: models.length,
      logLevel: config.logLevel
    })

    // --- Graceful shutdown ---
    let shutdownInitiated = false

    /**
     * Closes the server on the first shutdown signal, and forces exit after a 10 s timeout.
     *
     * @param signal - The signal's name, for the log line.
     */
    function handleShutdown(signal: string): void {
      if (shutdownInitiated) return
      shutdownInitiated = true

      lifecycleLogger.info('Received {signal}, shutting down', { signal })

      const SHUTDOWN_TIMEOUT_MS = 10_000

      server.close()

      setTimeout(() => {
        lifecycleLogger.warn('Shutdown timed out after {timeoutMs} ms; forcing exit', {
          timeoutMs: SHUTDOWN_TIMEOUT_MS
        })
        process.exit(1)
      }, SHUTDOWN_TIMEOUT_MS).unref()
    }

    process.on('SIGTERM', () => handleShutdown('SIGTERM'))
    process.on('SIGINT', () => handleShutdown('SIGINT'))

    const server = serve({
      fetch: app.fetch,
      port: config.port,
      hostname: config.host
    })
  }
})

void runMain(main)
