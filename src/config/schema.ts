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
import { errorCode, isRecord, parseJsonOrUndefined } from '@proxy/utils/guards'
import { MS_PER_SECOND } from '@proxy/utils/time'
import * as z from 'zod'

/** Logger for config file reading and repair (`config` category). */
const configLogger = proxyLogger('config')

// ---------------------------------------------------------------------------
// Schema: the values each field accepts, and the source of the config types
// ---------------------------------------------------------------------------

/** Bytes in one mebibyte: converts `maxBodySizeMb` to bytes. */
export const BYTES_PER_MB = 1_048_576

/** Highest TCP port. */
export const MAX_PORT = 65_535
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
 * @returns A zod integer schema; {@link intBounds} reads its bounds back.
 */
function boundedInt(min: number, max: number): z.ZodInt {
  return z.int().min(min).max(max)
}

/** The inclusive bounds of an integer schema. */
export interface IntBounds {
  /** The smallest accepted value. */
  readonly min: number
  /** The largest accepted value. */
  readonly max: number
}

/**
 * Reads an integer schema's bounds back, for clamping to them and for naming them in a message.
 *
 * @param schema - The integer schema, from {@link boundedInt} or `z.int()`.
 * @returns Its bounds; a side the schema leaves open is the safe-integer limit.
 */
export function intBounds(schema: z.ZodInt): IntBounds {
  return {
    min: schema.minValue ?? Number.MIN_SAFE_INTEGER,
    max: schema.maxValue ?? Number.MAX_SAFE_INTEGER
  }
}

/** An integer written out in decimal digits, and nothing else. */
const DECIMAL_DIGITS = /^\d+$/

/**
 * Parses an integer from text an operator wrote (an env var, a CLI flag, a PID file) against a
 * schema's bounds.
 *
 * @remarks
 * Only decimal digits, around which whitespace is allowed: `80abc` is refused, where
 * `Number.parseInt` would read 80, and so are `0x50` and `8e1`, which `Number` would read as 80.
 *
 * @param text - The text to parse.
 * @param schema - The integer schema the value must satisfy.
 * @returns The integer, or `undefined` when the text is not one within the schema's bounds.
 */
