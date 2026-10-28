/**
 * Server configuration loading for the proxy process.
 *
 * @remarks
 * Priority: CLI args > env vars > JSON config file > defaults. Not every setting has every
 * source: model exposure, public model IDs, custom models, provider prefixes and aliases come
 * from the config file only.
 *
 * The env vars were `PI_PROXY_*` before the rename to pi-switchboard (#65). The old names are not
 * read; one that is still set is warned about, and an old auth token refuses to start
 * ({@link UnusableProxyAuthError}), since ignoring it would quietly turn auth off. So does a
 * config file that exists but cannot be read or parsed when no flag or env var sets the token: the
 * file may hold one.
 *
 * The JSON config file (`proxy-config.json` in `$PI_CODING_AGENT_DIR`, default `~/.pi/agent`) is
 * the shared config written by the pi extension's /proxy config panel. Env vars and CLI args
 * override it for one-off adjustments or container use.
 *
 * @packageDocumentation
 */

import { getLogLevels, isLogLevel, type LogLevel } from '@logtape/logtape'
import type {
  AliasTarget,
  ConfigFileProblem,
  ModelExposureMode,
  ProxyConfig,
  PublicModelIdMode
} from '@proxy/config/schema'
import {
  BYTES_PER_MB,
  configFileAuthTokenInvalid,
  configFileProblem,
  intBounds,
  loadConfigFromFile,
  MaxBodySizeBytesSchema,
  parseIntText,
  ProxyConfigSchema,
  UpstreamTimeoutMsSchema
} from '@proxy/config/schema'
import { proxyLogger } from '@proxy/logging'
import { MS_PER_SECOND } from '@proxy/utils/time'
import type * as z from 'zod'

/** Logger for config resolution (`config` category). */
const configLogger = proxyLogger('config')

/** Where an override token came from: the flag wins over the env var. */
export type OverrideSource = '--auth-token' | 'PI_SWITCHBOARD_AUTH_TOKEN'

/** A token set by flag or env var, which wins over the config file's. */
interface TokenOverride {
  readonly source: OverrideSource
  readonly value: string
}

/**
 * Why proxy auth is set but cannot be applied:
 * - `file-token-not-string`: `authToken` in proxy-config.json is not a string (#82);
 * - `file-unusable`: proxy-config.json exists but cannot be read or is not valid JSON, and neither
 *   the flag nor `PI_SWITCHBOARD_AUTH_TOKEN` sets a token. The file may hold a token the proxy
 *   cannot see, so starting on the defaults could turn it into auth off;
 * - `empty-override`: `--auth-token` or `PI_SWITCHBOARD_AUTH_TOKEN` is set but empty, a token
 *   nothing can match (#99). The file's token is not used instead: that would ignore what was set;
 * - `renamed-env-var`: the old `PI_PROXY_AUTH_TOKEN` is set and neither the flag nor
 *   `PI_SWITCHBOARD_AUTH_TOKEN` is (#65). It is no longer read, so starting would drop the token.
 */
export type InvalidAuthCause =
  | { readonly cause: 'file-token-not-string' }
  | { readonly cause: 'file-unusable'; readonly file: ConfigFileProblem }
  | { readonly cause: 'empty-override'; readonly source: OverrideSource }
  | { readonly cause: 'renamed-env-var' }

/**
 * Thrown by {@link loadConfig} when proxy auth is set but cannot be applied. The proxy refuses to
 * start: repairing the setting to auth off would turn a requested token into an open proxy, and
 * starting to refuse every request hides the mistake behind a running process.
 */
export class UnusableProxyAuthError extends Error {
  /** Why the configured auth cannot be applied. */
  readonly invalid: InvalidAuthCause

  /**
   * Creates the error.
   *
   * @param invalid - why the configured auth cannot be applied
   */
  constructor(invalid: InvalidAuthCause) {
    super(`Proxy auth cannot be applied (${invalid.cause})`)
    this.name = 'UnusableProxyAuthError'
    this.invalid = invalid
  }
}

