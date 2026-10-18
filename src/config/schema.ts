/**
 * Proxy configuration schema -- single source of truth.
 *
 * Used by both the proxy server and the pi extension.
 * The server reads the JSON config file as defaults, with env vars and CLI args as overrides.
 * The pi extension reads and writes the JSON config file via the /proxy config panel.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { isLogLevel, type LogLevel } from '@logtape/logtape'
import { proxyLogger } from '@proxy/logging'
import { errorCode, isRecord } from '@proxy/utils/guards'
import * as z from 'zod'

const configLogger = proxyLogger('config')

// ---------------------------------------------------------------------------
// Schema: the values each field accepts, and the source of the config types
// ---------------------------------------------------------------------------

export const BYTES_PER_MB = 1_048_576
export const MS_PER_SECOND = 1000

const MAX_PORT = 65_535
const MAX_BODY_SIZE_MB = 500
const MIN_UPSTREAM_TIMEOUT_SEC = 5
const MAX_UPSTREAM_TIMEOUT_SEC = 600

/**
 * How public model IDs are generated from canonical provider/model-id pairs.
 *
 * - "collision-prefixed": prefix only providers in conflict groups that share a raw model ID
 * - "universal": expose raw model IDs only; duplicates are a config error
 * - "always-prefixed": always expose <prefix>/<model-id> for every model
 */
export const PublicModelIdModeSchema = z.enum([
  'collision-prefixed',
  'universal',
  'always-prefixed'
])
export type PublicModelIdMode = z.infer<typeof PublicModelIdModeSchema>

/**
 * Which models are exposed on the public HTTP API, in the order the settings panel offers them.
 * All modes only expose auth-configured models (pi's getAvailable()).
 *
 * - "scoped": delegates to pi's global `enabledModels` setting (from `/scoped-models` Ctrl+S)
 * - "all": every available model, no filter
 * - "custom": same per-model filtering as "scoped" but independently managed
 *   via the proxy's own `customModels` config
 */
export const ModelExposureModeSchema = z.enum(['scoped', 'all', 'custom'])
export type ModelExposureMode = z.infer<typeof ModelExposureModeSchema>

/** "detached" = background daemon, "session" = dies with the pi session. */
export const LifetimeSchema = z.enum(['detached', 'session'])

const LogLevelSchema = z.custom<LogLevel>(
  (value) => typeof value === 'string' && isLogLevel(value),
  { error: 'Not a LogTape log level' }
)

/** Host, model IDs, prefix labels: surrounding whitespace is a typo, and empty means unset. */
const NonEmptyStringSchema = z.string().trim().min(1)

function boundedInt(min: number, max: number): z.ZodInt {
  return z.int().min(min).max(max)
}

const ZedSyncConfigSchema = z.object({
  /** Provider label in Zed's `openai_compatible` section. Trimmed; never empty. */
  providerName: z.string().trim().min(1),
  /** Sync models to Zed's settings.json when the config changes. */
  autoSync: z.boolean()
})

export type ZedSyncConfig = z.infer<typeof ZedSyncConfigSchema>

const ProxyConfigSchema = z.object({
  /** Bind address. */
  host: NonEmptyStringSchema,
  /** Listen port. */
  port: boundedInt(1, MAX_PORT),
  /** Bearer token for proxy auth. Empty string = disabled. */
  // oxlint-disable-next-line zod/prefer-string-schema-with-trim -- the token must match byte for byte
  authToken: z.string(),
  /** Allow remote image URL fetching. */
  remoteImages: z.boolean(),
  /** Max request body in MB. */
  maxBodySizeMb: boundedInt(1, MAX_BODY_SIZE_MB),
  /** Seconds the upstream provider may send nothing before a call is aborted. */
  upstreamTimeoutSec: boundedInt(MIN_UPSTREAM_TIMEOUT_SEC, MAX_UPSTREAM_TIMEOUT_SEC),
  lifetime: LifetimeSchema,
  publicModelIdMode: PublicModelIdModeSchema,
  modelExposureMode: ModelExposureModeSchema,
  /** Canonical model IDs to expose when modelExposureMode is "custom". */
  customModels: z.array(NonEmptyStringSchema).readonly(),
  /** Provider key -> custom public prefix label. Default prefix = provider key. */
  providerPrefixes: z.record(NonEmptyStringSchema, NonEmptyStringSchema).readonly(),
  /** Lowest log level the proxy writes (LogTape levels). */
  logLevel: LogLevelSchema,
  zed: ZedSyncConfigSchema
})

export type ProxyConfig = Readonly<z.infer<typeof ProxyConfigSchema>>

export function isPublicModelIdMode(value: string): value is PublicModelIdMode {
  return PublicModelIdModeSchema.safeParse(value).success
}

