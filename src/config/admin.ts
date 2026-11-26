/**
 * The admin UI's settings (#367), resolved from the config file's `adminUi` section, env vars and
 * secret files, and what keeps it from starting.
 *
 * @remarks
 * Priority: env var > config file > default, as for the other settings. The operator's own GitHub
 * App (its client ID and secret) and the session key never come from the config file: only from
 * an env var, or from the file a `<name>_FILE` env var names (a Docker secret). Their values are
 * never logged; a problem names the variable, never what it holds.
 *
 * The admin listener starts with the headless server only (`pi-switchboard`, `src/cli.ts`); the
 * console does not run it. So {@link adminUiProblems} is checked there, not in `loadConfig`: a
 * console on a machine whose config file enables the admin UI without its secrets still starts.
 *
 * @packageDocumentation
 */

import { readFileSync } from 'node:fs'

import {
  type AdminUiConfig,
  AdminUiConfigSchema,
  GitHubPrincipalSchema
} from '@proxy/config/admin-schema'
import { parseBoolean, parseEnvInt } from '@proxy/config/env-values'
import { isLoopbackHost } from '@proxy/config/schema'
import { proxyLogger } from '@proxy/logging'
import { errorCode } from '@proxy/utils/guards'

/** Logger for config resolution (`config` category). */
const configLogger = proxyLogger('config')

/** The fewest bytes a session key may have: an HMAC-SHA256 key as long as its output. */
const MIN_SESSION_KEY_BYTES = 32

/** The env vars that hold the sign-in secrets, each also readable from `<name>_FILE`. */
const SIGN_IN_ENV = {
  clientId: 'PI_SWITCHBOARD_GITHUB_CLIENT_ID',
  clientSecret: 'PI_SWITCHBOARD_GITHUB_CLIENT_SECRET',
  sessionKey: 'PI_SWITCHBOARD_ADMIN_SESSION_KEY'
} as const

/** The operator's GitHub App and the key that signs the admin UI's cookies. */
export interface AdminSignIn {
  /** The GitHub App's client ID. */
  readonly clientId: string
  /** The GitHub App's client secret. */
  readonly clientSecret: string
  /** The HMAC-SHA256 key for the sign-in and session cookies. */
  readonly sessionKey: string
}

/** The admin UI's settings, resolved. */
export interface AdminUiSettings {
  /** Whether the headless server starts the admin listener. */
  readonly enabled: boolean
  /** The admin listener's bind address. */
  readonly host: string
  /** The admin listener's port. */
  readonly port: number
  /** The origin operators open, for GitHub's callback: the configured one, or the listener's. */
  readonly publicUrl: string
  /** GitHub's web origin, where sign-in starts and the code is exchanged. */
  readonly githubUrl: string
  /** GitHub's API origin and path: `https://api.github.com`, or a GitHub Enterprise Server's. */
  readonly apiUrl: string
  /** Logins and teams (`org/slug`) that may change settings. */
  readonly editors: readonly string[]
  /** Logins and teams that may only read. */
  readonly viewers: readonly string[]
  /** The sign-in secrets; `undefined` when any is missing (see {@link adminUiProblems}). */
  readonly signIn?: AdminSignIn
  /** Why a secret could not be read, by its env var; never its value. */
  readonly secretProblems: readonly string[]
}

/** The env, as the resolver reads it. */
type Env = Readonly<Record<string, string | undefined>>

/**
 * Reads one secret: from its env var, or from the file `<name>_FILE` names.
 *
 * @param name - the env var
 * @param env - the environment
 * @returns the secret, trimmed; or why it could not be read; or nothing when neither is set
 */
