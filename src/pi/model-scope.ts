/**
 * pi's `enabledModels` pattern resolution, ported from pi-coding-agent 1.3.0.
 *
 * @remarks
 * The source is `dist/core/model-resolver.js`: `resolveModelScopeFromModels` (line 225) and the
 * reference resolution it uses (`resolveModelReference` 75, `resolveText` 106, `selectReference`
 * 148, `selectFuzzy` 181, `bestFuzzyMatch` 201). pi resolves the setting this way for its own
 * `/scoped-models` (`dist/modes/interactive/interactive-mode.js`), against the available models it
 * has, but its package exports only the async `resolveModelScopeWithDiagnostics`, which first
 * refreshes availability through `ModelRuntime.getAvailable()` (reading the credential store for
 * every provider): too heavy per request (#46).
 *
 * Patterns: exact `provider/id` or bare IDs (case-insensitive), globs over `provider/id` or the
 * bare ID (`anthropic/*`, `*sonnet*`), a `:level` thinking suffix, and fuzzy substring matching of
 * IDs and names. The thinking level itself is dropped: exposure is per model. pi's `usable`
 * tie-break is not ported: its scope resolution passes `() => true`, so every model counts as
 * usable.
 *
 * `test/unit/model-scope.test.ts` runs this and pi's exported resolver over the same models and
 * patterns; a pi upgrade that changes the rules fails there.
 *
 * @packageDocumentation
 */

import type { Api, Model, ModelThinkingLevel } from '@earendil-works/pi-ai'
import { minimatch } from 'minimatch'
import * as z from 'zod'

/**
 * pi's thinking levels, as accepted after a `:` in a pattern (`VALID_THINKING_LEVELS` in pi's
 * `dist/cli/args.js`).
 */
const THINKING_LEVELS: ReadonlySet<string> = new Set<ModelThinkingLevel>([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
])

/** A dated model ID (`claude-sonnet-4-5-20250929`), which fuzzy matching ranks below its alias. */
const DATED_ID = /-\d{8}$/

/**
 * Why a pattern did not select exactly the models it names. `/healthz/models` lists these; the
 * schema documents that response and is never parsed.
 */
export const scopeDiagnosticSchema = z.object({
  code: z.enum(['no-match', 'ambiguous', 'invalid-thinking-level']),
  pattern: z.string().trim().meta({ description: 'The `enabledModels` pattern, as written.' }),
  message: z.string().trim()
})

/** Why a pattern did not select exactly the models it names. */
export type ScopeDiagnostic = z.infer<typeof scopeDiagnosticSchema>

/** The models a set of `enabledModels` patterns selects, and what went wrong on the way. */
export interface ModelScope {
  /** The selected models, each once, in pattern order. */
  readonly models: readonly Model<Api>[]
  readonly diagnostics: readonly ScopeDiagnostic[]
}

/** How one reference resolved: one model, several from different providers, or none. */
type Resolution =
  | { readonly status: 'resolved'; readonly model: Model<Api>; readonly warning?: string }
  | {
      readonly status: 'ambiguous'
      readonly candidates: readonly Model<Api>[]
      readonly warning?: string
    }
  | { readonly status: 'not-found' }

/** The not-found resolution. */
const NOT_FOUND: Resolution = { status: 'not-found' }

/** How a reference is read: thinking suffixes allowed (and warned about when invalid), fuzzy. */
interface ReferenceRequest {
  readonly thinkingSuffix: 'none' | 'lenient'
  readonly fuzzy: boolean
}

/**
 * Strips a valid `:level` thinking suffix.
 *
 * @param text - the reference text
 * @returns the text before the last `:`, or `undefined` when there is no `:` or what follows it is
 *   not a thinking level
 */
function splitThinkingSuffix(text: string): string | undefined {
  const colonIndex = text.lastIndexOf(':')
  if (colonIndex === -1 || !THINKING_LEVELS.has(text.slice(colonIndex + 1))) return undefined
  return text.slice(0, colonIndex)
}

