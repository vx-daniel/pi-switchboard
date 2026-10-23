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
 * - **Resolved last:** public ID, then canonical ID, then alias (`resolveExposedModel`).
 *
 * @packageDocumentation
 */

import {
  type AliasModel,
  type AliasTarget,
  aliasFallbackOn,
  aliasModels,
  isAliasChain
} from '@proxy/config/schema'
import { proxyLogger } from '@proxy/logging'
import { effortsOfLevels, type ThinkingLevelsOf } from '@proxy/openai/effort-levels'
import type { ExposedModel } from '@proxy/openai/model-exposure'
import * as z from 'zod'

/** Logger for model exposure, which aliases are part of. */
const exposureLogger = proxyLogger('openai', 'exposure')

/**
 * Why an alias is not exposed. `/healthz/models` lists these; the schema documents that response
 * and is never parsed.
 */
export const aliasDiagnosticSchema = z.object({
  code: z.enum(['shadows-model', 'target-not-exposed', 'effort-unsupported']),
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
  if (key === (lastWarned[code] ?? '[]')) return
  lastWarned[code] = key
  if (named.length === 0) return
  exposureLogger.warn(message, { aliasCount: named.length, aliases: named })
}

/**
 * Exposes the configured aliases with an exposed target.
 *
 * @param aliases - alias -> one canonical ID, or `{ targets, fallbackOn }`, from the config
 * @param byPublicId - the exposed models by public ID
 * @param byCanonicalId - the exposed models by canonical ID
 * @param thinkingLevels - pi's `getSupportedThinkingLevels`, to check a target's effort (#230)
 * @returns the exposed aliases, and a diagnostic for each alias or target left out
 */
export function exposeAliases(
  aliases: Readonly<Record<string, AliasTarget>>,
  byPublicId: ReadonlyMap<string, ExposedModel>,
  byCanonicalId: ReadonlyMap<string, ExposedModel>,
  thinkingLevels: ThinkingLevelsOf
): ExposedAliases {
  const exposed: ExposedModel[] = []
  const byAlias = new Map<string, ExposedModel>()
  const diagnostics: AliasDiagnostic[] = []
  for (const [alias, target] of Object.entries(aliases)) {
    const targets = aliasModels(target)
    if (byPublicId.has(alias) || byCanonicalId.has(alias)) {
      diagnostics.push({
        code: 'shadows-model',
        alias,
        target: targets.map(({ model }) => model).join(', '),
        message: `Alias "${alias}" is an exposed model's ID; that model keeps it and the alias is ignored. Rename the alias.`
      })
      continue
    }
    const candidates = exposedTargets(
      alias,
      targets,
      { byCanonicalId, thinkingLevels },
      diagnostics
    )
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
  if (diagnostics.length > 0) {
    exposureLogger.debug('{diagnosticCount} aliases are not exposed', {
      diagnosticCount: diagnostics.length,
      diagnostics
    })
  }
  return { aliases: exposed, byAlias, diagnostics }
}

/**
 * Looks an alias's targets up among the exposed models, in order, reporting each one that is not,
 * or that is set to an effort its model doesn't support.
 *
 * @param alias - the alias
 * @param targets - its models, as written
 * @param lookup - the exposed models by canonical ID, and pi's `getSupportedThinkingLevels`
 * @param diagnostics - receives a diagnostic per target left out; appended to
 * @returns the exposed targets, in the alias's order, each with the effort it runs at
 */
function exposedTargets(
  alias: string,
  targets: readonly AliasModel[],
  lookup: {
    readonly byCanonicalId: ReadonlyMap<string, ExposedModel>
    readonly thinkingLevels: ThinkingLevelsOf
  },
  diagnostics: AliasDiagnostic[]
): ExposedModel[] {
  const { byCanonicalId, thinkingLevels } = lookup
  const candidates: ExposedModel[] = []
  for (const { model: target, reasoningEffort } of targets) {
    const model = byCanonicalId.get(target)
    if (model === undefined) {
      diagnostics.push({
        code: 'target-not-exposed',
        alias,
        target,
        message: `Alias "${alias}" names "${target}", which is not an exposed model's canonical ID (provider/model-id).`
      })
    } else if (reasoningEffort === undefined) {
      candidates.push(model)
    } else {
      const supported = effortsOfLevels(thinkingLevels(model.model))
      if (supported.includes(reasoningEffort)) {
        candidates.push({ ...model, reasoningEffort })
      } else {
        diagnostics.push({
          code: 'effort-unsupported',
          alias,
          target,
          message: `Alias "${alias}" runs "${target}" at reasoning effort "${reasoningEffort}", which it does not support. It supports: ${supported.join(', ')}.`
        })
      }
    }
  }
  return candidates
}
