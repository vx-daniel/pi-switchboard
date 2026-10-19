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

/** Where an override token came from: the flag wins over the env var. */
type OverrideSource = '--auth-token' | 'PI_PROXY_AUTH_TOKEN'

/** A token set by flag or env var, which wins over the config file's. */
interface TokenOverride {
  readonly source: OverrideSource
  readonly value: string
}

/**
 * Why proxy auth cannot be applied:
 * - `file-token-not-string`: `authToken` in proxy-config.json is not a string (#82);
 * - `empty-override`: `--auth-token` or `PI_PROXY_AUTH_TOKEN` is set but empty, a token nothing
 *   can match (#99). The file's token is not used instead: that would ignore what was set.
 */
export type InvalidAuthCause =
  | { readonly cause: 'file-token-not-string' }
  | { readonly cause: 'empty-override'; readonly source: OverrideSource }

/**
 * Proxy auth, as configured:
 * - `off`: every request is let through;
 * - `token`: a request needs `Authorization: Bearer <token>`;
 * - `invalid`: the configured auth cannot be applied ({@link InvalidAuthCause}). Every
 *   authenticated route refuses until it is fixed, never let through as if off.
 */
export type ProxyAuth =
  | { readonly kind: 'off' }
  | { readonly kind: 'token'; readonly token: string }
  | ({ readonly kind: 'invalid' } & InvalidAuthCause)

/**
 * Picks the override token, if any: the flag's, else the env var's.
 *
 * @param flagToken - the `--auth-token` value, or `undefined` when not given
 * @param envToken - `PI_PROXY_AUTH_TOKEN`, or `undefined` when unset
 * @returns the override with its source, or `undefined` when neither is set
 */
function tokenOverride(
  flagToken: string | undefined,
  envToken: string | undefined
): TokenOverride | undefined {
  if (flagToken !== undefined) return { source: '--auth-token', value: flagToken }
  if (envToken !== undefined) return { source: 'PI_PROXY_AUTH_TOKEN', value: envToken }
  return undefined
}

/**
 * Resolves proxy auth: a flag or env token wins, else the config file's token.
 *
 * @param override - the flag or env token, or `undefined` when neither is set
 * @param fileToken - The config file's (normalized) `authToken`; '' means off.
 * @returns `token` for a non-empty override or file token; `invalid` for an empty override
 *   (#99) or a file `authToken` that is set but not a string (#82); else `off`.
 */
function resolveProxyAuth(override: TokenOverride | undefined, fileToken: string): ProxyAuth {
  if (override !== undefined) {
    return override.value === ''
      ? { kind: 'invalid', cause: 'empty-override', source: override.source }
      : { kind: 'token', token: override.value }
  }
  if (configFileAuthTokenInvalid()) return { kind: 'invalid', cause: 'file-token-not-string' }
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

  // Auth: CLI > env > file. A file token that is not a string, or an override that is set but
  // empty, fails closed rather than off (#82, #99).
  const override = tokenOverride(cli.authToken, process.env.PI_PROXY_AUTH_TOKEN)
  const proxyAuth = resolveProxyAuth(override, file.authToken)

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
