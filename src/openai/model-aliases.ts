/**
 * Aliases: names a user defines for exposed models, in `proxy-config.json`'s `aliases` (#66).
 *
 * @remarks
 * Most clients only let you choose a model name, so a name is the one routing control every
 * client has. An alias maps a name to an exposed model's canonical ID, or to several tried in order
 * (#67), used exactly as written:
 * - **Listed and resolved only while a target is exposed**, so an alias never reaches a model
 *   the exposure config hides (CONSTITUTION.md, principle IV). Each target that is not exposed is
 *   reported and skipped.
 * - **Listed as its first exposed target.** A fallback chain's other exposed targets are kept,
 *   in order, for the chat route (`src/server/chat-dispatch.ts`).
 * - **Never shadows a model.** An alias named like an exposed public or canonical ID is left out,
 *   and the model keeps its name. `/healthz/models` reports it and answers 503.
 * - **Runs a target at the effort it sets** (#230): `{ model, reasoningEffort }` replaces the
 *   request's `reasoning_effort` on that model. An effort the model doesn't support is a
 *   configuration error, never clamped: the target is left out (`effort-unsupported`), and
 *   `/healthz/models` answers 503.
 * - **Follows a family's newest model** (#231): `{ family }` resolves, on every computation, to
 *   the newest exposed member (`src/openai/model-families.ts`), or to its `pin`. A move is logged
 *   at warning, once, with the old and the new model. A family no rule knows (`family-unknown`)
 *   and a pin outside its family (`pin-outside-family`) are configuration errors; a hidden or
 *   logged-out pin is `target-not-exposed`, never the newest instead.
 * - **Resolved last:** public ID, then canonical ID, then alias (`resolveExposedModel`).
 *
 * @packageDocumentation
 */

import {
  type AliasModel,
  type AliasTarget,
  aliasFallbackOn,
  aliasModels,
  type FamilyTarget,
  isAliasChain,
  type ModelTarget,
  isFamilyTarget,
  targetName
} from '@proxy/config/schema'
import { proxyLogger } from '@proxy/logging'
import { effortsOfLevels, type ThinkingLevelsOf } from '@proxy/openai/effort-levels'
import type { ExposedModel } from '@proxy/openai/model-exposure'
import { compareVersions, type FamilyScan, scanFamily } from '@proxy/openai/model-families'
import * as z from 'zod'

/** Logger for model exposure, which aliases are part of. */
const exposureLogger = proxyLogger('openai', 'exposure')

/**
 * Why an alias is not exposed. `/healthz/models` lists these; the schema documents that response
 * and is never parsed.
 */
export const aliasDiagnosticSchema = z.object({
  code: z.enum([
    'shadows-model',
    'target-not-exposed',
    'effort-unsupported',
    'family-unknown',
    'pin-outside-family',
    'family-unparsed'
  ]),
  alias: z.string().trim().meta({ description: 'The alias, as written.' }),
  target: z
    .string()
    .trim()
    .meta({
      description:
        'The canonical ID or family it names, as written; for `family-unparsed`, a member pi has ' +
        '(exposed or hidden) whose version the family rule cannot read.'
    }),
  message: z.string().trim()
})

/** Why an alias is not exposed. */
export type AliasDiagnostic = z.infer<typeof aliasDiagnosticSchema>

/** The diagnostics that say the config is wrong, which make `/healthz/models` answer 503. */
export const MISCONFIGURED_ALIAS: ReadonlySet<AliasDiagnostic['code']> = new Set([
  'shadows-model',
  'effort-unsupported',
  'family-unknown',
  'pin-outside-family'
])

/** What a family target resolves to now (#231). `/healthz/models` lists these; never parsed. */
export const familyResolutionSchema = z.object({
  alias: z.string().trim().meta({ description: 'The alias, as written.' }),
  position: z.int().nonnegative().meta({ description: "The target's place in the alias, from 0." }),
  family: z.string().trim().meta({ description: 'The family it follows, as written.' }),
  pin: z.string().trim().nullable().meta({ description: 'The canonical ID it is pinned to.' }),
  resolved: z.string().trim().nullable().meta({
    description: 'The canonical ID it serves now: the pin, else the newest exposed member.'
  }),
  newest: z.string().trim().nullable().meta({ description: 'The newest exposed member.' }),
  newerHidden: z.string().trim().nullable().meta({
    description:
      'A newer member pi has that the exposure config hides; the alias honours the hiding.'
  })
})