export function isModelExposureMode(value: string): value is ModelExposureMode {
  return ModelExposureModeSchema.safeParse(value).success
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG: Readonly<ProxyConfig> = {
  host: '127.0.0.1',
  port: 4141,
  authToken: '',
  remoteImages: false,
  maxBodySizeMb: 50,
  upstreamTimeoutSec: 120,
  lifetime: 'detached',
  publicModelIdMode: 'collision-prefixed',
  modelExposureMode: 'scoped',
  customModels: [],
  providerPrefixes: {},
  logLevel: 'info',
  zed: {
    providerName: 'Pi Proxy',
    autoSync: false
  }
}

// ---------------------------------------------------------------------------
// Normalization: a config is never refused
// ---------------------------------------------------------------------------
//
// A field the schema rejects is repaired rather than failing the load, so a typo never stops a
// background proxy: a number is clamped to its bounds (rounded first), a list or map keeps its valid
// entries, anything else takes its default. Each repaired field is named in one warning.

/** A number clamped to [min, max] and rounded; anything that is not a finite number is `fallback`. */
function clampInt(min: number, max: number, fallback: number): (value: unknown) => number {
  return (value) =>
    typeof value === 'number' && Number.isFinite(value)
      ? Math.max(min, Math.min(max, Math.round(value)))
      : fallback
}

/** The list entries `NonEmptyStringSchema` accepts, as it outputs them; not a list: empty. */
function validStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const result: string[] = []
  for (const candidate of value) {
    const parsed = NonEmptyStringSchema.safeParse(candidate)
    if (parsed.success) result.push(parsed.data)
  }
  return result
}

/** The map entries whose key and value `NonEmptyStringSchema` accepts; not a map: empty. */
function validStringEntries(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  const result: Record<string, string> = {}
  for (const [key, candidate] of Object.entries(value)) {
    const parsedKey = NonEmptyStringSchema.safeParse(key)
    const parsedValue = NonEmptyStringSchema.safeParse(candidate)
    if (parsedKey.success && parsedValue.success) result[parsedKey.data] = parsedValue.data
  }
  return result
}

/** Reads one field: its value when the schema accepts it, otherwise `repair(value)`. */
type FieldReader<Key extends string> = <T>(
  key: Key,
  schema: z.ZodType<T>,
  repair: (value: unknown) => T
) => T

/**
 * A reader for the fields of `raw`, an object at `scope` (`undefined` for the config itself). A field
 * that is present but invalid is recorded in `corrected` by its path; a missing one is not, because
 * leaving a field out is how a config takes its default.
 */
function fieldReader<Key extends string>(
  raw: unknown,
  corrected: string[],
  scope?: string
): FieldReader<Key> {
  if (raw !== undefined && !isRecord(raw)) corrected.push(scope ?? 'config')
  const input = isRecord(raw) ? raw : {}
  const prefix = scope === undefined ? '' : `${scope}.`
  return (key, schema, repair) => {
    const value = input[key]
    const parsed = schema.safeParse(value)
    if (parsed.success) return parsed.data
    if (value !== undefined) corrected.push(`${prefix}${key}`)
    return repair(value)
  }
}

/** The fields the last warning named: the config is read on every request, so it warns per change. */
let lastCorrections = ''

function reportCorrections(corrected: readonly string[]): void {
  const key = corrected.join(',')
  if (key === lastCorrections) return
  lastCorrections = key
  if (corrected.length === 0) return
  // Field names only, never values: one of them can be the auth token.
  configLogger.warn(
    'Config has invalid values at {fields}; using the defaults or the nearest allowed values',
    { fields: corrected }
  )
}

function normalizeZedSyncConfig(raw: unknown, corrected: string[]): ZedSyncConfig {
  const field = fieldReader<keyof ZedSyncConfig>(raw, corrected, 'zed')
  const fields = ZedSyncConfigSchema.shape
  return {
    providerName: field('providerName', fields.providerName, () => DEFAULT_CONFIG.zed.providerName),
    autoSync: field('autoSync', fields.autoSync, () => DEFAULT_CONFIG.zed.autoSync)
  }
}

