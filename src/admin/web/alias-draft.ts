/**
 * An alias as the Models page holds it (#367): read from any shape the config writes (a model's
 * ID, a model at an effort, a family, or a chain of them), described in words, and sent back as
 * the API takes it.
 *
 * @packageDocumentation
 */

import * as z from 'zod'

/** One of an alias's targets, in the editor. */
export type DraftTarget =
  | { readonly kind: 'model'; readonly model: string; readonly effort: string | null }
  | {
      readonly kind: 'family'
      readonly family: string
      readonly pin: string | null
      readonly effort: string | null
    }

/** An alias in the editor: its targets in order, and the failures that move between them. */
export interface AliasDraft {
  readonly targets: readonly DraftTarget[]
  readonly fallbackOn: readonly string[]
}

/** A model target: its ID, or the ID with the effort it runs at. */
const ModelTargetSchema = z.union([
  z.string().trim(),
  z.looseObject({ model: z.string().trim(), reasoningEffort: z.string().trim().optional() })
])

/** A family target. */
const FamilyTargetSchema = z.looseObject({
  family: z.string().trim(),
  pin: z.string().trim().optional(),
  reasoningEffort: z.string().trim().optional()
})

/** A chain of targets. */
const ChainSchema = z.looseObject({
  targets: z.array(z.unknown()),
  fallbackOn: z.array(z.string().trim()).optional()
})

/**
 * Reads one target into the editor's form.
 *
 * @param target - the target, as the config writes it
 * @returns the target, or `undefined` for a shape the config never holds
 */
function draftTarget(target: unknown): DraftTarget | undefined {
  const family = FamilyTargetSchema.safeParse(target)
  if (family.success) {
    return {
      kind: 'family',
      family: family.data.family,
      pin: family.data.pin ?? null,
      effort: family.data.reasoningEffort ?? null
    }
  }
  const model = ModelTargetSchema.safeParse(target)
  if (!model.success) return undefined
  return typeof model.data === 'string'
    ? { kind: 'model', model: model.data, effort: null }
    : { kind: 'model', model: model.data.model, effort: model.data.reasoningEffort ?? null }
}

/**
 * Reads an alias into the editor's form.
 *
 * @param target - what the alias names, as the config holds it
 * @returns the draft, or `undefined` for a shape the config never holds
 */
export function draftOf(target: unknown): AliasDraft | undefined {
  const one = draftTarget(target)
  if (one !== undefined) return { targets: [one], fallbackOn: [] }
  const chain = ChainSchema.safeParse(target)
  if (!chain.success) return undefined
  const targets = chain.data.targets.map(draftTarget)
  if (targets.some((chained) => chained === undefined)) return undefined
  return {
    targets: targets.filter((chained) => chained !== undefined),
    fallbackOn: chain.data.fallbackOn ?? []
  }
}

/**
 * Describes one target.
 *
 * @param target - the target
 * @returns `anthropic/claude-opus-5-5 (high)`, `newest anthropic/claude-opus`, or a pinned family
 */
function targetText(target: DraftTarget): string {
  const effort = target.effort === null ? '' : ` (${target.effort})`
  if (target.kind === 'model') return `${target.model}${effort}`
  return target.pin === null
    ? `newest ${target.family}${effort}`
    : `${target.family} pinned to ${target.pin}${effort}`
}

/**
 * Describes what an alias points at.
 *
 * @param target - the alias's target, as the config holds it
 * @returns the target in words; `unknown target` for a shape the config never holds
 */
export function aliasText(target: unknown): string {
  const draft = draftOf(target)
  if (draft === undefined) return 'unknown target'
  const fallback = draft.fallbackOn.length === 0 ? '' : ` on ${draft.fallbackOn.join(', ')}`
  return `${draft.targets.map(targetText).join(' → ')}${fallback}`
}

/**
 * Builds what the API takes to save an alias.
 *
 * @param draft - the alias
 * @param previousName - the name it had, when it is renamed
 * @returns the body of `PUT /admin/api/aliases/{name}`
 */
export function draftBody(draft: AliasDraft, previousName: string | undefined): unknown {
  return {
    targets: draft.targets.map((target) => {
      const effort = target.effort === null ? {} : { reasoningEffort: target.effort }
      if (target.kind === 'model') return { model: target.model, ...effort }
      return {
        family: target.family,
        ...(target.pin === null ? {} : { pin: target.pin }),
        ...effort
      }
    }),
    fallbackOn: draft.fallbackOn,
    ...(previousName === undefined ? {} : { previousName })
  }
}