/**
 * Splits `provider/rest` when `provider` names a provider in `models`.
 *
 * @param text - the reference text
 * @param models - the models whose providers count
 * @returns the provider (in its catalog casing) and the text after the first `/`, or `undefined`
 *   when there is no `/`, either side is empty, or no provider matches (case-insensitive)
 */
function splitProviderPrefix(
  text: string,
  models: readonly Model<Api>[]
): { readonly provider: string; readonly modelText: string } | undefined {
  const slashIndex = text.indexOf('/')
  if (slashIndex === -1) return undefined
  const prefix = text.slice(0, slashIndex).trim().toLowerCase()
  const modelText = text.slice(slashIndex + 1).trim()
  if (prefix.length === 0 || modelText.length === 0) return undefined
  const provider = models.find((model) => model.provider.toLowerCase() === prefix)?.provider
  return provider === undefined ? undefined : { provider, modelText }
}

/**
 * Counts the distinct providers among models.
 *
 * @param models - the models
 * @returns how many providers they come from
 */
function providerCount(models: readonly Model<Api>[]): number {
  return new Set(models.map((model) => model.provider)).size
}

/**
 * Finds the models whose ID or name contains the text, case-insensitively.
 *
 * @param text - the text to look for
 * @param models - the models to search
 * @returns the matches, in catalog order
 */
function fuzzyMatches(text: string, models: readonly Model<Api>[]): Model<Api>[] {
  const lowerText = text.toLowerCase()
  return models.filter(
    (model) =>
      model.id.toLowerCase().includes(lowerText) || model.name.toLowerCase().includes(lowerText)
  )
}

/**
 * Picks the best fuzzy match: aliases (`claude-sonnet-4-5`, or IDs ending in `-latest`) over dated
 * versions, then the latest by ID (descending order).
 *
 * @param matches - the fuzzy matches
 * @returns the best match, or `undefined` when there are none
 */
function bestFuzzyMatch(matches: readonly Model<Api>[]): Model<Api> | undefined {
  const aliases = matches.filter(
    (model) => model.id.endsWith('-latest') || !DATED_ID.test(model.id)
  )
  return (aliases.length > 0 ? aliases : matches).toSorted((left, right) =>
    right.id.localeCompare(left.id)
  )[0]
}

/**
 * Resolves a set of fuzzy matches to the best one.
 *
 * @param matches - the fuzzy matches
 * @returns the best match, every model with its ID when several providers offer it (ambiguous), or
 *   `undefined` when there are no matches
 */
function selectFuzzy(matches: readonly Model<Api>[]): Resolution | undefined {
  const best = bestFuzzyMatch(matches)
  if (best === undefined) return undefined
  // The same ID on several providers would otherwise be decided by catalog order
  const tied = matches.filter((model) => model.id === best.id)
  return providerCount(tied) === 1
    ? { status: 'resolved', model: best }
    : { status: 'ambiguous', candidates: tied }
}

/**
 * Resolves a reference as an exact model ID, or as `provider/id`.
 *
 * @remarks
 * `provider/rest` is a hint: the whole text may also be another provider's model ID (gateway IDs
 * such as `zai/glm-5`). The named provider's model wins; otherwise one raw match wins, and several
 * from different providers are ambiguous. Every model counts as usable here, as in pi's scoping.
 *
 * @param text - the reference text
 * @param pool - the models to resolve against
 * @param fuzzy - whether `rest` may fuzzy-match within the named provider's models
 * @returns the resolution, or `undefined` when nothing matches
 */