export function parseIntText(text: string, schema: z.ZodInt): number | undefined {
  const trimmed = text.trim()
  if (!DECIMAL_DIGITS.test(trimmed)) return undefined
  const parsed = schema.safeParse(Number(trimmed))
  return parsed.success ? parsed.data : undefined
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
const EffortTargetSchema = z
  .object({
    model: VerbatimNameSchema,
    reasoningEffort: z.enum(REASONING_EFFORTS)
  })
  .strict()

/**
 * A model family an alias follows (#231): the newest exposed model of `family`, a provider and
 * tier keyword (`anthropic/claude-opus`, `openai-codex/sol`), or `pin` while one is set. Optionally
 * at an effort, as {@link EffortTargetSchema}.
 */
const FamilyTargetSchema = z
  .object({
    family: VerbatimNameSchema,
    pin: VerbatimNameSchema.optional(),
    reasoningEffort: z.enum(REASONING_EFFORTS).optional()
  })
  .strict()
/** A family target: see {@link FamilyTargetSchema}. */
export type FamilyTarget = z.infer<typeof FamilyTargetSchema>

/**
 * One of an alias's models: a canonical ID, one with the effort it runs at (#230), or a family
 * that follows the newest model (#231). Both object forms are strict, so an entry mixing their
 * keys (`{ model, family }`) matches neither and is dropped with the config warning, rather than
 * read as one of them with the other's key ignored.
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

/** A login's provider ID (`anthropic`, `anthropic-2`), as `routing.logins` names it. */
const LoginNameSchema = z.string().trim().min(1)
/** Logins in the order routing tries them, first first (`routing.logins.order`'s values). */
const LoginListSchema = z.array(LoginNameSchema).readonly()

/**
 * How a request moves between a provider's logins (#227): the failure classes that move it from
 * one login of the same model to the next (a rate limit by default: the reason to log in twice),
 * the logins a provider tries first (#233), and the logins routing never calls (#233).
 */
const LoginsConfigSchema = z.object({
  fallbackOn: z.array(FailureClassSchema).readonly(),
  /**
   * Base provider -> its logins to try first, in order (`{ "anthropic": ["anthropic-2"] }`).
   * Logins left out follow in the usual order: the base, then `-2`, `-3` by number.
   */
  order: z.record(z.string().trim().min(1), LoginListSchema).readonly(),
  /** Logins routing never calls; each keeps its credential in pi's store. */
  disabled: LoginListSchema
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
export const ProxyConfigSchema = z.object({
  /** Bind address. Surrounding whitespace is a typo; empty means unset. */
  host: z.string().trim().min(1),
  /** Listen port. */
  port: boundedInt(1, MAX_PORT),
  /** Bearer token for proxy auth. Empty string = disabled. */
  authToken: VerbatimStringSchema,
  /**
   * Refuse requests a web page could send (#188): a `Host` a DNS-rebinding page would use, or an
   * `Origin` other than the proxy's own. Off by default.
   */
  hostOriginGuard: z.boolean(),
  /** Allow remote image URL fetching. */
  remoteImages: z.boolean(),
  /** Serve the Swagger UI docs page at `/docs` (#129). */
  docsUi: z.boolean(),
  /** Answer the experimental Responses API, `POST /v1/responses` (#140); off by default. */
  responsesApi: z.boolean(),
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
  hostOriginGuard: false,
  remoteImages: false,
  docsUi: false,
  responsesApi: false,
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
  routing: { reserve: {}, logins: { fallbackOn: ['rate_limit'], order: {}, disabled: [] } },
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
  const { min, max } = intBounds(schema)
  return (value) =>
    typeof value === 'number' && Number.isFinite(value)
      ? Math.max(min, Math.min(max, Math.round(value)))
      : fallback
}

/**
 * Returns an integer schema with another's bounds scaled to a different unit.
 *
 * @param schema - The schema whose bounds to scale.
 * @param factor - What one of the schema's units is in the new unit.
 * @returns A zod integer schema bounded by `min * factor` and `max * factor`.
 */
function scaledInt(schema: z.ZodInt, factor: number): z.ZodInt {
  const { min, max } = intBounds(schema)
  return boundedInt(min * factor, max * factor)
}

/**
 * `PI_SWITCHBOARD_MAX_BODY_SIZE`, in bytes: `maxBodySizeMb`'s bounds, so the env var accepts
 * exactly the sizes the config file does.
 */
export const MaxBodySizeBytesSchema = scaledInt(ProxyConfigSchema.shape.maxBodySizeMb, BYTES_PER_MB)

/**
 * `PI_SWITCHBOARD_UPSTREAM_TIMEOUT_MS`, in milliseconds: `upstreamTimeoutSec`'s bounds, so the env
 * var accepts exactly the waits the config file does.
 */
export const UpstreamTimeoutMsSchema = scaledInt(
  ProxyConfigSchema.shape.upstreamTimeoutSec,
  MS_PER_SECOND
)

/**
 * Returns a repairer that keeps the list entries `schema` accepts.
 *
 * @typeParam T - The entry type.
 * @param schema - The schema each entry must pass.
 * @returns The repairer: the valid entries, empty when the value is not an array.
 */
function validList<T>(schema: z.ZodType<T>): (value: unknown) => T[] {
  return (value) => {
    if (!Array.isArray(value)) return []
    const result: T[] = []
    for (const candidate of value) {
      const parsed = schema.safeParse(candidate)
      if (parsed.success) result.push(parsed.data)
    }
    return result
  }
}

/** Keeps the list entries {@link VerbatimNameSchema} accepts. */
const validNames = validList(VerbatimNameSchema)
/** Keeps the login names `routing.logins` accepts: non-empty, trimmed. */
const validLogins = validList(LoginNameSchema)

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
/** Keeps the `routing.logins.order` entries with a provider and a list: each list's valid logins. */
const validLoginOrder = validEntries(z.array(z.unknown()).transform(validLogins))

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
  const fields = LoginsConfigSchema.shape
  return {
    fallbackOn: field(
      'fallbackOn',
      fields.fallbackOn,
      () => DEFAULT_CONFIG.routing.logins.fallbackOn
    ),
    order: field('order', fields.order, validLoginOrder),
    disabled: field('disabled', fields.disabled, validLogins)
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
    hostOriginGuard: field(
      'hostOriginGuard',
      fields.hostOriginGuard,
      () => DEFAULT_CONFIG.hostOriginGuard
    ),
    remoteImages: field('remoteImages', fields.remoteImages, () => DEFAULT_CONFIG.remoteImages),
    docsUi: field('docsUi', fields.docsUi, () => DEFAULT_CONFIG.docsUi),
    responsesApi: field('responsesApi', fields.responsesApi, () => DEFAULT_CONFIG.responsesApi),
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
 * Why a config file that exists cannot be used: it could not be read (`unreadable`, with the fs
 * error code) or it is not valid JSON (`not-json`).
 */
export type ConfigFileProblem =
  | { readonly problem: 'unreadable'; readonly code: string }
  | { readonly problem: 'not-json' }

/**
 * The config file as it is on disk: absent, present but unusable, or parsed (not yet normalized).
 */
type ConfigFileContents =
  | { readonly kind: 'absent' }
  | ({ readonly kind: 'unusable' } & ConfigFileProblem)
  | { readonly kind: 'parsed'; readonly value: unknown; readonly bytes: number }

/**
 * Reads and parses the config file without normalizing it. Never throws and never logs: the
 * callers decide what each outcome means and what to say about it.
 *
 * @returns The file's contents, or why there are none.
 */
function readConfigFile(): ConfigFileContents {
  const configPath = getConfigPath()
  if (!existsSync(configPath)) return { kind: 'absent' }
  let text: string
  try {
    text = readFileSync(configPath, 'utf-8')
  } catch (error) {
    return { kind: 'unusable', problem: 'unreadable', code: errorCode(error) }
  }
  const value = parseJsonOrUndefined(text)
  if (value === undefined) return { kind: 'unusable', problem: 'not-json' }
  return { kind: 'parsed', value, bytes: text.length }
}

/**
 * Loads and normalizes the JSON config file.
 *
 * @remarks
 * Never throws: a missing, unreadable or non-JSON file gives a copy of {@link DEFAULT_CONFIG}, with
 * a warning for the last two. Whether the proxy may start on those defaults is decided by the
 * caller: `loadConfig` refuses when the file exists but cannot be used and no flag or env var
 * sets the token ({@link configFileProblem}), since the file may hold a token the proxy cannot see.
 *
 * @returns The config from the file, or the defaults.
 */
export function loadConfigFromFile(): ProxyConfig {
  const configPath = getConfigPath()
  const contents = readConfigFile()
  if (contents.kind === 'absent') {
    configLogger.debug('No config file at {path}; using defaults', { path: configPath })
    return { ...DEFAULT_CONFIG }
  }
  if (contents.kind === 'unusable') {
    if (contents.problem === 'unreadable') {
      configLogger.warn('Could not read config file {path} ({code}); using defaults', {
        path: configPath,
        code: contents.code
      })
    } else {
      // Not the parser's message: it quotes the file, which can hold the auth token.
      configLogger.warn('Config file {path} is not valid JSON; using defaults', {
        path: configPath
      })
    }
    return { ...DEFAULT_CONFIG }
  }
  configLogger.debug('Read config file {path}', {
    path: configPath,
    bytes: contents.bytes,
    fields: isRecord(contents.value) ? Object.keys(contents.value) : []
  })
  return normalizeConfig(contents.value)
}

/**
 * Reads and parses the config file without normalizing it. Never logs.
 *
 * @returns The parsed JSON, or `undefined` when the file is missing, unreadable or not JSON.
 */
function rawConfigFile(): unknown {
  const contents = readConfigFile()
  return contents.kind === 'parsed' ? contents.value : undefined
}

/**
 * Checks whether the config file exists but cannot be used: it cannot be read, or it is not valid
 * JSON.
 *
 * @remarks
 * Such a file may hold an `authToken` the proxy cannot see. Starting on the defaults would turn
 * that token into auth off, so `loadConfig` refuses to start instead when neither the flag nor
 * `PI_SWITCHBOARD_AUTH_TOKEN` sets a token (CONSTITUTION principle II's exception). A missing file is not
 * this case: it holds nothing. Reads the file on every call.
 *
 * @returns Why the file cannot be used, or `undefined` when it is absent or parsed.
 */
export function configFileProblem(): ConfigFileProblem | undefined {
  const contents = readConfigFile()
  if (contents.kind !== 'unusable') return undefined
  return contents.problem === 'unreadable'
    ? { problem: 'unreadable', code: contents.code }
    : { problem: 'not-json' }
}

/**
 * Words a {@link ConfigFileProblem} for a log line or notification: `cannot be read (EACCES)` or
 * `is not valid JSON`. Never the parser's message, which quotes the file.
 *
 * @param file - why the config file cannot be used
 * @returns the wording, to follow "the file …"
 */
export function describeConfigFileProblem(file: ConfigFileProblem): string {
  if (file.problem === 'unreadable') return `cannot be read (${file.code})`
  return 'is not valid JSON'
}

/**
 * Picks out an `authToken` that is set but is not a string (`null` included), by the schema's
 * own field, so the two never disagree (#254).
 *
 * @param raw - The parsed config file.
 * @returns The invalid value, boxed, or `undefined` when it is absent or a string.
 */
function invalidAuthToken(raw: unknown): { readonly value: unknown } | undefined {
  const value = isRecord(raw) ? raw['authToken'] : undefined
  const parsed = ProxyConfigSchema.shape.authToken.optional().safeParse(value)
  return parsed.success ? undefined : { value }
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

/** How `saveConfigToFile` treats a file it would write over. */
export interface SaveConfigOptions {
  /**
   * Replace an `authToken` the file has that is not a string (#82) with the config's value. Only
   * for an explicit choice (disabling auth, a reset): otherwise the repaired '' would be written,
   * and '' means auth off.
   */
  readonly replaceInvalidAuthToken?: boolean
  /**
   * Write over a file that exists but can't be read or isn't valid JSON (#288). Only for a reset:
   * such a file loads as the defaults, so any other save would replace what it holds, a token
   * included, with them.
   */
  readonly replaceUnusableFile?: boolean
}

/**
 * Normalizes a config and writes it to the config file atomically (temp file, then rename).
 *
 * @remarks
 * A failure is logged as a warning, not thrown. An `authToken` in the file that is not a string is
 * kept when the config's token is '' unless `options.replaceInvalidAuthToken` is set (#82). A file
 * that exists but can't be read or parsed is not written over unless `options.replaceUnusableFile`
 * is set: the config came from the defaults it loads as, not from the file (#288).
 *
 * @param config - The config to write.
 * @param options - How to treat an invalid `authToken` or an unusable file already there.
 * @returns whether the file was written
 */
export function saveConfigToFile(config: ProxyConfig, options: SaveConfigOptions = {}): boolean {
  const configPath = getConfigPath()
  const problem = configFileProblem()
  if (problem !== undefined && options.replaceUnusableFile !== true) {
    configLogger.warn('Not saving to {path}: it {problem}; fix or remove it first', {
      path: configPath,
      problem: describeConfigFileProblem(problem)
    })
    return false
  }
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
 * Covers host, port, auth token (only when non-empty), the host/origin guard, remote images, the
 * docs UI, the Responses API, stats, body size, upstream timeout and log level. Not `lifetime` or
 * `zed` (extension-only).
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
  env['PI_SWITCHBOARD_HOST_ORIGIN_GUARD'] = String(config.hostOriginGuard)
  env['PI_SWITCHBOARD_REMOTE_IMAGES'] = String(config.remoteImages)
  env['PI_SWITCHBOARD_DOCS_UI'] = String(config.docsUi)
  env['PI_SWITCHBOARD_RESPONSES_API'] = String(config.responsesApi)
  env['PI_SWITCHBOARD_STATS'] = String(config.stats)
  env['PI_SWITCHBOARD_MAX_BODY_SIZE'] = String(config.maxBodySizeMb * BYTES_PER_MB)
  env['PI_SWITCHBOARD_UPSTREAM_TIMEOUT_MS'] = String(config.upstreamTimeoutSec * MS_PER_SECOND)
  env['PI_SWITCHBOARD_LOG_LEVEL'] = config.logLevel
  // Model exposure settings are not passed: the proxy reads them from the shared JSON config file,
  // at startup and again on every request (`fileConfigReader` in src/server/routes.ts).
  return env
}

/** An IPv4 address in `127.0.0.0/8`, written out in full. */
const LOOPBACK_IPV4 = /^127(?:\.\d{1,3}){3}$/

/**
 * Checks whether a bind address only accepts connections from this machine.
 *
 * @param host - The bind address.
 * @returns Whether `host` is `localhost`, `::1` or an address in `127.0.0.0/8`; a name that only
 *   starts with `127.` (`127.evil.example`) is not, since it can resolve anywhere.
 */
export function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || LOOPBACK_IPV4.test(host)
}

/**
 * Says who can use the proxy while proxy auth is off (#188): every warning about auth off words it
 * the same way. On loopback, other programs on this machine, and web pages open in a browser
 * (DNS rebinding, cross-origin posts) unless the host/origin guard is on; beyond loopback, anyone
 * on the network, whom the guard does not stop.
 *
 * @param host - The bind address.
 * @param hostOriginGuard - Whether the host/origin guard is on.
 * @returns The risk, as a clause with no capital or final stop.
 */
export function authOffRisk(host: string, hostOriginGuard: boolean): string {
  if (isLoopbackHost(host)) {
    return hostOriginGuard
      ? 'any program on this machine can use your provider logins through it (the host/origin guard keeps web pages out)'
      : 'any program on this machine, and any web page open in a browser on it, can use your provider logins through it'
  }
  return hostOriginGuard
    ? 'anyone who can reach it on the network can use your provider logins (the host/origin guard keeps web pages out, not them)'
    : 'anyone who can reach it on the network, and any web page open in a browser on this machine, can use your provider logins'
}