/**
 * Proxy auth, as configured:
 * - `off`: every request is let through;
 * - `token`: a request needs `Authorization: Bearer <token>`.
 */
export type ProxyAuth =
  | { readonly kind: 'off' }
  | { readonly kind: 'token'; readonly token: string }

/**
 * Picks the override token, if any: the flag's, else the env var's.
 *
 * @param flagToken - the `--auth-token` value, or `undefined` when not given
 * @param envToken - `PI_SWITCHBOARD_AUTH_TOKEN`, or `undefined` when unset
 * @returns the override with its source, or `undefined` when neither is set
 */
function tokenOverride(
  flagToken: string | undefined,
  envToken: string | undefined
): TokenOverride | undefined {
  if (flagToken !== undefined) return { source: '--auth-token', value: flagToken }
  if (envToken !== undefined) return { source: 'PI_SWITCHBOARD_AUTH_TOKEN', value: envToken }
  return undefined
}

/**
 * Resolves proxy auth: a flag or env token wins, else the config file's token.
 *
 * @param override - the flag or env token, or `undefined` when neither is set
 * @param fileToken - The config file's (normalized) `authToken`; '' means off.
 * @returns `token` for a non-empty override or file token; else `off`.
 * @throws UnusableProxyAuthError for an empty override (#99), a config file that exists but
 *   cannot be read or parsed with no override to stand in for its token, or a file `authToken`
 *   that is set but not a string (#82)
 */
function resolveProxyAuth(override: TokenOverride | undefined, fileToken: string): ProxyAuth {
  if (override !== undefined) {
    if (override.value === '') {
      throw new UnusableProxyAuthError({ cause: 'empty-override', source: override.source })
    }
    return { kind: 'token', token: override.value }
  }
  // With no override, the file is the only place a token can be: a file the proxy cannot read
  // may hold one, and `fileToken` is then the repaired '' (auth off), not what the operator set.
  const fileProblem = configFileProblem()
  if (fileProblem !== undefined) {
    throw new UnusableProxyAuthError({ cause: 'file-unusable', file: fileProblem })
  }
  if (configFileAuthTokenInvalid()) {
    throw new UnusableProxyAuthError({ cause: 'file-token-not-string' })
  }
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
  /**
   * The flag or env var that set the token, when one did; absent for the config file's token or
   * auth off. The console says it applies again at the next start when auth is turned off.
   */
  readonly proxyAuthOverride?: OverrideSource
  /** Whether requests a web page could send are refused (`hostOriginGuard`, #188). */
  readonly hostOriginGuardEnabled: boolean
  /** Whether remote image URL fetching is enabled. */
  readonly remoteImagesEnabled: boolean
  /** Whether the Swagger UI docs page is served. */
  readonly docsUiEnabled: boolean
  /** Whether the experimental Responses API (`POST /v1/responses`, #140) answers. */
  readonly responsesApiEnabled: boolean
  /** Whether per-minute traffic stats are kept in the stats file (#216). */
  readonly statsEnabled: boolean
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
  /** Alias -> one canonical ID, or targets with the failures that move between them (#66, #67). */
  readonly aliases: Readonly<Record<string, AliasTarget>>
  /** Lowest log level written. */
  readonly logLevel: LogLevel
}

/** The prefix of the proxy's env vars. */
const ENV_PREFIX = 'PI_SWITCHBOARD_'
/** The prefix they had before the rename to pi-switchboard (#65). */
const OLD_ENV_PREFIX = 'PI_PROXY_'

/**
 * Every runtime env var the proxy and its extension read, by the name after the prefix: the one
 * list the config debug line and the rename warnings both come from.
 */
const RUNTIME_ENV_SUFFIXES = [
  'HOST',
  'PORT',
  'AUTH_TOKEN',
  'HOST_ORIGIN_GUARD',
  'REMOTE_IMAGES',
  'DOCS_UI',
  'RESPONSES_API',
  'STATS',
  'MAX_BODY_SIZE',
  'UPSTREAM_TIMEOUT_MS',
  'LOG_LEVEL',
  'LOG_FORMAT',
  'EXTENSION_LOG_FILE'
] as const

