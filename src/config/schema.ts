/**
 * Proxy configuration schema, defaults and JSON config file I/O: the single source of truth.
 *
 * @remarks
 * Used by both the proxy server and the pi extension. The server reads the JSON config file as
 * defaults, with env vars and CLI args as overrides. The pi extension reads and writes the JSON
 * config file via the /proxy config panel.
 *
 * @packageDocumentation
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { isLogLevel, type LogLevel } from '@logtape/logtape'
import { piAgentDir } from '@proxy/config/agent-dir'
import { proxyLogger } from '@proxy/logging'
import { REASONING_EFFORTS, type ReasoningEffort } from '@proxy/openai/schemas'
import { errorCode, isRecord } from '@proxy/utils/guards'
import * as z from 'zod'

/** Logger for config file reading and repair (`config` category). */
const configLogger = proxyLogger('config')

// ---------------------------------------------------------------------------
// Schema: the values each field accepts, and the source of the config types
// ---------------------------------------------------------------------------

/** Bytes in one mebibyte: converts `maxBodySizeMb` to bytes. */
export const BYTES_PER_MB = 1_048_576
/** Milliseconds in one second: converts `upstreamTimeoutSec` to milliseconds. */
export const MS_PER_SECOND = 1000

/** Highest TCP port. */
const MAX_PORT = 65_535
/** Upper bound of `maxBodySizeMb`. */
const MAX_BODY_SIZE_MB = 500
/** Lower bound of `upstreamTimeoutSec`. */
const MIN_UPSTREAM_TIMEOUT_SEC = 5
/** Upper bound of `upstreamTimeoutSec`. */
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
/** How public model IDs are generated; see {@link PublicModelIdModeSchema}. */
export type PublicModelIdMode = z.infer<typeof PublicModelIdModeSchema>

/**
 * Which models are exposed on the public HTTP API, in the order the settings panel offers them.
 * All modes only expose auth-configured models (pi's getAvailable()).
 *
 * - "scoped": delegates to pi's global `enabledModels` setting (from `/scoped-models` Ctrl+S); with
 *   none set, every available model, as in pi
 * - "all": every available model, no filter
 * - "custom": only the canonical IDs in the proxy's own `customModels`, matched exactly; an empty
 *   list exposes none (#88)
 */
export const ModelExposureModeSchema = z.enum(['scoped', 'all', 'custom'])
/** Which models are exposed; see {@link ModelExposureModeSchema}. */
export type ModelExposureMode = z.infer<typeof ModelExposureModeSchema>

/** "detached" = background daemon, "session" = dies with the pi session. */
export const LifetimeSchema = z.enum(['detached', 'session'])

/** A LogTape log level name (`trace` … `fatal`). */
const LogLevelSchema = z.custom<LogLevel>(
  (value) => typeof value === 'string' && isLogLevel(value),
  { error: 'Not a LogTape log level' }
)

/**
 * A string kept exactly as written. Not `z.string().trim()`: the auth token must match byte for
 * byte, and model IDs and prefix labels decide exposure, which follows the config verbatim.
 */
const VerbatimStringSchema = z.custom<string>(
  (value) => typeof value === 'string',
  'expected a string'
)

/** Model IDs and prefix labels: verbatim, and never empty. */
const VerbatimNameSchema = VerbatimStringSchema.refine(
  (value) => value.length > 0,
  'must not be empty'
)

/**
 * Returns an integer schema with inclusive bounds.
 *
 * @param min - The smallest accepted value.
 * @param max - The largest accepted value.
 * @returns A zod integer schema; {@link clampInt} reads its bounds back.
 */
function boundedInt(min: number, max: number): z.ZodInt {
  return z.int().min(min).max(max)
}

/** The `zed` section of the config: syncing the proxy's models into Zed's settings. */
const ZedSyncConfigSchema = z.object({
  /** Provider label in Zed's `openai_compatible` section. Trimmed; never empty. */
  providerName: z.string().trim().min(1),
  /** Sync models to Zed's settings.json when the config changes. */
  autoSync: z.boolean()
})

/** The `zed` section of the config, as validated. */
export type ZedSyncConfig = z.infer<typeof ZedSyncConfigSchema>