function readSecret(
  name: string,
  env: Env
): { readonly value: string } | { readonly problem: string } | undefined {
  const direct = env[name]
  const path = env[`${name}_FILE`]
  if (direct !== undefined && path !== undefined) {
    return { problem: `${name} and ${name}_FILE are both set; set one` }
  }
  if (direct !== undefined) {
    return direct.trim() === '' ? { problem: `${name} is set but empty` } : { value: direct.trim() }
  }
  if (path === undefined) return undefined
  try {
    const value = readFileSync(path, 'utf8').trim()
    return value === '' ? { problem: `${name}_FILE names an empty file` } : { value }
  } catch (error) {
    // The fs code only: the message would quote the path, which is the operator's to see anyway,
    // but never the file's contents.
    return { problem: `${name}_FILE cannot be read (${errorCode(error)})` }
  }
}

/**
 * Reads the sign-in secrets.
 *
 * @param env - the environment
 * @returns the secrets when all three are present, and why any could not be read
 */
function readSignIn(env: Env): { signIn?: AdminSignIn; problems: string[] } {
  const problems: string[] = []
  /**
   * Reads one secret, keeping why it could not be read.
   *
   * @param name - the env var
   * @returns the secret, or `undefined` when it is unset or unreadable
   */
  const secret = (name: string): string | undefined => {
    const read = readSecret(name, env)
    if (read === undefined) return undefined
    if ('problem' in read) {
      problems.push(read.problem)
      return undefined
    }
    return read.value
  }
  const clientId = secret(SIGN_IN_ENV.clientId)
  const clientSecret = secret(SIGN_IN_ENV.clientSecret)
  const sessionKey = secret(SIGN_IN_ENV.sessionKey)
  if (clientId === undefined || clientSecret === undefined || sessionKey === undefined) {
    return { problems }
  }
  return { signIn: { clientId, clientSecret, sessionKey }, problems }
}

/**
 * Reads a comma-separated list of logins and teams from an env var, dropping invalid entries with
 * a warning.
 *
 * @param name - the env var
 * @param raw - its value, or `undefined` when unset
 * @param fallback - the list to use when it is unset
 * @returns the list
 */
function envPrincipals(
  name: string,
  raw: string | undefined,
  fallback: readonly string[]
): readonly string[] {
  if (raw === undefined) return fallback
  const listed = raw
    .split(',')
    .map((principal) => principal.trim())
    .filter((principal) => principal.length > 0)
  const valid = listed.filter((principal) => GitHubPrincipalSchema.safeParse(principal).success)
  if (valid.length < listed.length) {
    configLogger.warn('{name} has {count} entries that are no GitHub login or org/team; ignored', {
      name,
      count: listed.length - valid.length
    })
  }
  return valid
}

/**
 * Reads the admin UI's address from its env var, warning and using the file's when it is no
 * origin.
 *
 * @param raw - `PI_SWITCHBOARD_ADMIN_URL`, or `undefined` when unset
 * @param fallback - the config file's `adminUi.publicUrl`
 * @returns the address, or `''` for the listener's own
 */
function envPublicUrl(raw: string | undefined, fallback: string): string {
  if (raw === undefined) return fallback
  const parsed = AdminUiConfigSchema.shape.publicUrl.safeParse(raw.trim())
  if (parsed.success) return parsed.data
  configLogger.warn(
    'Ignoring PI_SWITCHBOARD_ADMIN_URL={value}: not an http or https origin; using the config file',
    { value: raw }
  )
  return fallback
}

/**
 * Says what the listener's own address is, for a host operators can open.
 *
 * @param host - the bind address
 * @param port - the port
 * @returns `http://<host>:<port>`, IPv6 in brackets
 */
function listenerOrigin(host: string, port: number): string {
  const shown = host.includes(':') ? `[${host}]` : host
  return `http://${shown}:${String(port)}`
}

/**
 * Says where GitHub's API is for a GitHub web origin.
 *
 * @param githubUrl - `https://github.com`, or a GitHub Enterprise Server's origin
 * @returns `https://api.github.com`, or `<origin>/api/v3`
 */
function apiUrlFor(githubUrl: string): string {
  return new URL(githubUrl).host === 'github.com'
    ? 'https://api.github.com'
    : `${new URL(githubUrl).origin}/api/v3`
}