function selectReference(
  text: string,
  pool: readonly Model<Api>[],
  fuzzy: boolean
): Resolution | undefined {
  const lowerText = text.toLowerCase()
  const raw = pool.filter((model) => model.id.toLowerCase() === lowerText)
  const split = splitProviderPrefix(text, pool)
  let named: Model<Api> | undefined
  if (split !== undefined) {
    const providerModels = pool.filter((model) => model.provider === split.provider)
    const lowerModelText = split.modelText.toLowerCase()
    named =
      providerModels.find((model) => model.id.toLowerCase() === lowerModelText) ??
      raw.find((model) => model.provider === split.provider) ??
      (fuzzy ? bestFuzzyMatch(fuzzyMatches(split.modelText, providerModels)) : undefined)
  }
  const others = raw.filter((model) => model !== named)
  const candidates = named === undefined ? others : [named, ...others]
  const [first] = candidates
  if (first === undefined) return undefined
  if (providerCount(candidates) === 1) return { status: 'resolved', model: first }
  if (named !== undefined) return { status: 'resolved', model: named }
  return { status: 'ambiguous', candidates }
}

/**
 * Resolves reference text: exact or `provider/id`, then fuzzy, then without a thinking suffix.
 *
 * @remarks
 * An unknown suffix after the last `:` still resolves the model before it, with a warning.
 *
 * @param text - the trimmed reference text
 * @param request - whether suffixes and fuzzy matching are allowed
 * @param pool - the models to resolve against
 * @returns the resolution; `not-found` when nothing matches
 */
function resolveText(
  text: string,
  request: ReferenceRequest,
  pool: readonly Model<Api>[]
): Resolution {
  const reference = selectReference(text, pool, request.fuzzy)
  if (reference !== undefined) return reference
  if (request.fuzzy) {
    const fuzzy = selectFuzzy(fuzzyMatches(text, pool))
    if (fuzzy !== undefined) return fuzzy
  }
  if (request.thinkingSuffix === 'none') return NOT_FOUND
  const base = splitThinkingSuffix(text)
  if (base !== undefined) return resolveText(base, request, pool)
  // An unknown suffix still resolves the model, with a warning
  const colonIndex = text.lastIndexOf(':')
  if (colonIndex === -1) return NOT_FOUND
  const inner = resolveText(text.slice(0, colonIndex), request, pool)
  if (inner.status === 'not-found') return inner
  return {
    ...inner,
    warning: `Invalid thinking level "${text.slice(colonIndex + 1)}" in pattern "${text}". Using default instead.`
  }
}

/**
 * Resolves one reference after trimming it.
 *
 * @param text - the reference text
 * @param request - whether suffixes and fuzzy matching are allowed
 * @param models - the models to resolve against
 * @returns the resolution; `not-found` for empty text
 */
function resolveReference(
  text: string,
  request: ReferenceRequest,
  models: readonly Model<Api>[]
): Resolution {
  const trimmed = text.trim()
  return trimmed.length === 0 ? NOT_FOUND : resolveText(trimmed, request, models)
}

/** Records that `pattern` matches models of several providers (pi's `ambiguous` diagnostic). */
type AmbiguousReporter = (pattern: string, candidates: readonly Model<Api>[]) => void

/**
 * Says whether two models are the same, as pi-ai 1.3.0's `modelsAreEqual` decides it: the same
 * model type, ID and provider. The type is left out: for a `Model<Api>` it can only be `chat`.
 *
 * @remarks
 * Local, not pi's: the pi extension loads this module in pi's own process, and importing pi-ai
 * here loaded this package's installed copy of it next to the host's (#165).
 *
 * @param left - one model
 * @param right - the other
 * @returns whether they are the same model
 */
function sameModel(left: Model<Api>, right: Model<Api>): boolean {
  return left.id === right.id && left.provider === right.provider
}

/**
 * Selects the models `enabledModels` patterns name from `models`, as pi selects them.
 *
 * @remarks
 * A pattern with `*`, `?` or `[` is a glob (unless it is an exact ID, such as
 * `bracketed-model[1m]`); any other is a reference. An ambiguous reference selects every
 * candidate, with a diagnostic.
 *
 * @param patterns - the `enabledModels` patterns, in order
 * @param models - the models to select from (the available ones)
 * @returns the selected models, each once, in pattern order, and a diagnostic per pattern that
 *   matched nothing, matched several providers, or carried an invalid thinking level
 */
