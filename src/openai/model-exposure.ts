/**
 * Model-exposure engine: which models the proxy exposes, and under which public IDs.
 *
 * @remarks
 * Computes the exposed model set and public IDs from config and the available models. Used by
 * the models endpoints, model detail lookup, chat request model resolution and
 * `/healthz/models`.
 *
 * Public ID modes:
 *   - "collision-prefixed": prefix only providers in conflict groups
 *   - "universal": raw model IDs only; duplicates are a config error
 *   - "always-prefixed": always `<public-prefix>/<model-id>`
 *
 * Exposure modes (all modes only expose auth-configured models):
 *   - "all": expose every available model
 *   - "scoped": the models pi's global `enabledModels` setting selects, resolved as pi resolves
 *     its patterns (`@proxy/pi/model-scope`): exact IDs, bare IDs, globs, `:level` suffixes, fuzzy
 *   - "custom": the proxy's own `customModels` config, as exact canonical IDs
 *
 * In "scoped" an empty or missing `enabledModels` exposes every available model, as in pi. In
 * "custom" an empty `customModels` exposes none: the operator chose to pick models (#88).
 *
 * Aliases (`@proxy/openai/model-aliases`, #66) are names for exposed models, listed beside them
 * and resolved after the public and canonical IDs.
 *
 * A provider's extra logins (`@proxy/openai/model-logins`, #227) are not models of their own: the
 * base provider's model is the exposed one, and each entry lists the logins that may serve it, in
 * the configured order, without the disabled ones (#233).
 *
 * @packageDocumentation
 */

import type { Api, Model } from '@earendil-works/pi-ai'
import type {
  AliasTarget,
  FailureClass,
  FamilyTarget,
  ModelExposureMode,
  PublicModelIdMode
} from '@proxy/config/schema'
import { proxyLogger } from '@proxy/logging'
import type { ThinkingLevelsOf } from '@proxy/openai/effort-levels'
import {
  type AliasDiagnostic,
  exposeAliases,
  type FamilyResolution,
  latestAliases
} from '@proxy/openai/model-aliases'
import {
  DEFAULT_LOGIN_ROUTING,
  groupLogins,
  type LoginDiagnostic,
  loginDiagnostics,
  type LoginRouting
} from '@proxy/openai/model-logins'
import type { ReasoningEffort } from '@proxy/openai/schemas'
import { canonicalModelId } from '@proxy/pi/model-id'
import { resolveModelScope, type ScopeDiagnostic } from '@proxy/pi/model-scope'

// Re-exported so the pi extension, which reaches only the package's entry points, can name a
// model the way the proxy does.
export { canonicalModelId }

/** Logger for model exposure. */
const exposureLogger = proxyLogger('openai', 'exposure')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** An exposed model with its public and canonical IDs. */
export interface ExposedModel {
  /** The public ID exposed on the HTTP API: for an alias, the alias. */
  readonly publicId: string
  /** The canonical internal ID: "provider/model-id", the base provider's. */
  readonly canonicalId: string
  /** The pi model the login calls: the base's, or a login slot's copy (#227). */
  readonly model: Model<Api>
  /** The provider key: the base provider, `owned_by` on the API. */
  readonly provider: string
  /** The login that serves this entry: the provider ID pi resolves auth for, `model.provider`. */
  readonly login: string
  /** The alias, when this entry is one: the target's model under a name from the config (#66). */
  readonly alias?: string
  /**
   * The effort an alias runs this target at, replacing the request's (#230). Only on an alias's
   * entries, and only when its config sets one; the model supports it.
   */
  readonly reasoningEffort?: ReasoningEffort
  /**
   * An alias's fallback chain (#67): every exposed target, this entry's own first, and the
   * failures that move to the next. Only on an alias entry.
   */
  readonly route?: AliasRoute
  /**
   * The logins that may serve this model, this entry's own first, when there is more than one
   * (#227): the same model, each under its login. Routing tries them in this order.
   */
  readonly logins?: readonly ExposedModel[]
  /**
   * The same model under each login `routing.logins.disabled` names (#233), which routing never
   * calls; only when there is one.
   */
  readonly disabledLogins?: readonly ExposedModel[]
}

