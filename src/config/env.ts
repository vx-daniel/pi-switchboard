/**
 * Server configuration loading for the proxy process.
 *
 * @remarks
 * Priority: CLI args > env vars > JSON config file > defaults. Not every setting has every
 * source: agentic mode is env-only (`PI_PROXY_AGENTIC`), and model exposure, public model IDs,
 * custom models and provider prefixes come from the config file only.
 *
 * The JSON config file (`proxy-config.json` in `$PI_CODING_AGENT_DIR`, default `~/.pi/agent`) is
 * the shared config written by the pi extension's /proxy config panel. Env vars and CLI args
 * override it for one-off adjustments or container use.
 *
 * @packageDocumentation
 */

import { getLogLevels, isLogLevel, type LogLevel } from '@logtape/logtape'
import type { ModelExposureMode, PublicModelIdMode } from '@proxy/config/schema'
import {
  BYTES_PER_MB,
  configFileAuthTokenInvalid,
  loadConfigFromFile,
  MS_PER_SECOND
} from '@proxy/config/schema'
import { proxyLogger } from '@proxy/logging'

/** Logger for config resolution (`config` category). */
const configLogger = proxyLogger('config')

/**
 * Proxy auth, as configured:
 * - `off`: every request is let through;
 * - `token`: a request needs `Authorization: Bearer <token>`;
 * - `invalid`: `authToken` in proxy-config.json is not a string, so the configured auth cannot be
 *   applied. Every authenticated route refuses until it is fixed, never let through as if off
 *   (#82).
 */
export type ProxyAuth =
  | { readonly kind: 'off' }
  | { readonly kind: 'token'; readonly token: string }
  | { readonly kind: 'invalid' }

/**
 * Resolves proxy auth: a flag or env token wins, else the config file's token.
 *
 * @param overrideToken - The `--auth-token` or `PI_PROXY_AUTH_TOKEN` value; `undefined` when
 *   neither is set. Any string, even '', is used as the token.
 * @param fileToken - The config file's (normalized) `authToken`; '' means off.
 * @returns `token` for an override or a non-empty file token, `invalid` when the file's
 *   `authToken` is set but not a string (#82), else `off`.
 */
function resolveProxyAuth(overrideToken: string | undefined, fileToken: string): ProxyAuth {
  if (overrideToken !== undefined) return { kind: 'token', token: overrideToken }
  if (configFileAuthTokenInvalid()) return { kind: 'invalid' }
  return fileToken.length > 0 ? { kind: 'token', token: fileToken } : { kind: 'off' }
}

/** The proxy server's resolved configuration, from {@link loadConfig}. */
export interface ServerConfig {
  /** Host to bind to. */
  readonly host: string
  /** Port to listen on. */
  readonly port: number
  /** Whether and how requests must authenticate; see `ProxyAuth`. */
  readonly proxyAuth: ProxyAuth
  /** Whether agentic mode is enabled. */
  readonly agenticEnabled: boolean
  /** Whether remote image URL fetching is enabled. */
  readonly remoteImagesEnabled: boolean
  /** Maximum request body size in bytes. */
  readonly maxBodySize: number
  /**
   * Milliseconds the upstream provider may send nothing before a call is aborted; not a cap on the
   * call.
   */
  readonly upstreamTimeoutMs: number
  /** How public model IDs are generated. */
  readonly publicModelIdMode: PublicModelIdMode
  /** Which models are exposed. */
  readonly modelExposureMode: ModelExposureMode
  /** Canonical model IDs for "custom" exposure mode. */
  readonly customModels: readonly string[]
  /** Provider key -> custom public prefix label. */
  readonly providerPrefixes: Readonly<Record<string, string>>
  /** Lowest log level written. */
  readonly logLevel: LogLevel
}

/** Env vars `loadConfig` reads. Only their names are logged, never their values. */
const CONFIG_ENV_VARS = [
  'PI_PROXY_HOST',
  'PI_PROXY_PORT',
  'PI_PROXY_AUTH_TOKEN',
  'PI_PROXY_REMOTE_IMAGES',
  'PI_PROXY_MAX_BODY_SIZE',
  'PI_PROXY_UPSTREAM_TIMEOUT_MS',
  'PI_PROXY_AGENTIC',
  'PI_PROXY_LOG_LEVEL'
] as const

/**
 * Resolves the log level from `PI_PROXY_LOG_LEVEL`, warning when the variable names no level.
 *
 * @param raw - The `PI_PROXY_LOG_LEVEL` value, or `undefined` when unset.
 * @param fallback - The level from the config file.
 * @returns `raw` when it names a LogTape level, otherwise `fallback`.
 */