/**
 * The upstream failures an alias's fallback chain can name (#67). A failure before the response
 * starts moves to the next target only when the alias names its class:
 * - `rate_limit`: 429, or a usage limit (a ChatGPT login's Codex limit, #190)
 * - `unavailable`: 503, 529 overloaded, or a provider saying it is out of capacity
 * - `timeout`: 504, or the upstream idle timeout
 * - `auth`: the credential fails (no credential pi can resolve, or the provider's 401 or 403)
 * - `refused`: the login can't run the model (`404 model_not_found`, #156)
 * - `upstream_error`: any other upstream failure, a network failure included
 *
 * A 400 (the request's own fault), the client leaving, and a failure after the stream started
 * never fall back.
 */
export const FailureClassSchema = z.enum([
  'rate_limit',
  'unavailable',
  'timeout',
  'auth',
  'refused',
  'upstream_error'
])
/** One of {@link FailureClassSchema}'s classes. */
export type FailureClass = z.infer<typeof FailureClassSchema>

/**
 * One model an alias runs at a reasoning effort it sets (#230): the request's `reasoning_effort`
 * is replaced by `reasoningEffort` on this model, and the response reports both.
 */
const EffortTargetSchema = z.object({
  model: VerbatimNameSchema,
  reasoningEffort: z.enum(REASONING_EFFORTS)
})

/**
 * A model family an alias follows (#231): the newest exposed model of `family`, a provider and
 * tier keyword (`anthropic/claude-opus`, `openai-codex/sol`), or `pin` while one is set. Optionally
 * at an effort, as {@link EffortTargetSchema}.
 */
const FamilyTargetSchema = z.object({
  family: VerbatimNameSchema,
  pin: VerbatimNameSchema.optional(),
  reasoningEffort: z.enum(REASONING_EFFORTS).optional()
})
/** A family target: see {@link FamilyTargetSchema}. */
export type FamilyTarget = z.infer<typeof FamilyTargetSchema>

/**
 * One of an alias's models: a canonical ID, one with the effort it runs at (#230), or a family
 * that follows the newest model (#231).
 */
const AliasModelSchema = z.union([VerbatimNameSchema, EffortTargetSchema, FamilyTargetSchema])

/**
 * What an alias names (#66, #67): one model, or models tried in order, moving to the next only on
 * the failures `fallbackOn` names (principle VI: the configuration names them). Each model is a
 * canonical ID, `{ model, reasoningEffort }` to run it at that effort (#230), or `{ family, pin?,
 * reasoningEffort? }` to follow a family's newest model (#231).
 */
const AliasTargetSchema = z.union([
  AliasModelSchema,
  z.object({
    targets: z.array(AliasModelSchema).min(1).readonly(),
    fallbackOn: z.array(FailureClassSchema).readonly()
  })
])
/** What an alias names: see {@link AliasTargetSchema}. */
export type AliasTarget = z.infer<typeof AliasTargetSchema>

/** An alias with a fallback chain: `{ targets, fallbackOn }`. */
export type AliasChain = Extract<AliasTarget, { readonly targets: unknown }>

/**
 * Says whether an alias names a fallback chain rather than one model.
 *
 * @param target - what the alias names, as the config holds it
 * @returns whether it is `{ targets, fallbackOn }`
 */
export function isAliasChain(target: AliasTarget): target is AliasChain {
  return typeof target === 'object' && 'targets' in target
}

/** One named model of an alias, whichever way the config wrote it. */
export interface ModelTarget {
  /** The canonical ID, as written. */
  readonly model: string
  /** The effort the alias runs it at, replacing the request's (#230); absent to keep the request's. */
  readonly reasoningEffort?: ReasoningEffort
}

/** One of an alias's targets: a named model, or a family it follows (#231). */
export type AliasModel = ModelTarget | FamilyTarget

/**
 * Says whether an alias target follows a family rather than naming a model.
 *
 * @param target - one of an alias's targets
 * @returns whether it is `{ family, … }`
 */
export function isFamilyTarget(target: AliasModel): target is FamilyTarget {
  return 'family' in target
}

/**
 * Names an alias target for logs, lists and diagnostics: its canonical ID, or its family.
 *
 * @param target - one of an alias's targets
 * @returns the canonical ID, or the family keyword
 */