/**
 * Warns about each old `PI_PROXY_*` env var that is still set: it is not read, so the setting it
 * meant does not apply. Names only, never values (an old auth token is a secret).
 */
function warnAboutRenamedEnvVars(): void {
  for (const suffix of RUNTIME_ENV_SUFFIXES) {
    const oldName = `${OLD_ENV_PREFIX}${suffix}`
    if (process.env[oldName] === undefined) continue
    configLogger.warn(
      '{oldName} is set but no longer read: it is {newName} since the rename (#65)',
      {
        oldName,
        newName: `${ENV_PREFIX}${suffix}`
      }
    )
  }
}

/**
 * Resolves the log level from `PI_SWITCHBOARD_LOG_LEVEL`, warning when the variable names no
 * level.
 *
 * @param raw - The `PI_SWITCHBOARD_LOG_LEVEL` value, or `undefined` when unset.
 * @param fallback - The level from the config file.
 * @returns `raw` when it names a LogTape level, otherwise `fallback`.
 */
function envLogLevel(raw: string | undefined, fallback: LogLevel): LogLevel {
  if (raw === undefined) return fallback
  if (isLogLevel(raw)) return raw
  configLogger.warn(
    'Ignoring PI_SWITCHBOARD_LOG_LEVEL={value}: not one of {levels}; using {fallback}',
    {
      value: raw,
      levels: getLogLevels(),
      fallback
    }
  )
  return fallback
}

/**
 * Parses an integer env var against the config file's bounds for the same setting, warning and
 * using `fallback` when it is not one within them.
 *
 * @remarks
 * Warn and fall back, never clamp: an invalid env var is ignored (CONSTITUTION principle II),
 * where an invalid config-file value is repaired to the nearest bound.
 *
 * @param name - The env var's name, for the warning.
 * @param raw - The env var's value, or `undefined` when unset.
 * @param schema - The bounds, in the env var's unit.
 * @param fallback - The value to use when `raw` is unset or invalid.
 * @returns The parsed integer, or `fallback`.
 */