/** What a family target resolves to now. */
export type FamilyResolution = z.infer<typeof familyResolutionSchema>

/** What exposing the aliases looks the targets up in. */
export interface AliasLookup {
  readonly byPublicId: ReadonlyMap<string, ExposedModel>
  readonly byCanonicalId: ReadonlyMap<string, ExposedModel>
  /** Every available model's canonical ID, exposed or not: to note a hidden newer member. */
  readonly availableIds: readonly string[]
  /** pi's `getSupportedThinkingLevels`, to check a target's effort (#230). */
  readonly thinkingLevels: ThinkingLevelsOf
}

/** The exposed aliases, and why any others are not. */
export interface ExposedAliases {
  /** Each exposed alias, as its target with the alias as the public ID, in config order. */
  readonly aliases: readonly ExposedModel[]
  /** Alias -> its entry in {@link ExposedAliases.aliases}. */
  readonly byAlias: ReadonlyMap<string, ExposedModel>
  readonly diagnostics: readonly AliasDiagnostic[]
  /** What each family target resolves to now (#231). */
  readonly families: readonly FamilyResolution[]
}

/**
 * The model each family target last resolved to, by alias and place: a move is logged once.
 * Exposure is computed per request, and by `/healthz/models` and the console besides.
 *
 * @remarks
 * Per process, and keyed by alias name: it assumes one proxy config per process, as the server and
 * the console have. The pi extension computes exposure in pi's own process from the same file, so
 * its record follows the same moves. Tests that move an alias use a name no other test uses.
 */
const lastResolved = new Map<string, string>()

/**
 * Logs a family target that resolves to another model than last time: at warning, since the
 * model a client is billed on changed without a config edit (principle VI). The first resolution
 * is only recorded; a pinned target never moves.
 *
 * @param resolution - what the target resolves to now
 */
function noteMove(resolution: FamilyResolution): void {
  const key = `${resolution.alias}\u0000${String(resolution.position)}`
  if (resolution.pin !== null) {
    lastResolved.delete(key)
    return
  }
  const { resolved } = resolution
  if (resolved === null) return
  const previous = lastResolved.get(key)
  lastResolved.set(key, resolved)
  if (previous === undefined || previous === resolved) return
  exposureLogger.warn('Alias {alias} now follows {family} to {model}, not {previousModel}', {
    alias: resolution.alias,
    family: resolution.family,
    model: resolved,
    previousModel: previous
  })
}

/** The aliases each warning last named, by diagnostic code: exposure is computed per request. */
const lastWarned: Partial<Record<AliasDiagnostic['code'], string>> = {}

/**
 * Warns about the aliases with one kind of configuration error, once per distinct set.
 *
 * @param diagnostics - this computation's alias diagnostics
 * @param code - the kind to warn about
 * @param message - the warning, with an `{aliases}` placeholder
 */
function warnOnce(
  diagnostics: readonly AliasDiagnostic[],
  code: AliasDiagnostic['code'],
  message: string
): void {
  const named = diagnostics
    .filter((diagnostic) => diagnostic.code === code)
    .map((diagnostic) => diagnostic.alias)
  const key = JSON.stringify(named)
  // Nothing warned yet is the empty set; a set that clears and comes back is warned again.
  if (key === (lastWarned[code] ?? '[]')) return
  lastWarned[code] = key
  if (named.length === 0) return
  exposureLogger.warn(message, { aliasCount: named.length, aliases: named })
}

/**
 * Exposes the configured aliases with an exposed target.
 *
 * @param aliases - alias -> one canonical ID, or `{ targets, fallbackOn }`, from the config
 * @param lookup - the exposed models, every available model's ID, and pi's thinking levels
 * @returns the exposed aliases, a diagnostic for each alias or target left out, and what each
 *   family target resolves to
 */