export function targetName(target: AliasModel): string {
  return isFamilyTarget(target) ? target.family : target.model
}

/**
 * Describes an alias target for `/proxy show` and the console: its canonical ID, or its family
 * with the pin or `(newest)`; the effort is added by the caller.
 *
 * @param target - one of an alias's targets
 * @returns the description
 */
export function targetSummary(target: AliasModel): string {
  if (!isFamilyTarget(target)) return target.model
  return target.pin === undefined
    ? `${target.family} (newest)`
    : `${target.family} (pinned ${target.pin})`
}

/**
 * Lists an alias's targets in order, each with the effort it sets, if any.
 *
 * @param target - what the alias names, as the config holds it
 * @returns its models: one for a single target, the chain's otherwise
 */
export function aliasModels(target: AliasTarget): readonly AliasModel[] {
  const models = isAliasChain(target) ? target.targets : [target]
  return models.map((aliasModel) =>
    typeof aliasModel === 'string' ? { model: aliasModel } : aliasModel
  )
}

/**
 * Reads the failures that move an alias on to its next model.
 *
 * @param target - what the alias names, as the config holds it
 * @returns the chain's `fallbackOn`; none for a single target
 */
export function aliasFallbackOn(target: AliasTarget): readonly FailureClass[] {
  return isAliasChain(target) ? target.fallbackOn : []
}

/**
 * A provider's reserve (#69): the share of a subscription's usage window, from 0 to 1, to keep
 * free. A fallback chain skips a provider with less than this left in any window it reports.
 */
const ReserveShareSchema = z.number().min(0).max(1)

/**
 * How a request moves between a provider's logins (#227): the failure classes that move it from
 * one login of the same model to the next. A rate limit by default: the reason to log in twice.
 */
const LoginsConfigSchema = z.object({
  fallbackOn: z.array(FailureClassSchema).readonly()
})
/** The `routing.logins` section: see {@link LoginsConfigSchema}. */
export type LoginsConfig = z.infer<typeof LoginsConfigSchema>

/**
 * How fallback chains route beyond their aliases: the quota reserve per provider (#69), and how a
 * request moves between a provider's logins (#227).
 */
const RoutingConfigSchema = z.object({
  /** Provider -> the share to keep free (`{ "anthropic": 0.2 }`). Providers left out have none. */
  reserve: z.record(z.string().min(1), ReserveShareSchema).readonly(),
  logins: LoginsConfigSchema
})
/** The `routing` section: see {@link RoutingConfigSchema}. */
export type RoutingConfig = z.infer<typeof RoutingConfigSchema>
/** Provider -> the share of each usage window to keep free, from 0 to 1 (`routing.reserve`). */
export type Reserve = RoutingConfig['reserve']

/** Longest login label the console shows. */
const MAX_LABEL_LENGTH = 40
/** A login label: what the operator calls an account, trimmed, non-empty, short. */
const LabelSchema = z.string().trim().min(1).max(MAX_LABEL_LENGTH)
/** Provider -> its label; see {@link LabelSchema}. */
const LabelsSchema = z.record(z.string().min(1), LabelSchema).readonly()
/** Provider -> the label the console shows beside it (`labels`). */
export type LoginLabels = z.infer<typeof LabelsSchema>

