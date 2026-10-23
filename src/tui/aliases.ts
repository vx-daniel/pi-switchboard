/**
 * Editing aliases from the console's Models view (#230): checking a name, building the config
 * entry from the editor's targets, and saving, renaming and deleting an alias in
 * `proxy-config.json`.
 *
 * @remarks
 * The proxy reads the config file on every request (`fileConfigReader`), so a saved alias is used
 * by the next request without a restart. Each save is logged at info with the alias name, never
 * request content.
 *
 * @packageDocumentation
 */

import {
  type AliasModel,
  type AliasTarget,
  type FailureClass,
  aliasFallbackOn,
  aliasModels,
  loadConfigFromFile,
  saveConfigToFile
} from '@proxy/config/schema'
import { proxyLogger } from '@proxy/logging'
import type { ModelExposureResult } from '@proxy/openai/model-exposure'

/** Logger for the console's alias editor: the config category, as saves to the file are. */
const configLogger = proxyLogger('config')

/** An alias as the editor holds it: its models in order, and the failures that move between them. */
export interface AliasDraft {
  readonly models: readonly AliasModel[]
  readonly fallbackOn: readonly FailureClass[]
}

/**
 * Reads a configured alias into the editor's form.
 *
 * @param target - what the alias names, as the config holds it
 * @returns its models and `fallbackOn`
 */
export function draftOf(target: AliasTarget): AliasDraft {
  return { models: aliasModels(target), fallbackOn: aliasFallbackOn(target) }
}

/**
 * Builds the config entry for an alias: the shortest form that says the same thing.
 *
 * @param draft - the editor's alias, with at least one model
 * @returns a canonical ID or `{ model, reasoningEffort }` for one model without fallback classes,
 *   else `{ targets, fallbackOn }`
 */
function targetOf(draft: AliasDraft): AliasTarget {
  const targets = draft.models.map((aliasModel) =>
    aliasModel.reasoningEffort === undefined
      ? aliasModel.model
      : { model: aliasModel.model, reasoningEffort: aliasModel.reasoningEffort }
  )
  const [only] = targets
  if (targets.length === 1 && only !== undefined && draft.fallbackOn.length === 0) return only
  return { targets, fallbackOn: draft.fallbackOn }
}

/**
 * Checks a name for a new or renamed alias.
 *
 * @param name - the name typed
 * @param exposure - the current exposure, for the model IDs an alias may not take
 * @param taken - the configured alias names, the one being renamed excluded
 * @returns why the name is refused, or `undefined` when it may be used
 */
export function aliasNameProblem(
  name: string,
  exposure: Pick<ModelExposureResult, 'byPublicId' | 'byCanonicalId'>,
  taken: readonly string[]
): string | undefined {
  if (name.length === 0) return 'An alias needs a name.'
  if (/\s/u.test(name)) return `"${name}" has whitespace; use a name like "builder-high".`
  if (exposure.byPublicId.has(name) || exposure.byCanonicalId.has(name)) {
    return `"${name}" is an exposed model's ID; the model would keep it and the alias be ignored.`
  }
  if (taken.includes(name)) return `An alias named "${name}" already exists.`
  return undefined
}

/**
 * Writes the config's aliases, keeping everything else in the file.
 *
 * @param change - rewrites the aliases
 * @returns whether the file was written
 */
function writeAliases(
  change: (aliases: Readonly<Record<string, AliasTarget>>) => Record<string, AliasTarget>
): boolean {
  const config = loadConfigFromFile()
  return saveConfigToFile({ ...config, aliases: change(config.aliases) })
}

/**
 * Saves an alias, in place when it exists (renamed when `previousName` differs), else last.
 *
 * @param name - the alias's name
 * @param draft - its models and `fallbackOn`
 * @param previousName - the name it had, when editing an existing alias
 * @returns whether the file was written
 */
export function saveAlias(name: string, draft: AliasDraft, previousName?: string): boolean {
  const target = targetOf(draft)
  const existing = previousName ?? name
  const written = writeAliases((aliases) => {
    if (!(existing in aliases)) return { ...aliases, [name]: target }
    // Rebuilt in order, so a renamed or edited alias keeps its place in the file and the lists.
    return Object.fromEntries(
      Object.entries(aliases).map(([alias, current]) =>
        alias === existing ? [name, target] : [alias, current]
      )
    )
  })
  if (written) {
    if (previousName !== undefined && previousName !== name) {
      configLogger.info('Renamed alias {previousAlias} to {alias}', {
        alias: name,
        previousAlias: previousName
      })
    } else {
      configLogger.info('Saved alias {alias}', { alias: name, targetCount: draft.models.length })
    }
  }
  return written
}

/**
 * Deletes an alias.
 *
 * @param name - the alias's name
 * @returns whether the file was written
 */
export function deleteAlias(name: string): boolean {
  const written = writeAliases((aliases) => {
    const { [name]: _deleted, ...others } = aliases
    return others
  })
  if (written) configLogger.info('Deleted alias {alias}', { alias: name })
  return written
}