/** An alias's exposed targets, in order, and the failures that move to the next (#67). */
export interface AliasRoute {
  readonly candidates: readonly ExposedModel[]
  readonly fallbackOn: readonly FailureClass[]
}

/** The config inputs of {@link computeModelExposure}. */
export interface ModelExposureConfig {
  readonly publicModelIdMode: PublicModelIdMode
  readonly modelExposureMode: ModelExposureMode
  /**
   * pi's global `enabledModels` setting: patterns, as `/scoped-models` saves them or a user wrote
   * them. Read from pi's `SettingsManager.getEnabledModels()` on each request.
   * Undefined or empty means no filter (all available models exposed).
   * Used only when modelExposureMode is "scoped".
   */
  readonly enabledModels: readonly string[] | undefined
  /** The proxy's own canonical IDs, used when modelExposureMode is "custom"; empty exposes none. */
  readonly customModels: readonly string[]
  readonly providerPrefixes: Readonly<Record<string, string>>
  /**
   * Alias -> one target (a model or a family), or targets with the failures that move between
   * them (#66, #67, #231).
   */
  readonly aliases: Readonly<Record<string, AliasTarget>>
  /** `routing.logins.order` and `.disabled` (#233); the usual order, none disabled, when left out. */
  readonly loginRouting?: LoginRouting | undefined
}

/** A successful exposure computation: the exposed models and lookup maps. */
export interface ModelExposureResult {
  readonly ok: true
  /** All exposed models with public IDs. */
  readonly models: readonly ExposedModel[]
  /** Public ID -> ExposedModel for O(1) lookup. */
  readonly byPublicId: ReadonlyMap<string, ExposedModel>
  /** Canonical ID -> ExposedModel, so requests can also name an exposed model canonically. */
  readonly byCanonicalId: ReadonlyMap<string, ExposedModel>
  /** `enabledModels` patterns that selected nothing, or not what they name ("scoped" only). */
  readonly scopeDiagnostics: readonly ScopeDiagnostic[]
  /** The exposed aliases, each as its target under the alias: listed after {@link models}. */
  readonly aliases: readonly ExposedModel[]
  /** Alias -> its entry in {@link aliases}. */
  readonly byAlias: ReadonlyMap<string, ExposedModel>
  /**
   * Aliases and targets left out, and family members whose version can't be read (#66, #230,
   * #231).
   */
  readonly aliasDiagnostics: readonly AliasDiagnostic[]
  /** Login settings that name no login, and providers whose every login is disabled (#233). */
  readonly loginDiagnostics: readonly LoginDiagnostic[]
  /** What each family alias target resolves to now (#231). */
  readonly familyResolutions: readonly FamilyResolution[]
  /** The built-in `-latest` aliases computed with this exposure, by name (#231). */
  readonly latestAliases: Readonly<Record<string, FamilyTarget>>
}

/** A failed exposure computation: a config conflict that makes public IDs ambiguous. */
export interface ModelExposureError {
  readonly ok: false
  readonly message: string
}

/** Outcome of {@link computeModelExposure}, discriminated on `ok`. */
export type ModelExposureOutcome = ModelExposureResult | ModelExposureError

// ---------------------------------------------------------------------------
// Exposure filtering
// ---------------------------------------------------------------------------

/** The models an exposure mode selects, with any `enabledModels` pattern diagnostics. */
interface ExposedSet {
  readonly models: Model<Api>[]
  readonly scopeDiagnostics: readonly ScopeDiagnostic[]
}

/**
 * Selects the exposed models for the configured exposure mode.
 *
 * @param available - the auth-configured models
 * @param config - the exposure config
 * @returns the selected models in `available` order, with pattern diagnostics ("scoped" only)
 */