/** The JSON config file's fields and the values each accepts. */
const ProxyConfigSchema = z.object({
  /** Bind address. Surrounding whitespace is a typo; empty means unset. */
  host: z.string().trim().min(1),
  /** Listen port. */
  port: boundedInt(1, MAX_PORT),
  /** Bearer token for proxy auth. Empty string = disabled. */
  authToken: VerbatimStringSchema,
  /** Allow remote image URL fetching. */
  remoteImages: z.boolean(),
  /** Serve the Swagger UI docs page at `/docs` (#129). */
  docsUi: z.boolean(),
  /** Keep per-minute traffic stats in a SQLite file in pi's agent dir, for the console (#216). */
  stats: z.boolean(),
  /** Max request body in MB. */
  maxBodySizeMb: boundedInt(1, MAX_BODY_SIZE_MB),
  /** Seconds the upstream provider may send nothing before a call is aborted. */
  upstreamTimeoutSec: boundedInt(MIN_UPSTREAM_TIMEOUT_SEC, MAX_UPSTREAM_TIMEOUT_SEC),
  lifetime: LifetimeSchema,
  publicModelIdMode: PublicModelIdModeSchema,
  modelExposureMode: ModelExposureModeSchema,
  /** Canonical model IDs to expose when modelExposureMode is "custom". */
  customModels: z.array(VerbatimNameSchema).readonly(),
  /** Provider key -> custom public prefix label. Default prefix = provider key. */
  providerPrefixes: z.record(z.string(), VerbatimNameSchema).readonly(),
  /**
   * Alias -> one canonical ID, or `{ targets, fallbackOn }` (#66, #67). IDs verbatim and never
   * empty: an alias is listed and resolved only while one of its targets is exposed.
   */
  aliases: z.record(z.string().min(1), AliasTargetSchema).readonly(),
  /**
   * Provider -> a label the console shows beside it (#227): which account a login is, in your
   * words (`{ "anthropic-2": "work" }`). Never sent anywhere.
   */
  labels: LabelsSchema,
  /** Lowest log level the proxy writes (LogTape levels). */
  logLevel: LogLevelSchema,
  routing: RoutingConfigSchema,
  zed: ZedSyncConfigSchema
})

/** The proxy's config file contents, every field present and valid. */
export type ProxyConfig = Readonly<z.infer<typeof ProxyConfigSchema>>

/**
 * Checks whether a string names a public model ID mode.
 *
 * @param value - A mode name.
 * @returns Whether `value` is a {@link PublicModelIdMode}.
 */
export function isPublicModelIdMode(value: string): value is PublicModelIdMode {
  return PublicModelIdModeSchema.safeParse(value).success
}

/**
 * Checks whether a string names a model exposure mode.
 *
 * @param value - A mode name.
 * @returns Whether `value` is a {@link ModelExposureMode}.
 */
