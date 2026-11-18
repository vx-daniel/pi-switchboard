/**
 * How the Models page writes what an alias points at (#367): the config's alias targets, in
 * words.
 *
 * @packageDocumentation
 */

import * as z from 'zod'

/** A model, with the reasoning effort the alias asks for. */
const ModelTargetSchema = z.looseObject({
  model: z.string().trim(),
  reasoningEffort: z.string().trim().optional()
})

/** A fallback chain. */
const ChainTargetSchema = z.looseObject({
  targets: z.array(z.union([z.string().trim(), ModelTargetSchema])),
  fallbackOn: z.array(z.string().trim()).optional()
})

/** The newest member of a family. */
const FamilyTargetSchema = z.looseObject({
  family: z.string().trim(),
  reasoningEffort: z.string().trim().optional()
})

/**
 * Writes a model target.
 *
 * @param target - a model's ID, or a model with its effort
 * @returns `anthropic/claude-opus-5-5`, or `anthropic/claude-opus-5-5 (high)`
 */
function modelText(target: string | z.infer<typeof ModelTargetSchema>): string {
  if (typeof target === 'string') return target
  return target.reasoningEffort === undefined
    ? target.model
    : `${target.model} (${target.reasoningEffort})`
}

/**
 * Writes what an alias points at.
 *
 * @param target - the alias's target, as the config holds it
 * @returns the target in words; `unknown target` for a shape the config never holds
 */
export function aliasText(target: unknown): string {
  const model = z.union([z.string().trim(), ModelTargetSchema]).safeParse(target)
  if (model.success) return modelText(model.data)
  const chain = ChainTargetSchema.safeParse(target)
  if (chain.success) {
    const fallback =
      chain.data.fallbackOn === undefined ? '' : ` on ${chain.data.fallbackOn.join(', ')}`
    return `${chain.data.targets.map(modelText).join(' → ')}${fallback}`
  }
  const family = FamilyTargetSchema.safeParse(target)
  if (family.success) {
    const effort =
      family.data.reasoningEffort === undefined ? '' : ` (${family.data.reasoningEffort})`
    return `newest ${family.data.family}${effort}`
  }
  return 'unknown target'
}