export function exposeAliases(
  aliases: Readonly<Record<string, AliasTarget>>,
  lookup: AliasLookup
): ExposedAliases {
  const { byPublicId, byCanonicalId } = lookup
  const exposed: ExposedModel[] = []
  const byAlias = new Map<string, ExposedModel>()
  const diagnostics: AliasDiagnostic[] = []
  const families: FamilyResolution[] = []
  for (const [alias, target] of Object.entries(aliases)) {
    const targets = aliasModels(target)
    if (byPublicId.has(alias) || byCanonicalId.has(alias)) {
      diagnostics.push({
        code: 'shadows-model',
        alias,
        target: targets.map(targetName).join(', '),
        message: `Alias "${alias}" is an exposed model's ID; that model keeps it and the alias is ignored. Rename the alias.`
      })
      continue
    }
    const candidates = exposedTargets(alias, targets, lookup, { diagnostics, families })
    const [first] = candidates
    if (first === undefined) continue
    const entry: ExposedModel = isAliasChain(target)
      ? {
          ...first,
          publicId: alias,
          alias,
          route: { candidates, fallbackOn: aliasFallbackOn(target) }
        }
      : { ...first, publicId: alias, alias }
    exposed.push(entry)
    byAlias.set(alias, entry)
  }
  warnOnce(
    diagnostics,
    'shadows-model',
    'Ignoring aliases named like an exposed model, which keeps its name: {aliases}. Rename them'
  )
  warnOnce(
    diagnostics,
    'effort-unsupported',
    'Leaving out alias targets set to a reasoning effort their model does not support: {aliases}'
  )
  warnOnce(
    diagnostics,
    'family-unknown',
    'Leaving out alias targets naming a model family no rule knows: {aliases}'
  )
  warnOnce(
    diagnostics,
    'pin-outside-family',
    'Leaving out alias targets pinned to a model outside their family: {aliases}'
  )
  for (const resolution of families) noteMove(resolution)
  if (diagnostics.length > 0) {
    exposureLogger.debug('{diagnosticCount} aliases are not exposed', {
      diagnosticCount: diagnostics.length,
      diagnostics
    })
  }
  return { aliases: exposed, byAlias, diagnostics, families }
}

/** Where exposing an alias's targets reports: its diagnostics and its family resolutions. */
interface TargetReports {
  readonly diagnostics: AliasDiagnostic[]
  readonly families: FamilyResolution[]
}

/** One target's place: its alias, and its index in the alias's targets. */
interface TargetPlace {
  readonly alias: string
  readonly position: number
}

/**
 * Scans a family among the exposed and the available models, reporting a family no rule knows
 * and each member whose version can't be read.
 *
 * @param alias - the alias
 * @param family - the family it follows
 * @param lookup - the exposed models and every available model's ID
 * @param diagnostics - receives the diagnostics; appended to
 * @returns the family's exposed and available members, or `undefined` for an unknown family
 */
function scanBoth(
  alias: string,
  family: string,
  lookup: AliasLookup,
  diagnostics: AliasDiagnostic[]
): { readonly exposed: FamilyScan; readonly available: FamilyScan } | undefined {
  const exposed = scanFamily(family, lookup.byCanonicalId.keys())
  const available = scanFamily(family, lookup.availableIds)
  if (exposed === undefined || available === undefined) {
    diagnostics.push({
      code: 'family-unknown',
      alias,
      target: family,
      message: `Alias "${alias}" follows "${family}", which is not a family the proxy knows (provider/tier, such as anthropic/claude-opus).`
    })
    return undefined
  }
  for (const unparsed of available.unparsed) {
    diagnostics.push({
      code: 'family-unparsed',
      alias,
      target: unparsed,
      message: `"${unparsed}" is in ${family}, but its version can't be read from its ID, so alias "${alias}" never picks it.`
    })
  }
  return { exposed, available }
}

/**
 * Finds the newest member pi has that the exposure config hides, when it is newer than every
 * exposed one.
 *
 * @param exposed - the family's exposed members
 * @param available - the family's available members, exposed or not
 * @returns its canonical ID, or `null`
 */
function newerHidden(exposed: FamilyScan, available: FamilyScan): string | null {
  const [newest] = exposed.members
  const [newestAvailable] = available.members
  if (newestAvailable === undefined) return null
  if (newest !== undefined && compareVersions(newestAvailable.version, newest.version) <= 0) {
    return null
  }
  return newestAvailable.canonicalId
}

/**
 * Resolves a family target to the model it serves now: its pin, else the family's newest exposed
 * member. Records the resolution, and a diagnostic for anything left out.
 *
 * @param place - the alias and the target's place in it
 * @param target - the family target
 * @param lookup - the exposed models and every available model's ID
 * @param reports - receives the resolution and any diagnostic; appended to
 * @returns the canonical ID it serves, or `undefined` when there is none
 */