function filterExposedModels(
  available: readonly Model<Api>[],
  config: ModelExposureConfig
): ExposedSet {
  // "all": expose every auth-configured model.
  if (config.modelExposureMode === 'all') {
    return { models: [...available], scopeDiagnostics: [] }
  }

  // "custom" with nothing selected exposes nothing: the operator chose to pick models (#88).
  if (config.modelExposureMode === 'custom' && config.customModels.length === 0) {
    exposureLogger.debug('No custom models selected; exposing none')
    return { models: [], scopeDiagnostics: [] }
  }

  // "scoped" without patterns exposes every model, as pi treats no enabledModels.
  const filter = config.modelExposureMode === 'scoped' ? config.enabledModels : config.customModels
  if (filter === undefined || filter.length === 0) {
    exposureLogger.debug('No {modelExposureMode} model filter configured; exposing every model', {
      modelExposureMode: config.modelExposureMode
    })
    return { models: [...available], scopeDiagnostics: [] }
  }

  // "scoped": pi's patterns, resolved as pi resolves them. The exposed list keeps the available
  // models' order, as the other modes do, rather than the patterns' order.
  if (config.modelExposureMode === 'scoped') {
    const scope = resolveModelScope(filter, available)
    const inScope = new Set(scope.models)
    // At debug: exposure is computed per request. /healthz/models reports the diagnostics.
    if (scope.diagnostics.length > 0) {
      exposureLogger.debug('{diagnosticCount} enabledModels patterns did not resolve cleanly', {
        diagnosticCount: scope.diagnostics.length,
        diagnostics: scope.diagnostics
      })
    }
    return {
      models: available.filter((model) => inScope.has(model)),
      scopeDiagnostics: scope.diagnostics
    }
  }

  // "custom": the proxy's own list of exact canonical IDs.
  const allowed = new Set(filter)
  const filtered = available.filter((model) => allowed.has(canonicalModelId(model)))
  if (filtered.length < allowed.size) {
    exposureLogger.debug('{unmatchedCount} custom model IDs match no available model', () => {
      const availableIds = new Set(available.map((model) => canonicalModelId(model)))
      const unmatched = [...allowed].filter((canonicalId) => !availableIds.has(canonicalId))
      return { unmatchedCount: unmatched.length, unmatched }
    })
  }
  return { models: filtered, scopeDiagnostics: [] }
}

// ---------------------------------------------------------------------------
// Public ID generation
// ---------------------------------------------------------------------------

/**
 * Returns the public prefix label for a provider.
 *
 * @param provider - the provider key
 * @param prefixes - the configured `providerPrefixes`
 * @returns the non-empty configured override, otherwise the provider key itself
 */
function getPublicPrefix(provider: string, prefixes: Readonly<Record<string, string>>): string {
  const override = prefixes[provider]
  return override !== undefined && override.length > 0 ? override : provider
}

/**
 * Adds `value` to the set stored under `key`, creating the set on first use.
 *
 * @remarks
 * Insertion order of keys and values is preserved.
 *
 * @param map - the map of sets to update
 * @param key - the set's key
 * @param value - the value to add
 */
function addToSetMap(map: Map<string, Set<string>>, key: string, value: string): void {
  const existing = map.get(key)
  if (existing === undefined) {
    map.set(key, new Set([value]))
  } else {
    existing.add(value)
  }
}

/**
 * Returns the union-find root for `provider`, compressing the path walked so later lookups are
 * direct.
 *
 * @param parent - the union-find parent map; updated by path compression
 * @param provider - the provider to look up
 * @returns the root provider of its set
 */
function findRoot(parent: Map<string, string>, provider: string): string {
  let root = provider
  while (parent.get(root) !== root) {
    const parentProvider = parent.get(root)
    if (parentProvider === undefined) break
    root = parentProvider
  }
  // Path compression
  let current = provider
  while (current !== root) {
    const next = parent.get(current)
    if (next === undefined) break
    parent.set(current, root)
    current = next
  }
  return root
}

/**
 * Merges every provider in `providers` into the union-find set of the first one.
 *
 * @param parent - the union-find parent map to update
 * @param providers - the providers to merge
 */
function unionAll(parent: Map<string, string>, providers: ReadonlySet<string>): void {
  const [first, ...others] = providers
  if (first === undefined) return
  for (const other of others) {
    const rootA = findRoot(parent, first)
    const rootB = findRoot(parent, other)
    if (rootA !== rootB) {
      parent.set(rootA, rootB)
    }
  }
}

