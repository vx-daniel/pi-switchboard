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
 * - **Resolved last:** public ID, then canonical ID, then alias (`resolveExposedModel`).
 *
 * @packageDocumentation
 */

import type { AliasTarget } from '@proxy/config/schema'
import { proxyLogger } from '@proxy/logging'
import type { ExposedModel } from '@proxy/openai/model-exposure'
import * as z from 'zod'

/** Logger for model exposure, which aliases are part of. */
const exposureLogger = proxyLogger('openai', 'exposure')

/**
 * Why an alias is not exposed. `/healthz/models` lists these; the schema documents that response
 * and is never parsed.
 */
export const aliasDiagnosticSchema = z.object({
  code: z.enum(['shadows-model', 'target-not-exposed']),
  alias: z.string().trim().meta({ description: 'The alias, as written.' }),
  target: z.string().trim().meta({ description: 'The canonical ID it names, as written.' }),
  message: z.string().trim()
})

/** Why an alias is not exposed. */
export type AliasDiagnostic = z.infer<typeof aliasDiagnosticSchema>

/** The exposed aliases, and why any others are not. */
export interface ExposedAliases {
  /** Each exposed alias, as its target with the alias as the public ID, in config order. */
  readonly aliases: readonly ExposedModel[]
  /** Alias -> its entry in {@link ExposedAliases.aliases}. */
  readonly byAlias: ReadonlyMap<string, ExposedModel>
  readonly diagnostics: readonly AliasDiagnostic[]
}

/** The shadowing aliases the last warning named: exposure is computed per request. */
let lastShadowing = ''

/**
 * Warns about aliases named like a model, once per distinct set.
 *
 * @param diagnostics - this computation's alias diagnostics
 */
function warnShadowing(diagnostics: readonly AliasDiagnostic[]): void {
  const shadowing = diagnostics
    .filter((diagnostic) => diagnostic.code === 'shadows-model')
    .map((diagnostic) => diagnostic.alias)
  const key = JSON.stringify(shadowing)
  if (key === lastShadowing) return
  lastShadowing = key
  if (shadowing.length === 0) return
  exposureLogger.warn(
    'Ignoring aliases named like an exposed model, which keeps its name: {aliases}. Rename them',
    { aliasCount: shadowing.length, aliases: shadowing }
  )
}

/**
 * Exposes the configured aliases with an exposed target.
 *
 * @param aliases - alias -> one canonical ID, or `{ targets, fallbackOn }`, from the config
 * @param byPublicId - the exposed models by public ID
 * @param byCanonicalId - the exposed models by canonical ID
 * @returns the exposed aliases, and a diagnostic for each alias or target left out
 */
export function exposeAliases(
  aliases: Readonly<Record<string, AliasTarget>>,
  byPublicId: ReadonlyMap<string, ExposedModel>,
  byCanonicalId: ReadonlyMap<string, ExposedModel>
): ExposedAliases {
  const exposed: ExposedModel[] = []
  const byAlias = new Map<string, ExposedModel>()
  const diagnostics: AliasDiagnostic[] = []
  for (const [alias, target] of Object.entries(aliases)) {
    const targets = typeof target === 'string' ? [target] : target.targets
    if (byPublicId.has(alias) || byCanonicalId.has(alias)) {
      diagnostics.push({
        code: 'shadows-model',
        alias,
        target: targets.join(', '),
        message: `Alias "${alias}" is an exposed model's ID; that model keeps it and the alias is ignored. Rename the alias.`
      })
      continue
    }
    const candidates = exposedTargets(alias, targets, byCanonicalId, diagnostics)
    const [first] = candidates
    if (first === undefined) continue
    const entry: ExposedModel =
      typeof target === 'string'
        ? { ...first, publicId: alias, alias }
        : { ...first, publicId: alias, alias, route: { candidates, fallbackOn: target.fallbackOn } }
    exposed.push(entry)
    byAlias.set(alias, entry)
  }
  warnShadowing(diagnostics)
  if (diagnostics.length > 0) {
    exposureLogger.debug('{diagnosticCount} aliases are not exposed', {
      diagnosticCount: diagnostics.length,
      diagnostics
    })
  }
  return { aliases: exposed, byAlias, diagnostics }
}

/**
 * Looks an alias's targets up among the exposed models, in order, reporting each one that is not.
 *
 * @param alias - the alias
 * @param targets - its canonical IDs, as written
 * @param byCanonicalId - the exposed models by canonical ID
 * @param diagnostics - receives a `target-not-exposed` diagnostic per missing target; appended to
 * @returns the exposed targets, in the alias's order
 */
function exposedTargets(
  alias: string,
  targets: readonly string[],
  byCanonicalId: ReadonlyMap<string, ExposedModel>,
  diagnostics: AliasDiagnostic[]
): ExposedModel[] {
  const candidates: ExposedModel[] = []
  for (const target of targets) {
    const model = byCanonicalId.get(target)
    if (model === undefined) {
      diagnostics.push({
        code: 'target-not-exposed',
        alias,
        target,
        message: `Alias "${alias}" names "${target}", which is not an exposed model's canonical ID (provider/model-id).`
      })
    } else {
      candidates.push(model)
    }
  }
  return candidates
}