function parseEnvInt(
  name: string,
  raw: string | undefined,
  schema: z.ZodInt,
  fallback: number
): number {
  if (raw === undefined) return fallback
  const parsed = parseIntText(raw, schema)
  if (parsed === undefined) {
    const { min, max } = intBounds(schema)
    configLogger.warn(
      'Ignoring {name}={value}: not an integer from {min} to {max}; using {fallback}',
      { name, value: raw, min, max, fallback }
    )
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
  hostOriginGuard?: boolean | undefined
  remoteImages?: boolean | undefined
  docsUi?: boolean | undefined
  responsesApi?: boolean | undefined
  stats?: boolean | undefined
  maxBodySizeMb?: number | undefined
  upstreamTimeoutSec?: number | undefined
  logLevel?: LogLevel | undefined
}

/** The on/off settings {@link resolveSwitches} resolves. */
type Switches = Pick<
  ServerConfig,
  | 'hostOriginGuardEnabled'
  | 'remoteImagesEnabled'
  | 'docsUiEnabled'
  | 'responsesApiEnabled'
  | 'statsEnabled'
>

/**
 * Resolves the on/off settings, each CLI > env > file.
 *
 * @param cli - Settings from CLI flags.
 * @param file - The config file's values.
 * @returns Each switch's resolved value.
 */
function resolveSwitches(cli: CliOverrides, file: ProxyConfig): Switches {
  return {
    hostOriginGuardEnabled:
      cli.hostOriginGuard ??
      parseBoolean(
        'PI_SWITCHBOARD_HOST_ORIGIN_GUARD',
        process.env.PI_SWITCHBOARD_HOST_ORIGIN_GUARD,
        file.hostOriginGuard
      ),
    remoteImagesEnabled:
      cli.remoteImages ??
      parseBoolean(
        'PI_SWITCHBOARD_REMOTE_IMAGES',
        process.env.PI_SWITCHBOARD_REMOTE_IMAGES,
        file.remoteImages
      ),
    docsUiEnabled:
      cli.docsUi ??
      parseBoolean('PI_SWITCHBOARD_DOCS_UI', process.env.PI_SWITCHBOARD_DOCS_UI, file.docsUi),
    responsesApiEnabled:
      cli.responsesApi ??
      parseBoolean(
        'PI_SWITCHBOARD_RESPONSES_API',
        process.env.PI_SWITCHBOARD_RESPONSES_API,
        file.responsesApi
      ),
    statsEnabled:
      cli.stats ??
      parseBoolean('PI_SWITCHBOARD_STATS', process.env.PI_SWITCHBOARD_STATS, file.stats)
  }
}

/**
 * Loads the server config with priority: CLI args > env vars > JSON file > defaults.
 *
 * @param cli - Settings from CLI flags; defaults to none.
 * @returns The resolved config.
 * @throws UnusableProxyAuthError when proxy auth is set but cannot be applied: the proxy must not
 *   start, with auth off or otherwise.
 */
export function loadConfig(cli: CliOverrides = {}): ServerConfig {
  const file = loadConfigFromFile()
  warnAboutRenamedEnvVars()

  configLogger.debug('Config overrides: CLI {cliOverrides}, env {envOverrides}', {
    cliOverrides: Object.entries(cli)
      .filter(([, value]) => value !== undefined)
      .map(([name]) => name),
    envOverrides: RUNTIME_ENV_SUFFIXES.map((suffix) => `${ENV_PREFIX}${suffix}`).filter(
      (envVar) => process.env[envVar] !== undefined
    )
  })

  const host = cli.host ?? process.env.PI_SWITCHBOARD_HOST ?? file.host
  const port =
    cli.port ??
    parseEnvInt(
      'PI_SWITCHBOARD_PORT',
      process.env.PI_SWITCHBOARD_PORT,
      ProxyConfigSchema.shape.port,
      file.port
    )

  // Auth: CLI > env > file. A file token that is not a string, an override that is set but empty,
  // or a token left in the old env var refuses to start rather than run with auth off (#82, #99,
  // #65).
  const override = tokenOverride(cli.authToken, process.env.PI_SWITCHBOARD_AUTH_TOKEN)
  if (override === undefined && process.env[`${OLD_ENV_PREFIX}AUTH_TOKEN`] !== undefined) {
    throw new UnusableProxyAuthError({ cause: 'renamed-env-var' })
  }
  const proxyAuth = resolveProxyAuth(override, file.authToken)

  const maxBodySize =
    cli.maxBodySizeMb === undefined
      ? parseEnvInt(
          'PI_SWITCHBOARD_MAX_BODY_SIZE',
          process.env.PI_SWITCHBOARD_MAX_BODY_SIZE,
          MaxBodySizeBytesSchema,
          file.maxBodySizeMb * BYTES_PER_MB
        )
      : cli.maxBodySizeMb * BYTES_PER_MB

  const upstreamTimeoutMs =
    cli.upstreamTimeoutSec === undefined
      ? parseEnvInt(
          'PI_SWITCHBOARD_UPSTREAM_TIMEOUT_MS',
          process.env.PI_SWITCHBOARD_UPSTREAM_TIMEOUT_MS,
          UpstreamTimeoutMsSchema,
          file.upstreamTimeoutSec * MS_PER_SECOND
        )
      : cli.upstreamTimeoutSec * MS_PER_SECOND

  return {
    host,
    port,
    proxyAuth,
    ...(override === undefined ? {} : { proxyAuthOverride: override.source }),
    ...resolveSwitches(cli, file),
    maxBodySize,
    upstreamTimeoutMs,
    publicModelIdMode: file.publicModelIdMode,
    modelExposureMode: file.modelExposureMode,
    customModels: file.customModels,
    providerPrefixes: file.providerPrefixes,
    aliases: file.aliases,
    logLevel: cli.logLevel ?? envLogLevel(process.env.PI_SWITCHBOARD_LOG_LEVEL, file.logLevel)
  }
}