/**
 * Finds connected conflict groups: sets of providers that share at least one raw model ID.
 *
 * @remarks
 * If provider A and B share a model ID, and B and C share a different model ID,
 * then `{A, B, C}` form one connected conflict group.
 *
 * @param models - the exposed models
 * @returns the groups with more than one provider
 */
function findConflictGroups(models: readonly Model<Api>[]): Set<string>[] {
  // Map each raw model ID to the set of providers that offer it
  const modelToProviders = new Map<string, Set<string>>()
  // Union-Find for providers: each provider starts as its own root
  const parent = new Map<string, string>()
  for (const model of models) {
    addToSetMap(modelToProviders, model.id, model.provider)
    if (!parent.has(model.provider)) {
      parent.set(model.provider, model.provider)
    }
  }

  // Union providers that share any model ID
  for (const providers of modelToProviders.values()) {
    unionAll(parent, providers)
  }

  // Collect groups by root
  const groupsByRoot = new Map<string, Set<string>>()
  for (const provider of parent.keys()) {
    addToSetMap(groupsByRoot, findRoot(parent, provider), provider)
  }

  // Return only groups with more than one provider (actual conflicts)
  return [...groupsByRoot.values()].filter((group) => group.size > 1)
}

/**
 * Generates "collision-prefixed" public IDs: prefixed for providers in a conflict group, raw
 * otherwise.
 *
 * @param models - the exposed models
 * @param prefixes - the configured `providerPrefixes`
 * @returns each model's public ID
 */
function generateCollisionPrefixedIds(
  models: readonly Model<Api>[],
  prefixes: Readonly<Record<string, string>>
): Map<Model<Api>, string> {
  const conflictGroups = findConflictGroups(models)
  const prefixedProviders = new Set<string>()
  for (const group of conflictGroups) {
    for (const provider of group) {
      prefixedProviders.add(provider)
    }
  }
  if (conflictGroups.length > 0) {
    exposureLogger.debug(
      'Model ID collisions in {conflictGroupCount} provider groups; prefixing {prefixedProviders}',
      () => ({
        conflictGroupCount: conflictGroups.length,
        conflictGroups: conflictGroups.map((group) => [...group]),
        prefixedProviders: [...prefixedProviders]
      })
    )
  }

  const result = new Map<Model<Api>, string>()
  for (const model of models) {
    if (prefixedProviders.has(model.provider)) {
      const prefix = getPublicPrefix(model.provider, prefixes)
      result.set(model, `${prefix}/${model.id}`)
    } else {
      result.set(model, model.id)
    }
  }
  return result
}

/**
 * Generates "universal" public IDs: the raw model IDs.
 *
 * @param models - the exposed models
 * @returns each model's public ID, or the error message for the first ID two providers share
 */
function generateUniversalIds(models: readonly Model<Api>[]): Map<Model<Api>, string> | string {
  // Check for duplicates
  const seen = new Map<string, string>()
  for (const model of models) {
    const existing = seen.get(model.id)
    if (existing !== undefined) {
      return (
        `Universal mode conflict: model ID '${model.id}' is provided by both ` +
        `'${existing}' and '${model.provider}'. Use 'collision-prefixed' or ` +
        `'always-prefixed' mode, or reduce the exposed model set.`
      )
    }
    seen.set(model.id, model.provider)
  }

  const result = new Map<Model<Api>, string>()
  for (const model of models) {
    result.set(model, model.id)
  }
  return result
}

/**
 * Generates "always-prefixed" public IDs: `<public-prefix>/<model-id>` for every model.
 *
 * @param models - the exposed models
 * @param prefixes - the configured `providerPrefixes`
 * @returns each model's public ID
 */