export function normalizeConfig(raw: unknown): ProxyConfig {
  const corrected: string[] = []
  const field = fieldReader<keyof ProxyConfig>(raw, corrected)
  const fields = ProxyConfigSchema.shape
  const config: ProxyConfig = {
    host: field('host', fields.host, () => DEFAULT_CONFIG.host),
    port: field('port', fields.port, clampInt(1, MAX_PORT, DEFAULT_CONFIG.port)),
    authToken: field('authToken', fields.authToken, () => DEFAULT_CONFIG.authToken),
    remoteImages: field('remoteImages', fields.remoteImages, () => DEFAULT_CONFIG.remoteImages),
    maxBodySizeMb: field(
      'maxBodySizeMb',
      fields.maxBodySizeMb,
      clampInt(1, MAX_BODY_SIZE_MB, DEFAULT_CONFIG.maxBodySizeMb)
    ),
    upstreamTimeoutSec: field(
      'upstreamTimeoutSec',
      fields.upstreamTimeoutSec,
      clampInt(
        MIN_UPSTREAM_TIMEOUT_SEC,
        MAX_UPSTREAM_TIMEOUT_SEC,
        DEFAULT_CONFIG.upstreamTimeoutSec
      )
    ),
    lifetime: field('lifetime', fields.lifetime, () => DEFAULT_CONFIG.lifetime),
    publicModelIdMode: field(
      'publicModelIdMode',
      fields.publicModelIdMode,
      () => DEFAULT_CONFIG.publicModelIdMode
    ),
    modelExposureMode: field(
      'modelExposureMode',
      fields.modelExposureMode,
      () => DEFAULT_CONFIG.modelExposureMode
    ),
    customModels: field('customModels', fields.customModels, validStrings),
    providerPrefixes: field('providerPrefixes', fields.providerPrefixes, validStringEntries),
    logLevel: field('logLevel', fields.logLevel, () => DEFAULT_CONFIG.logLevel),
    zed: normalizeZedSyncConfig(isRecord(raw) ? raw['zed'] : undefined, corrected)
  }
  reportCorrections(corrected)
  return config
}

// ---------------------------------------------------------------------------
// JSON config file path
// ---------------------------------------------------------------------------

export function getConfigPath(): string {
  const piDir = process.env.PI_CODING_AGENT_DIR ?? resolve(process.env.HOME ?? '~', '.pi', 'agent')
  return resolve(piDir, 'proxy-config.json')
}

// ---------------------------------------------------------------------------
// JSON config file I/O
// ---------------------------------------------------------------------------

export function loadConfigFromFile(): ProxyConfig {
  const configPath = getConfigPath()
  if (!existsSync(configPath)) {
    configLogger.debug('No config file at {path}; using defaults', { path: configPath })
    return { ...DEFAULT_CONFIG }
  }
  let text: string
  try {
    text = readFileSync(configPath, 'utf-8')
  } catch (error) {
    configLogger.warn('Could not read config file {path} ({code}); using defaults', {
      path: configPath,
      code: errorCode(error)
    })
    return { ...DEFAULT_CONFIG }
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    // Not the parser's message: it quotes the file, which can hold the auth token.
    configLogger.warn('Config file {path} is not valid JSON; using defaults', {
      path: configPath,
      bytes: text.length
    })
    return { ...DEFAULT_CONFIG }
  }
  configLogger.debug('Read config file {path}', {
    path: configPath,
    fields: isRecord(raw) ? Object.keys(raw) : []
  })
  return normalizeConfig(raw)
}

export function saveConfigToFile(config: ProxyConfig): void {
  const configPath = getConfigPath()
  const normalized = normalizeConfig(config)
  const tempPath = `${configPath}.tmp`
  try {
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(tempPath, `${JSON.stringify(normalized, null, '\t')}\n`, 'utf-8')
    renameSync(tempPath, configPath)
    configLogger.debug('Saved config file {path}', { path: configPath })
  } catch (error) {
    configLogger.warn('Could not save config file {path} ({code}); changes were not written', {
      path: configPath,
      code: errorCode(error)
    })
    if (existsSync(tempPath)) unlinkSync(tempPath)
  }
}

// ---------------------------------------------------------------------------
// Config -> env vars (for spawning the proxy as a child process)
// ---------------------------------------------------------------------------

export function configToEnv(config: ProxyConfig): Record<string, string> {
  const env: Record<string, string> = {}
  env['PI_PROXY_HOST'] = config.host
  env['PI_PROXY_PORT'] = String(config.port)
  if (config.authToken.length > 0) {
    env['PI_PROXY_AUTH_TOKEN'] = config.authToken
  }
  env['PI_PROXY_REMOTE_IMAGES'] = String(config.remoteImages)
  env['PI_PROXY_MAX_BODY_SIZE'] = String(config.maxBodySizeMb * BYTES_PER_MB)
  env['PI_PROXY_UPSTREAM_TIMEOUT_MS'] = String(config.upstreamTimeoutSec * MS_PER_SECOND)
  env['PI_PROXY_LOG_LEVEL'] = config.logLevel
  // Model exposure settings are read from the shared JSON config file at startup.
  // They are not passed as env vars because the proxy loads the config file directly.
  return env
}