function resolveFamily(
  place: TargetPlace,
  target: FamilyTarget,
  lookup: AliasLookup,
  reports: TargetReports
): string | undefined {
  const { alias } = place
  const { family } = target
  const scans = scanBoth(alias, family, lookup, reports.diagnostics)
  if (scans === undefined) return undefined
  const pin = target.pin ?? null
  // Membership is by the family's rule, whether or not the pin is available now.
  if (pin !== null && scanFamily(family, [pin])?.all.length !== 1) {
    reports.diagnostics.push({
      code: 'pin-outside-family',
      alias,
      target: pin,
      message: `Alias "${alias}" is pinned to "${pin}", which is not in ${family}.`
    })
    return undefined
  }
  const newest = scans.exposed.members[0]?.canonicalId ?? null
  const wanted = pin ?? newest
  const resolved = wanted !== null && lookup.byCanonicalId.has(wanted) ? wanted : null
  reports.families.push({
    ...place,
    family,
    pin,
    resolved,
    newest,
    newerHidden: newerHidden(scans.exposed, scans.available)
  })
  if (resolved !== null) return resolved
  // Exposed members that are only snapshots or unreadable IDs: say why none of them is picked.
  const unpickable =
    scans.exposed.all.length > 0
      ? ' Dated snapshots and IDs without a readable version are never picked; pin one to use it.'
      : ''
  reports.diagnostics.push({
    code: 'target-not-exposed',
    alias,
    target: pin ?? family,
    message:
      pin === null
        ? `Alias "${alias}" follows ${family}, which has no exposed model it can pick.${unpickable}`
        : `Alias "${alias}" is pinned to "${pin}", which is not exposed; it does not follow ${family} meanwhile.`
  })
  return undefined
}

/**
 * Looks an alias's targets up among the exposed models, in order, reporting each one that is not,
 * or that is set to an effort its model doesn't support. A family target is first resolved to
 * the model it serves now.
 *
 * @param alias - the alias
 * @param targets - its targets, as written
 * @param lookup - the exposed models, every available model's ID, and pi's thinking levels
 * @param reports - receives a diagnostic per target left out, and each family resolution
 * @returns the exposed targets, in the alias's order, each with the effort it runs at
 */
function exposedTargets(
  alias: string,
  targets: readonly AliasModel[],
  lookup: AliasLookup,
  reports: TargetReports
): ExposedModel[] {
  const candidates: ExposedModel[] = []
  for (const [position, aliasTarget] of targets.entries()) {
    const model = isFamilyTarget(aliasTarget)
      ? resolveFamily({ alias, position }, aliasTarget, lookup, reports)
      : aliasTarget.model
    if (model === undefined) continue
    const { reasoningEffort } = aliasTarget
    const candidate = withEffort(
      alias,
      reasoningEffort === undefined ? { model } : { model, reasoningEffort },
      lookup,
      reports.diagnostics
    )
    if (candidate !== undefined) candidates.push(candidate)
  }
  return candidates
}

/**
 * Looks one target up among the exposed models, at the effort the alias sets for it.
 *
 * @param alias - the alias
 * @param target - the canonical ID it serves, and the effort the alias sets, if any
 * @param lookup - the exposed models and pi's thinking levels
 * @param diagnostics - receives a diagnostic when the target is left out
 * @returns the exposed model, with its effort, or `undefined` when it is left out
 */
function withEffort(
  alias: string,
  target: ModelTarget,
  lookup: AliasLookup,
  diagnostics: AliasDiagnostic[]
): ExposedModel | undefined {
  const { model: canonicalId, reasoningEffort } = target
  const model = lookup.byCanonicalId.get(canonicalId)
  if (model === undefined) {
    diagnostics.push({
      code: 'target-not-exposed',
      alias,
      target: canonicalId,
      message: `Alias "${alias}" names "${canonicalId}", which is not an exposed model's canonical ID (provider/model-id).`
    })
    return undefined
  }
  if (reasoningEffort === undefined) return model
  const supported = effortsOfLevels(lookup.thinkingLevels(model.model))
  if (supported.includes(reasoningEffort)) return { ...model, reasoningEffort }
  diagnostics.push({
    code: 'effort-unsupported',
    alias,
    target: canonicalId,
    message: `Alias "${alias}" runs "${canonicalId}" at reasoning effort "${reasoningEffort}", which it does not support. It supports: ${supported.join(', ')}.`
  })
  return undefined
}
