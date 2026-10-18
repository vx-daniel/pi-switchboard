/**
 * pi's `enabledModels` pattern resolution, ported from pi-coding-agent 1.3.0
 * (`dist/core/model-resolver.js`: `resolveModelScopeFromModels` and the reference resolution it
 * uses). pi resolves the setting this way for its own `/scoped-models`, against the available
 * models it has, but exports only an async variant that refreshes availability first (reading the
 * credential store for every provider), which is too heavy per request (#46).
 *
 * Patterns: exact `provider/id` or bare IDs (case-insensitive), globs over `provider/id` or the
 * bare ID (`anthropic/*`, `*sonnet*`), a `:level` thinking suffix, and fuzzy substring matching of
 * IDs and names. The thinking level itself is dropped: exposure is per model.
 *
 * `test/unit/model-scope.test.ts` runs this and pi's exported resolver over the same models and
 * patterns; a pi upgrade that changes the rules fails there.
 */

import {
  type Api,
  type Model,
  type ModelThinkingLevel,
  modelsAreEqual
} from '@earendil-works/pi-ai'
import { minimatch } from 'minimatch'

/** pi's thinking levels, as accepted after a `:` in a pattern. */
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

/** Why a pattern did not select exactly the models it names. */
export interface ScopeDiagnostic {
  readonly code: 'no-match' | 'ambiguous' | 'invalid-thinking-level'
  readonly pattern: string
  readonly message: string
}

export interface ModelScope {
  /** The selected models, each once, in pattern order. */
  readonly models: readonly Model<Api>[]
  readonly diagnostics: readonly ScopeDiagnostic[]
}

type Resolution =
  | { readonly status: 'resolved'; readonly model: Model<Api>; readonly warning?: string }
  | {
      readonly status: 'ambiguous'
      readonly candidates: readonly Model<Api>[]
      readonly warning?: string
    }
  | { readonly status: 'not-found' }

const NOT_FOUND: Resolution = { status: 'not-found' }

/** How a reference is read: thinking suffixes allowed (and warned about when invalid), fuzzy. */
interface ReferenceRequest {
  readonly thinkingSuffix: 'none' | 'lenient'
  readonly fuzzy: boolean
}

function splitThinkingSuffix(text: string): string | undefined {
  const colonIndex = text.lastIndexOf(':')
  if (colonIndex === -1 || !THINKING_LEVELS.has(text.slice(colonIndex + 1))) return undefined
  return text.slice(0, colonIndex)
}

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

function providerCount(models: readonly Model<Api>[]): number {
  return new Set(models.map((model) => model.provider)).size
}

function fuzzyMatches(text: string, models: readonly Model<Api>[]): Model<Api>[] {
  const lowerText = text.toLowerCase()
  return models.filter(
    (model) =>
      model.id.toLowerCase().includes(lowerText) || model.name.toLowerCase().includes(lowerText)
  )
}

/** Prefer aliases (`claude-sonnet-4-5`) over dated versions, then the latest by ID. */
function bestFuzzyMatch(matches: readonly Model<Api>[]): Model<Api> | undefined {
  const aliases = matches.filter(
    (model) => model.id.endsWith('-latest') || !DATED_ID.test(model.id)
  )
  return (aliases.length > 0 ? aliases : matches).toSorted((left, right) =>
    right.id.localeCompare(left.id)
  )[0]
}

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
 * `provider/rest` is a hint: the whole text may also be another provider's model ID (gateway IDs
 * such as `zai/glm-5`). The named provider's model wins; otherwise one raw match wins, and several
 * from different providers are ambiguous. Every model counts as usable here, as in pi's scoping.
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

function resolveReference(
  text: string,
  request: ReferenceRequest,
  models: readonly Model<Api>[]
): Resolution {
  const trimmed = text.trim()
  return trimmed.length === 0 ? NOT_FOUND : resolveText(trimmed, request, models)
}

/** The models `enabledModels` patterns select from `models`, as pi selects them. */
export function resolveModelScope(
  patterns: readonly string[],
  models: readonly Model<Api>[]
): ModelScope {
  const selected: Model<Api>[] = []
  const diagnostics: ScopeDiagnostic[] = []
  const add = (model: Model<Api>): void => {
    if (!selected.some((existing) => modelsAreEqual(existing, model))) selected.push(model)
  }
  const noMatch = (pattern: string): void => {
    diagnostics.push({ code: 'no-match', pattern, message: `No models match pattern "${pattern}"` })
  }
  const ambiguous = (pattern: string, candidates: readonly Model<Api>[]): void => {
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
    if (pattern.includes('*') || pattern.includes('?') || pattern.includes('[')) {
      const globPattern = splitThinkingSuffix(pattern) ?? pattern
      // IDs such as `bracketed-model[1m]` are not globs
      const exact = resolveReference(globPattern, { thinkingSuffix: 'none', fuzzy: false }, models)
      let matches: readonly Model<Api>[]
      if (exact.status === 'resolved') {
        matches = [exact.model]
      } else if (exact.status === 'ambiguous') {
        matches = exact.candidates
        ambiguous(pattern, matches)
      } else {
        matches = models.filter(
          (model) =>
            minimatch(`${model.provider}/${model.id}`, globPattern, { nocase: true }) ||
            minimatch(model.id, globPattern, { nocase: true })
        )
      }
      if (matches.length === 0) noMatch(pattern)
      for (const model of matches) add(model)
      continue
    }

    const result = resolveReference(pattern, { thinkingSuffix: 'lenient', fuzzy: true }, models)
    if (result.status === 'not-found') {
      noMatch(pattern)
      continue
    }
    if (result.warning !== undefined) {
      diagnostics.push({ code: 'invalid-thinking-level', pattern, message: result.warning })
    }
    if (result.status === 'ambiguous') {
      ambiguous(pattern, result.candidates)
      for (const model of result.candidates) add(model)
    } else {
      add(result.model)
    }
  }
  return { models: selected, diagnostics }
}