function envLogLevel(raw: string | undefined, fallback: LogLevel): LogLevel {
  if (raw === undefined) return fallback
  if (isLogLevel(raw)) return raw
  configLogger.warn('Ignoring PI_PROXY_LOG_LEVEL={value}: not one of {levels}; using {fallback}', {
    value: raw,
    levels: getLogLevels(),
    fallback
  })
  return fallback
}

/**
 * Parses a positive integer env var, warning and using `fallback` when it is not one.
 *
 * @param name - The env var's name, for the warning.
 * @param raw - The env var's value, or `undefined` when unset.
 * @param fallback - The value to use when `raw` is unset or invalid.
 * @returns The parsed integer, or `fallback`.
 */
function parsePositiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    configLogger.warn('Ignoring {name}={value}: not a positive integer; using {fallback}', {
      name,
      value: raw,
      fallback
    })
    return fallback
  }
  return parsed
}

/**
 * Parses a boolean env var: only `true` is true.
 *
 * @remarks
 * Any value other than `true` or `false` is warned about and treated as false, not as `fallback`.
 *
 * @param name - The env var's name, for the warning.
 * @param raw - The env var's value, or `undefined` when unset.
 * @param fallback - The value to use when `raw` is unset.
 * @returns `fallback` when unset, else whether `raw` is `true`.
 */
function parseBoolean(name: string, raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback
  if (raw !== 'true' && raw !== 'false') {
    configLogger.warn('{name}={value} is not "true" or "false"; treating it as false', {
      name,
      value: raw
    })
  }
  return raw === 'true'
}

/** Settings given as CLI flags; `undefined` means the flag was not given. */
export interface CliOverrides {
  host?: string | undefined
  port?: number | undefined
  authToken?: string | undefined
  remoteImages?: boolean | undefined
  maxBodySizeMb?: number | undefined
  upstreamTimeoutSec?: number | undefined
  logLevel?: LogLevel | undefined
}

/**
 * Loads the server config with priority: CLI args > env vars > JSON file > defaults.
 *
 * @param cli - Settings from CLI flags; defaults to none.
 * @returns The resolved config.
 */
export function loadConfig(cli: CliOverrides = {}): ServerConfig {
  const file = loadConfigFromFile()

  configLogger.debug('Config overrides: CLI {cliOverrides}, env {envOverrides}', {
    cliOverrides: Object.entries(cli)
      .filter(([, value]) => value !== undefined)
      .map(([name]) => name),
    envOverrides: CONFIG_ENV_VARS.filter((envVar) => process.env[envVar] !== undefined)
  })

  const host = cli.host ?? process.env.PI_PROXY_HOST ?? file.host
  const port = cli.port ?? parsePositiveInt('PI_PROXY_PORT', process.env.PI_PROXY_PORT, file.port)

  // Auth: CLI > env > file. A file token that is not a string fails closed rather than off (#82).
  const overrideToken = cli.authToken ?? process.env.PI_PROXY_AUTH_TOKEN
  const proxyAuth = resolveProxyAuth(overrideToken, file.authToken)

  const remoteImagesEnabled =
    cli.remoteImages ??
    parseBoolean('PI_PROXY_REMOTE_IMAGES', process.env.PI_PROXY_REMOTE_IMAGES, file.remoteImages)

  const maxBodySize =
    cli.maxBodySizeMb === undefined
      ? parsePositiveInt(
          'PI_PROXY_MAX_BODY_SIZE',
          process.env.PI_PROXY_MAX_BODY_SIZE,
          file.maxBodySizeMb * BYTES_PER_MB
        )
      : cli.maxBodySizeMb * BYTES_PER_MB

  const upstreamTimeoutMs =
    cli.upstreamTimeoutSec === undefined
      ? parsePositiveInt(
          'PI_PROXY_UPSTREAM_TIMEOUT_MS',
          process.env.PI_PROXY_UPSTREAM_TIMEOUT_MS,
          file.upstreamTimeoutSec * MS_PER_SECOND
        )
      : cli.upstreamTimeoutSec * MS_PER_SECOND

  const agenticEnabled = process.env.PI_PROXY_AGENTIC === 'true'

  return {
    host,
    port,
    proxyAuth,
    agenticEnabled,
    remoteImagesEnabled,
    maxBodySize,
    upstreamTimeoutMs,
    publicModelIdMode: file.publicModelIdMode,
    modelExposureMode: file.modelExposureMode,
    customModels: file.customModels,
    providerPrefixes: file.providerPrefixes,
    logLevel: cli.logLevel ?? envLogLevel(process.env.PI_PROXY_LOG_LEVEL, file.logLevel)
  }
}