export function isModelExposureMode(value: string): value is ModelExposureMode {
  return ModelExposureModeSchema.safeParse(value).success
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Each field's value when the config file leaves it out, or sets it invalidly and unclampably. */
export const DEFAULT_CONFIG: Readonly<ProxyConfig> = {
  host: '127.0.0.1',
  port: 4141,
  authToken: '',
  remoteImages: false,
  docsUi: false,
  stats: true,
  maxBodySizeMb: 50,
  upstreamTimeoutSec: 120,
  lifetime: 'detached',
  publicModelIdMode: 'collision-prefixed',
  modelExposureMode: 'scoped',
  customModels: [],
  providerPrefixes: {},
  aliases: {},
  labels: {},
  logLevel: 'info',
  routing: { reserve: {}, logins: { fallbackOn: ['rate_limit'] } },
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
// background proxy: a number is clamped to its bounds (rounded first), a list or map keeps its
// valid entries, anything else takes its default. Each repaired field is named in one warning.

/**
 * Returns a repair function that clamps a number to `schema`'s bounds and rounds it, so the
 * limits live in the schema alone.
 *
 * @param schema - The integer schema whose `minValue`/`maxValue` bound the result.
 * @param fallback - The value for anything that is not a finite number.
 * @returns The repair function.
 */
function clampInt(schema: z.ZodInt, fallback: number): (value: unknown) => number {
  const min = schema.minValue ?? Number.MIN_SAFE_INTEGER
  const max = schema.maxValue ?? Number.MAX_SAFE_INTEGER
  return (value) =>
    typeof value === 'number' && Number.isFinite(value)
      ? Math.max(min, Math.min(max, Math.round(value)))
      : fallback
}

/**
 * Keeps the list entries {@link VerbatimNameSchema} accepts.
 *
 * @param value - The field's raw value.
 * @returns The valid entries; empty when `value` is not an array.
 */
function validNames(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const result: string[] = []
  for (const candidate of value) {
    const parsed = VerbatimNameSchema.safeParse(candidate)
    if (parsed.success) result.push(parsed.data)
  }
  return result
}

/**
 * Keeps the map entries whose value {@link VerbatimNameSchema} accepts.
 *
 * @param value - The field's raw value.
 * @returns The valid entries; empty when `value` is not a plain object.
 */
function validNameEntries(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  const result: Record<string, string> = {}
  for (const [key, candidate] of Object.entries(value)) {
    const parsed = VerbatimNameSchema.safeParse(candidate)
    if (parsed.success) result[key] = parsed.data
  }
  return result
}

/**
 * Returns a repairer that keeps the map entries with a non-empty key and a value `schema` accepts.
 *
 * @typeParam T - The value type.
 * @param schema - The schema each value must pass.
 * @returns The repairer: the valid entries, empty when the value is not a plain object.
 */
function validEntries<T>(schema: z.ZodType<T>): (value: unknown) => Record<string, T> {
  return (value) => {
    if (!isRecord(value)) return {}
    const entries: Record<string, T> = {}
    for (const [key, candidate] of Object.entries(value)) {
      const parsed = schema.safeParse(candidate)
      if (key.length > 0 && parsed.success) entries[key] = parsed.data
    }
    return entries
  }
}

/** Keeps the `aliases` entries the schema accepts: a non-empty name for a valid target. */
const validAliases = validEntries(AliasTargetSchema)
/** Keeps the `routing.reserve` entries the schema accepts: a provider and a share from 0 to 1. */
const validReserves = validEntries(ReserveShareSchema)
/** Keeps the `labels` entries the schema accepts: a provider and a short, non-empty label. */
const validLabels = validEntries(LabelSchema)

/** Reads one field: its value when the schema accepts it, otherwise `repair(value)`. */
type FieldReader<Key extends string> = <T>(
  key: Key,
  schema: z.ZodType<T>,
  repair: (value: unknown) => T
) => T

/**
 * Returns a reader for the fields of one object in the config.
 *
 * @remarks
 * A field that is present but invalid is recorded in `corrected` by its path; a missing one is
 * not, because leaving a field out is how a config takes its default. A `raw` that is present but
 * not an object is recorded as `scope` (or `config`), and all its fields read as missing.
 *
 * @typeParam Key - The field names the reader accepts.
 * @param raw - The object to read, as parsed from JSON.
 * @param corrected - Collects the paths of repaired fields; appended to.
 * @param scope - The object's path in the config; `undefined` for the config itself.
 * @returns The field reader.
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

/** Fields the last warning named: the config is read on every request, so it warns per change. */
let lastCorrections = ''

/**
 * Warns once about the repaired fields, unless the same set was the last one reported.
 *
 * @param corrected - Paths of the repaired fields; empty warns nothing but is remembered too.
 */
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

/**
 * Reads the `zed` section, repairing invalid fields.
 *
 * @param raw - The section's raw value.
 * @param corrected - Collects the paths of repaired fields; appended to.
 * @returns The valid section.
 */
function normalizeZedSyncConfig(raw: unknown, corrected: string[]): ZedSyncConfig {
  const field = fieldReader<keyof ZedSyncConfig>(raw, corrected, 'zed')
  const fields = ZedSyncConfigSchema.shape
  return {
    providerName: field('providerName', fields.providerName, () => DEFAULT_CONFIG.zed.providerName),
    autoSync: field('autoSync', fields.autoSync, () => DEFAULT_CONFIG.zed.autoSync)
  }
}

/**
 * Reads the `routing.logins` section, repairing invalid fields.
 *
 * @param raw - The section's raw value.
 * @param corrected - Collects the paths of repaired fields; appended to.
 * @returns The valid section.
 */
function normalizeLoginsConfig(raw: unknown, corrected: string[]): LoginsConfig {
  const field = fieldReader<keyof LoginsConfig>(raw, corrected, 'routing.logins')
  return {
    fallbackOn: field(
      'fallbackOn',
      LoginsConfigSchema.shape.fallbackOn,
      () => DEFAULT_CONFIG.routing.logins.fallbackOn
    )
  }
}

/**
 * Reads the `routing` section, repairing invalid fields.
 *
 * @param raw - The section's raw value.
 * @param corrected - Collects the paths of repaired fields; appended to.
 * @returns The valid section.
 */
function normalizeRoutingConfig(raw: unknown, corrected: string[]): RoutingConfig {
  const field = fieldReader<keyof RoutingConfig>(raw, corrected, 'routing')
  return {
    reserve: field('reserve', RoutingConfigSchema.shape.reserve, validReserves),
    logins: normalizeLoginsConfig(isRecord(raw) ? raw['logins'] : undefined, corrected)
  }
}

/**
 * Turns any parsed JSON into a valid config: invalid fields are repaired, missing ones defaulted.
 *
 * @remarks
 * Never throws. Warns about repaired fields by name (never by value), once per distinct set.
 *
 * @param raw - The parsed config file, or a config to re-validate.
 * @returns The normalized config.
 */
export function normalizeConfig(raw: unknown): ProxyConfig {
  const corrected: string[] = []
  const field = fieldReader<keyof ProxyConfig>(raw, corrected)
  const fields = ProxyConfigSchema.shape
  const config: ProxyConfig = {
    host: field('host', fields.host, () => DEFAULT_CONFIG.host),
    port: field('port', fields.port, clampInt(fields.port, DEFAULT_CONFIG.port)),
    authToken: field('authToken', fields.authToken, () => DEFAULT_CONFIG.authToken),
    remoteImages: field('remoteImages', fields.remoteImages, () => DEFAULT_CONFIG.remoteImages),
    docsUi: field('docsUi', fields.docsUi, () => DEFAULT_CONFIG.docsUi),
    stats: field('stats', fields.stats, () => DEFAULT_CONFIG.stats),
    maxBodySizeMb: field(
      'maxBodySizeMb',
      fields.maxBodySizeMb,
      clampInt(fields.maxBodySizeMb, DEFAULT_CONFIG.maxBodySizeMb)
    ),
    upstreamTimeoutSec: field(
      'upstreamTimeoutSec',
      fields.upstreamTimeoutSec,
      clampInt(fields.upstreamTimeoutSec, DEFAULT_CONFIG.upstreamTimeoutSec)
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
    customModels: field('customModels', fields.customModels, validNames),
    providerPrefixes: field('providerPrefixes', fields.providerPrefixes, validNameEntries),
    aliases: field('aliases', fields.aliases, validAliases),
    labels: field('labels', fields.labels, validLabels),
    logLevel: field('logLevel', fields.logLevel, () => DEFAULT_CONFIG.logLevel),
    routing: normalizeRoutingConfig(isRecord(raw) ? raw['routing'] : undefined, corrected),
    zed: normalizeZedSyncConfig(isRecord(raw) ? raw['zed'] : undefined, corrected)
  }
  reportCorrections(corrected)
  return config
}

// ---------------------------------------------------------------------------
// JSON config file path
// ---------------------------------------------------------------------------

/**
 * Returns the path of the JSON config file.
 *
 * @remarks
 * The directory is pi's own agent dir ({@link piAgentDir}): `$PI_CODING_AGENT_DIR` when set and
 * non-empty (a leading `~` expanded), otherwise `.pi/agent` in the user's home directory. Reading
 * `HOME` directly made a relative `./~/.pi/agent` when it was unset (#111). It is resolved without
 * importing pi, as the pi extension loads this module in pi's own process (#165).
 *
 * @returns `proxy-config.json` in pi's agent dir
 */
export function getConfigPath(): string {
  return resolve(piAgentDir(), 'proxy-config.json')
}

// ---------------------------------------------------------------------------
// JSON config file I/O
// ---------------------------------------------------------------------------

/**
 * Loads and normalizes the JSON config file.
 *
 * @remarks
 * Never throws: a missing, unreadable or non-JSON file gives a copy of {@link DEFAULT_CONFIG}, with
 * a warning for the last two.
 *
 * @returns The config from the file, or the defaults.
 */
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

/**
 * Reads and parses the config file without normalizing it. Never logs.
 *
 * @returns The parsed JSON, or `undefined` when the file is missing, unreadable or not JSON.
 */
function rawConfigFile(): unknown {
  try {
    return JSON.parse(readFileSync(getConfigPath(), 'utf-8'))
  } catch {
    return undefined
  }
}

/**
 * Picks out an `authToken` that is set but is not a string (`null` included).
 *
 * @param raw - The parsed config file.
 * @returns The invalid value, boxed, or `undefined` when it is absent or a string.
 */
function invalidAuthToken(raw: unknown): { readonly value: unknown } | undefined {
  if (!isRecord(raw) || raw['authToken'] === undefined || typeof raw['authToken'] === 'string') {
    return undefined
  }
  return { value: raw['authToken'] }
}

/**
 * Checks whether the config file sets `authToken` to something that is not a string (#82).
 *
 * @remarks
 * Repairing it to the default '' would mean "auth off": an operator who asked for a token would get
 * an open proxy. So the proxy refuses to start instead. A missing, unreadable or non-JSON file is
 * not this case. Reads the file on every call.
 *
 * @returns Whether the file's `authToken` is present and not a string.
 */
export function configFileAuthTokenInvalid(): boolean {
  return invalidAuthToken(rawConfigFile()) !== undefined
}

/** How `saveConfigToFile` treats an `authToken` the file has but that is not a string (#82). */
export interface SaveConfigOptions {
  /**
   * Replace it with the config's value. Only for an explicit choice (disabling auth, a reset):
   * otherwise the repaired '' would be written, and '' means auth off.
   */
  readonly replaceInvalidAuthToken?: boolean
}

/**
 * Normalizes a config and writes it to the config file atomically (temp file, then rename).
 *
 * @remarks
 * A failure is logged as a warning, not thrown. An `authToken` in the file that is not a string is
 * kept when the config's token is '' unless `options.replaceInvalidAuthToken` is set (#82).
 *
 * @param config - The config to write.
 * @param options - How to treat an invalid `authToken` already in the file.
 * @returns whether the file was written
 */
export function saveConfigToFile(config: ProxyConfig, options: SaveConfigOptions = {}): boolean {
  const configPath = getConfigPath()
  const normalized = normalizeConfig(config)
  // A config loaded from a file with an invalid authToken carries the repaired ''. Writing it would
  // turn auth off for good, so the file's value stays until the user chooses (#82).
  const invalid = invalidAuthToken(rawConfigFile())
  const keepInvalid =
    invalid !== undefined && normalized.authToken === '' && options.replaceInvalidAuthToken !== true
  const written: Record<string, unknown> = keepInvalid
    ? { ...normalized, authToken: invalid.value }
    : normalized
  const tempPath = `${configPath}.tmp`
  try {
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(tempPath, `${JSON.stringify(written, null, '\t')}\n`, 'utf-8')
    renameSync(tempPath, configPath)
    configLogger.debug('Saved config file {path}', { path: configPath })
    return true
  } catch (error) {
    configLogger.warn('Could not save config file {path} ({code}); changes were not written', {
      path: configPath,
      code: errorCode(error)
    })
    if (existsSync(tempPath)) unlinkSync(tempPath)
    return false
  }
}

// ---------------------------------------------------------------------------
// Config -> env vars (for spawning the proxy as a child process)
// ---------------------------------------------------------------------------

/**
 * Builds the env vars the pi extension passes to the proxy it spawns.
 *
 * @remarks
 * Covers host, port, auth token (only when non-empty), remote images, the docs UI, body size,
 * upstream timeout and log level. Not `lifetime` or `zed` (extension-only). Not
 * `PI_SWITCHBOARD_AGENTIC` either, on
 * purpose: agentic mode is not built, the variable only reaches the startup log, and the
 * extension has no setting for it.
 *
 * @param config - The config to translate.
 * @returns Env var names and values.
 */
export function configToEnv(config: ProxyConfig): Record<string, string> {
  const env: Record<string, string> = {}
  env['PI_SWITCHBOARD_HOST'] = config.host
  env['PI_SWITCHBOARD_PORT'] = String(config.port)
  if (config.authToken.length > 0) {
    env['PI_SWITCHBOARD_AUTH_TOKEN'] = config.authToken
  }
  env['PI_SWITCHBOARD_REMOTE_IMAGES'] = String(config.remoteImages)
  env['PI_SWITCHBOARD_DOCS_UI'] = String(config.docsUi)
  env['PI_SWITCHBOARD_STATS'] = String(config.stats)
  env['PI_SWITCHBOARD_MAX_BODY_SIZE'] = String(config.maxBodySizeMb * BYTES_PER_MB)
  env['PI_SWITCHBOARD_UPSTREAM_TIMEOUT_MS'] = String(config.upstreamTimeoutSec * MS_PER_SECOND)
  env['PI_SWITCHBOARD_LOG_LEVEL'] = config.logLevel
  // Model exposure settings are not passed: the proxy reads them from the shared JSON config file,
  // at startup and again on every request (`fileConfigReader` in src/server/routes.ts).
  return env
}