function generateAlwaysPrefixedIds(
  models: readonly Model<Api>[],
  prefixes: Readonly<Record<string, string>>
): Map<Model<Api>, string> {
  const result = new Map<Model<Api>, string>()
  for (const model of models) {
    const prefix = getPublicPrefix(model.provider, prefixes)
    result.set(model, `${prefix}/${model.id}`)
  }
  return result
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Checks that the providers that get a prefix resolve to distinct prefix labels.
 *
 * @param models - the exposed models
 * @param prefixes - the configured `providerPrefixes`
 * @param mode - the public ID mode; "universal" uses no prefixes and always passes
 * @returns the error message for the first duplicate label, or `undefined`
 */
function validatePrefixUniqueness(
  models: readonly Model<Api>[],
  prefixes: Readonly<Record<string, string>>,
  mode: PublicModelIdMode
): string | undefined {
  if (mode === 'universal') return undefined

  // Collect providers that will use prefixes
  const providers = new Set<string>()
  if (mode === 'always-prefixed') {
    for (const model of models) {
      providers.add(model.provider)
    }
  } else {
    // collision-prefixed: only conflicting providers get prefixed
    const conflictGroups = findConflictGroups(models)
    for (const group of conflictGroups) {
      for (const provider of group) {
        providers.add(provider)
      }
    }
  }

  // Check that resolved prefix labels are unique
  const labelToProvider = new Map<string, string>()
  for (const provider of providers) {
    const label = getPublicPrefix(provider, prefixes)
    const existing = labelToProvider.get(label)
    if (existing !== undefined) {
      return (
        `Duplicate prefix label '${label}' used by providers ` +
        `'${existing}' and '${provider}'. Configure distinct providerPrefixes.`
      )
    }
    labelToProvider.set(label, provider)
  }

  return undefined
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Builds an exposed model's entry: the first login's, carrying every login when there is more
 * than one (#227), and the disabled ones when there are any (#233).
 *
 * @param publicId - the model's public ID
 * @param model - the model exposure selected: the base provider's
 * @param group - the models that may serve it, one per login, in routing order, and the same
 *   model under each disabled login
 * @param group.logins - the enabled logins' models, in routing order
 * @param group.disabled - the disabled logins' models
 * @returns the entry
 */
function exposedEntry(
  publicId: string,
  model: Model<Api>,
  group: { readonly logins: readonly Model<Api>[]; readonly disabled: readonly Model<Api>[] }
): ExposedModel {
  const canonicalId = canonicalModelId(model)
  const entryOf = (login: Model<Api>): ExposedModel => ({
    publicId,
    canonicalId,
    model: login,
    provider: model.provider,
    login: login.provider
  })
  const entries = group.logins.map(entryOf)
  const [first = entryOf(model)] = entries
  return {
    ...first,
    ...(entries.length > 1 ? { logins: entries } : {}),
    ...(group.disabled.length > 0 ? { disabledLogins: group.disabled.map(entryOf) } : {})
  }
}

/**
 * Computes the full model-exposure result from config and available models.
 *
 * @remarks
 * The routes and `/healthz/models` call this on each request, with the current config.
 *
 * @param available - the models with auth configured (`getAvailableModels()`)
 * @param config - the model exposure configuration
 * @param thinkingLevels - pi's `getSupportedThinkingLevels`, to check an alias target's effort
 *   (#230); passed in so that exposure loads without pi (#165)
 * @returns the exposed models and lookup maps, or the error for duplicate prefix labels or
 *   (in "universal" mode) a model ID two providers share
 */
export function computeModelExposure(
  available: readonly Model<Api>[],
  config: ModelExposureConfig,
  thinkingLevels: ThinkingLevelsOf
): ModelExposureOutcome {
  // 0. One entry per base provider's model, whatever its logins (#227): a login slot's models are
  // the base's. A disabled login is left out, and so is a model whose every login is (#233).
  const loginRouting = config.loginRouting ?? DEFAULT_LOGIN_ROUTING
  const groups = groupLogins(available, loginRouting)
  const groupOf = new Map(groups.map((group) => [group.primary, group]))

  // 1. Filter to exposed set
  const { models: exposed, scopeDiagnostics } = filterExposedModels(
    groups.map((group) => group.primary),
    config
  )

  // 2. Validate prefix uniqueness (before generating IDs)
  const prefixError = validatePrefixUniqueness(
    exposed,
    config.providerPrefixes,
    config.publicModelIdMode
  )
  if (prefixError !== undefined) {
    exposureLogger.warn('Model exposure configuration error: {message}', {
      message: prefixError,
      publicModelIdMode: config.publicModelIdMode
    })
    return { ok: false, message: prefixError }
  }

  // 3. Generate public IDs based on mode
  let idMap: Map<Model<Api>, string>

  switch (config.publicModelIdMode) {
    case 'collision-prefixed':
      idMap = generateCollisionPrefixedIds(exposed, config.providerPrefixes)
      break

    case 'universal': {
      const result = generateUniversalIds(exposed)
      if (typeof result === 'string') {
        exposureLogger.warn('Model exposure configuration error: {message}', {
          message: result,
          publicModelIdMode: config.publicModelIdMode
        })
        return { ok: false, message: result }
      }
      idMap = result
      break
    }

    case 'always-prefixed':
      idMap = generateAlwaysPrefixedIds(exposed, config.providerPrefixes)
      break
  }

  // 4. Build exposed model objects and lookup maps
  const models: ExposedModel[] = []
  const byPublicId = new Map<string, ExposedModel>()
  const byCanonicalId = new Map<string, ExposedModel>()

  for (const model of exposed) {
    const publicId = idMap.get(model)
    if (publicId === undefined) continue
    const entry = exposedEntry(publicId, model, groupOf.get(model) ?? { logins: [], disabled: [] })
    models.push(entry)
    byPublicId.set(publicId, entry)
    byCanonicalId.set(entry.canonicalId, entry)
  }

  exposureLogger.debug(
    'Computed exposure: {exposedCount} of {availableCount} models ({modelExposureMode}, {publicModelIdMode})',
    {
      modelExposureMode: config.modelExposureMode,
      publicModelIdMode: config.publicModelIdMode,
      availableCount: available.length,
      exposedCount: models.length,
      prefixOverrideCount: Object.keys(config.providerPrefixes).length
    }
  )

  // The built-in `-latest` aliases come after the configured ones, which replace one of their name.
  const latest = latestAliases(config.aliases, { byPublicId, byCanonicalId })
  const aliased = exposeAliases(
    { ...config.aliases, ...latest },
    {
      byPublicId,
      byCanonicalId,
      availableIds: groups.map(({ primary }) => canonicalModelId(primary)),
      thinkingLevels
    }
  )
  return {
    ok: true,
    models,
    byPublicId,
    byCanonicalId,
    scopeDiagnostics,
    aliases: aliased.aliases,
    byAlias: aliased.byAlias,
    aliasDiagnostics: aliased.diagnostics,
    loginDiagnostics: loginDiagnostics(available, loginRouting),
    familyResolutions: aliased.families,
    latestAliases: latest
  }
}

/**
 * Resolves a request's model ID against the exposure result.
 *
 * @remarks
 * Resolution order:
 *   1. Exact public ID match
 *   2. Exact canonical ID match (only exposed models are in the map)
 *   3. Exact alias match (#66): only aliases whose target is exposed, and none named like a model
 *
 * @param exposure - the exposure result
 * @param requestModelId - the request's `model`
 * @returns the exposed model (for an alias, its target with `alias` set), or `undefined` when it
 *   is not exposed
 */
export function resolveExposedModel(
  exposure: ModelExposureResult,
  requestModelId: string
): ExposedModel | undefined {
  // 1. Try exact public ID
  const byPublic = exposure.byPublicId.get(requestModelId)
  if (byPublic !== undefined) {
    exposureLogger.debug('Resolved public model ID {requestedModel} to {canonicalId}', {
      requestedModel: requestModelId,
      canonicalId: byPublic.canonicalId
    })
    return byPublic
  }

  // 2. Try canonical ID fallback (only for exposed models)
  const byCanonical = exposure.byCanonicalId.get(requestModelId)
  if (byCanonical !== undefined) {
    exposureLogger.debug('Resolved canonical model ID {requestedModel} (public ID {publicId})', {
      requestedModel: requestModelId,
      publicId: byCanonical.publicId
    })
    return byCanonical
  }

  // 3. Try an alias (#66)
  const byAlias = exposure.byAlias.get(requestModelId)
  if (byAlias === undefined) {
    exposureLogger.debug('Model {requestedModel} is not exposed', {
      requestedModel: requestModelId,
      exposedCount: exposure.models.length
    })
  } else {
    exposureLogger.debug('Resolved alias {requestedModel} to {canonicalId}', {
      requestedModel: requestModelId,
      canonicalId: byAlias.canonicalId
    })
  }
  return byAlias
}