/**
 * Resolves the admin UI's settings.
 *
 * @param file - the config file's `adminUi` section
 * @param env - the environment
 * @returns the settings; check {@link adminUiProblems} before starting the listener
 */
export function resolveAdminUi(file: AdminUiConfig, env: Env): AdminUiSettings {
  const envHost = env['PI_SWITCHBOARD_ADMIN_HOST']?.trim()
  const host = envHost === undefined || envHost === '' ? file.host : envHost
  const port = parseEnvInt(
    'PI_SWITCHBOARD_ADMIN_PORT',
    env['PI_SWITCHBOARD_ADMIN_PORT'],
    AdminUiConfigSchema.shape.port,
    file.port
  )
  const publicUrl = envPublicUrl(env['PI_SWITCHBOARD_ADMIN_URL'], file.publicUrl)
  const { signIn, problems } = readSignIn(env)
  return {
    enabled: parseBoolean('PI_SWITCHBOARD_ADMIN_UI', env['PI_SWITCHBOARD_ADMIN_UI'], file.enabled),
    host,
    port,
    publicUrl: publicUrl === '' ? listenerOrigin(host, port) : new URL(publicUrl).origin,
    githubUrl: new URL(file.githubUrl).origin,
    apiUrl: apiUrlFor(file.githubUrl),
    editors: envPrincipals(
      'PI_SWITCHBOARD_ADMIN_EDITORS',
      env['PI_SWITCHBOARD_ADMIN_EDITORS'],
      file.editors
    ),
    viewers: envPrincipals(
      'PI_SWITCHBOARD_ADMIN_VIEWERS',
      env['PI_SWITCHBOARD_ADMIN_VIEWERS'],
      file.viewers
    ),
    ...(signIn === undefined ? {} : { signIn }),
    secretProblems: problems
  }
}

/**
 * Says why the admin listener must not start (constitution principle III, #367), or nothing when it
 * may.
 *
 * @remarks
 * Stricter than the constitution's floor (beyond loopback, sign-in configured): sign-in is required
 * on loopback too, since nobody could sign in without it; and beyond loopback the address must be
 * `https`, since the session cookie is `Secure` and a browser keeps a `Secure` cookie from plain
 * `http` only on localhost.
 *
 * @param settings - the resolved settings
 * @returns each reason, as an operator can act on it; empty when the listener may start
 */
export function adminUiProblems(settings: AdminUiSettings): string[] {
  if (!settings.enabled) return []
  const problems = [...settings.secretProblems]
  if (settings.signIn === undefined && settings.secretProblems.length === 0) {
    problems.push(
      `sign-in is not configured: set ${SIGN_IN_ENV.clientId}, ${SIGN_IN_ENV.clientSecret} and ${SIGN_IN_ENV.sessionKey} (or their _FILE variants)`
    )
  }
  if (
    settings.signIn !== undefined &&
    Buffer.byteLength(settings.signIn.sessionKey) < MIN_SESSION_KEY_BYTES
  ) {
    problems.push(
      `${SIGN_IN_ENV.sessionKey} is shorter than ${String(MIN_SESSION_KEY_BYTES)} bytes`
    )
  }
  if (settings.editors.length === 0 && settings.viewers.length === 0) {
    problems.push(
      'nobody may sign in: list GitHub logins or org/team names in adminUi.editors or adminUi.viewers'
    )
  }
  const address = new URL(settings.publicUrl)
  const loopbackAddress = isLoopbackHost(address.hostname.replace(/^\[|\]$/gu, ''))
  if (address.protocol !== 'https:' && !loopbackAddress) {
    problems.push(
      `the admin UI's address ${settings.publicUrl} is not https: beyond this machine, serve it over https (set adminUi.publicUrl) or keep it on loopback`
    )
  }
  if (!isLoopbackHost(settings.host) && address.protocol !== 'https:') {
    problems.push(
      `the admin listener binds ${settings.host}, beyond this machine, without an https address`
    )
  }
  return problems
}