export function resolveModelScope(
  patterns: readonly string[],
  models: readonly Model<Api>[]
): ModelScope {
  const selected: Model<Api>[] = []
  const diagnostics: ScopeDiagnostic[] = []
  const add = (model: Model<Api>): void => {
    if (!selected.some((existing) => sameModel(existing, model))) selected.push(model)
  }
  const noMatch = (pattern: string): void => {
    diagnostics.push({ code: 'no-match', pattern, message: `No models match pattern "${pattern}"` })
  }
  const ambiguous: AmbiguousReporter = (pattern, candidates) => {
    const providers = [...new Set(candidates.map((model) => model.provider))].toSorted(
      (left, right) => left.localeCompare(right)
    )
    diagnostics.push({
      code: 'ambiguous',
      pattern,
      message: `Pattern "${pattern}" matches several providers: ${providers.join(', ')}. Use provider/id to choose one.`
    })
  }

  for (const pattern of patterns) {
    const matches = isGlob(pattern)
      ? globMatches(pattern, models, ambiguous)
      : referenceMatches(pattern, models, diagnostics, ambiguous)
    if (matches.length === 0) noMatch(pattern)
    for (const model of matches) add(model)
  }
  return { models: selected, diagnostics }
}

/**
 * Says whether a pattern is a glob, as pi decides it: it has `*`, `?` or `[`.
 *
 * @param pattern - an `enabledModels` pattern
 * @returns whether it is matched as a glob
 */
function isGlob(pattern: string): boolean {
  return pattern.includes('*') || pattern.includes('?') || pattern.includes('[')
}

/**
 * The glob branch of pi's `resolveModelScopeFromModels` loop, in the same steps: an exact ID
 * first (IDs such as `bracketed-model[1m]` are not globs), then the glob against
 * `provider/id` and the bare ID.
 *
 * @param pattern - a glob pattern, with an optional `:level` suffix
 * @param models - the models to select from
 * @param ambiguous - records an exact ID several providers have
 * @returns the matching models; empty when none match
 */
function globMatches(
  pattern: string,
  models: readonly Model<Api>[],
  ambiguous: AmbiguousReporter
): readonly Model<Api>[] {
  const globPattern = splitThinkingSuffix(pattern) ?? pattern
  const exact = resolveReference(globPattern, { thinkingSuffix: 'none', fuzzy: false }, models)
  if (exact.status === 'resolved') return [exact.model]
  if (exact.status === 'ambiguous') {
    ambiguous(pattern, exact.candidates)
    return exact.candidates
  }
  return models.filter(
    (model) =>
      minimatch(`${model.provider}/${model.id}`, globPattern, { nocase: true }) ||
      minimatch(model.id, globPattern, { nocase: true })
  )
}

/**
 * The reference branch of pi's `resolveModelScopeFromModels` loop, in the same steps: a fuzzy,
 * suffix-lenient lookup, an invalid thinking level reported, an ambiguous match selecting every
 * candidate.
 *
 * @param pattern - a reference: an ID, `provider/id` or a fuzzy name, with an optional suffix
 * @param models - the models to select from
 * @param diagnostics - where an invalid thinking level is recorded
 * @param ambiguous - records a reference that matches several providers
 * @returns the matching models; empty when none match
 */
function referenceMatches(
  pattern: string,
  models: readonly Model<Api>[],
  diagnostics: ScopeDiagnostic[],
  ambiguous: AmbiguousReporter
): readonly Model<Api>[] {
  const result = resolveReference(pattern, { thinkingSuffix: 'lenient', fuzzy: true }, models)
  if (result.status === 'not-found') return []
  if (result.warning !== undefined) {
    diagnostics.push({ code: 'invalid-thinking-level', pattern, message: result.warning })
  }
  if (result.status === 'ambiguous') {
    ambiguous(pattern, result.candidates)
    return result.candidates
  }
  return [result.model]
}
