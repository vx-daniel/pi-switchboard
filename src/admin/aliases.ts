/**
 * The admin UI's alias editor (#367, phase 2): the targets it offers, the checks on what an editor
 * sends, and the saves, renames and deletes, through the console's own writers
 * (`src/config/aliases.ts`), each logged for audit.
 *
 * @remarks
 * The console's editor can't write an alias the proxy would leave out: it offers only exposed
 * models, and only the efforts each runs at. A request can name anything, so the same rules are
 * checked here: a model target is an exposed model, a family target a family with an exposed
 * member (its pin one of them), and an effort one its model supports. The proxy reads the config
 * file on every request, so a saved alias is used by the next request.
 *
 * @packageDocumentation
 */

import {
  badRequest,
  fileUnusable,
  notFound,
  notWritten,
  refused,
  type Refusal
} from '@proxy/admin/answers'
import { aliasNameProblem, deleteAlias, saveAlias } from '@proxy/config/aliases'
import {
  type AliasModel,
  type AliasTarget,
  aliasFallbackOn,
  aliasModels,
  type FailureClass,
  FailureClassSchema,
  isFamilyTarget,
  loadConfigFromFile,
  targetSummary
} from '@proxy/config/schema'
import { proxyLogger } from '@proxy/logging'
import type { ModelExposureResult } from '@proxy/openai/model-exposure'
import { familiesIn, scanFamily } from '@proxy/openai/model-families'
import { supportedReasoningEfforts } from '@proxy/openai/reasoning-effort'
import { REASONING_EFFORTS, type ReasoningEffort } from '@proxy/openai/schemas'
import { HTTP_CONFLICT } from '@proxy/server/http-status'
import * as z from 'zod'

/** Logger for the changes operators make. */
const auditLogger = proxyLogger('admin', 'audit')

/** A model an alias may name, with the efforts it runs at. */
export interface ModelOption {
  readonly id: string
  readonly efforts: readonly ReasoningEffort[]
}

/** A family an alias may follow: its exposed members, newest first, and the one it serves now. */
export interface FamilyOption {
  readonly family: string
  /** What a pin may name: the members with a version, newest first, then the others. */
  readonly members: readonly string[]
  /** The member an unpinned target serves now, or `null` when none has a version. */
  readonly newest: string | null
}

/** What the alias editor offers. */
export interface AliasOptions {
  readonly models: readonly ModelOption[]
  readonly families: readonly FamilyOption[]
  /** The failures `fallbackOn` may name. */
  readonly failures: readonly FailureClass[]
}

/**
 * Lists what the alias editor offers: the exposed models with their efforts, and the families
 * with an exposed member, as the console's editor offers them.
 *
 * @param exposure - the exposure now
 * @returns the options
 */
export function aliasOptions(exposure: ModelExposureResult): AliasOptions {
  const ids = [...exposure.byCanonicalId.keys()]
  const families = familiesIn(ids).flatMap((family): FamilyOption[] => {
    const scan = scanFamily(family, ids)
    if (scan === undefined || scan.all.length === 0) return []
    const newestFirst = scan.members.map((member) => member.canonicalId)
    return [
      {
        family,
        members: [...newestFirst, ...scan.all.filter((member) => !newestFirst.includes(member))],
        newest: newestFirst[0] ?? null
      }
    ]
  })
  return {
    models: exposure.models.map((exposed) => ({
      id: exposed.canonicalId,
      efforts: supportedReasoningEfforts(exposed.model)
    })),
    families,
    failures: FailureClassSchema.options
  }
}

/** An effort, when a target fixes one. */
const EffortSchema = z.enum(REASONING_EFFORTS).optional()

/** One of an alias's targets, as an editor sends it: a model, or a family. */
const TargetBodySchema = z.union([
  z.object({ model: z.string().trim().min(1), reasoningEffort: EffortSchema }).strict(),
  z
    .object({
      family: z.string().trim().min(1),
      pin: z.string().trim().min(1).optional(),
      reasoningEffort: EffortSchema
    })
    .strict()
])

/**
 * What an alias write sends: its targets in order, the failures that move between them, and the
 * name it had when it is renamed.
 */
export const AliasBodySchema = z
  .object({
    targets: z.array(TargetBodySchema).min(1),
    fallbackOn: z.array(FailureClassSchema),
    previousName: z.string().trim().min(1).optional()
  })
  .strict()

/** What an alias write sends, checked. */
export type AliasBody = z.infer<typeof AliasBodySchema>

/**
 * Reads a target as the config holds it: without the keys an editor left out.
 *
 * @param target - the target sent
 * @returns the alias model
 */
function aliasModelOf(target: AliasBody['targets'][number]): AliasModel {
  const effort =
    target.reasoningEffort === undefined ? {} : { reasoningEffort: target.reasoningEffort }
  if ('family' in target) {
    return {
      family: target.family,
      ...(target.pin === undefined ? {} : { pin: target.pin }),
      ...effort
    }
  }
  return { model: target.model, ...effort }
}

/**
 * Checks an effort against the model a target serves.
 *
 * @param exposure - the exposure now
 * @param modelId - the model's canonical ID
 * @param effort - the effort fixed, if one is
 * @returns why it is refused, or `undefined` when it may be used
 */
function effortProblem(
  exposure: ModelExposureResult,
  modelId: string | undefined,
  effort: ReasoningEffort | undefined
): string | undefined {
  if (effort === undefined) return undefined
  const exposed = modelId === undefined ? undefined : exposure.byCanonicalId.get(modelId)
  if (exposed === undefined) return `No exposed model to run at ${effort}.`
  return supportedReasoningEfforts(exposed.model).includes(effort)
    ? undefined
    : `${exposed.canonicalId} doesn't run at ${effort}.`
}

/**
 * Checks one target as the console's editor would only offer it.
 *
 * @param exposure - the exposure now
 * @param target - the target
 * @returns why it is refused, or `undefined` when it may be used
 */
function targetProblem(exposure: ModelExposureResult, target: AliasModel): string | undefined {
  if (!isFamilyTarget(target)) {
    if (!exposure.byCanonicalId.has(target.model)) return `${target.model} is not an exposed model.`
    return effortProblem(exposure, target.model, target.reasoningEffort)
  }
  const option = aliasOptions(exposure).families.find((family) => family.family === target.family)
  if (option === undefined) return `No exposed model is in the ${target.family} family.`
  if (target.pin !== undefined && !option.members.includes(target.pin)) {
    return `${target.pin} is not an exposed ${target.family} model.`
  }
  return effortProblem(exposure, target.pin ?? option.newest ?? undefined, target.reasoningEffort)
}

/**
 * Describes an alias for the audit line: its targets in order, with their efforts, and its
 * `fallbackOn`.
 *
 * @param target - the alias, or `undefined` when there was none
 * @returns the description; `none` for no alias
 */
function aliasText(target: AliasTarget | undefined): string {
  if (target === undefined) return 'none'
  const models = aliasModels(target).map((model) =>
    model.reasoningEffort === undefined
      ? targetSummary(model)
      : `${targetSummary(model)} at ${model.reasoningEffort}`
  )
  const fallbackOn = aliasFallbackOn(target)
  return fallbackOn.length === 0
    ? models.join(' → ')
    : `${models.join(' → ')} (on ${fallbackOn.join(', ')})`
}

/** What saving an alias needs: who, the name, and what was sent. */
export interface AliasChange {
  /** The operator, an editor, for the audit line. */
  readonly login: string
  readonly name: string
  readonly body: AliasBody
}

/**
 * Saves an alias for an editor: a new one, or an edit (and maybe a rename) of `previousName`.
 *
 * @param exposure - the exposure now, for the name and the targets
 * @param change - who, the name and the alias
 * @returns why it was refused, or `undefined` when it was saved
 */
export function changeAlias(
  exposure: ModelExposureResult,
  change: AliasChange
): Refusal | undefined {
  const unusable = fileUnusable()
  if (unusable !== undefined) return unusable
  const { name, body } = change
  const configured = loadConfigFromFile().aliases
  const previousName = body.previousName ?? (Object.hasOwn(configured, name) ? name : undefined)
  const taken = Object.keys(configured).filter((alias) => alias !== previousName)
  const nameProblem = aliasNameProblem(name, exposure, taken)
  if (nameProblem !== undefined) return badRequest('invalid_name', nameProblem)
  const models = body.targets.map(aliasModelOf)
  const problem = models
    .map((model) => targetProblem(exposure, model))
    .find((found) => found !== undefined)
  if (problem !== undefined) return badRequest('invalid_target', problem)
  const before = previousName === undefined ? undefined : configured[previousName]
  const outcome = saveAlias(
    name,
    { models, fallbackOn: body.fallbackOn },
    previousName === undefined ? { creating: true } : { previousName }
  )
  if (outcome === 'name-taken') {
    return refused(HTTP_CONFLICT, 'name_taken', `An alias named "${name}" was added meanwhile.`)
  }
  if (outcome === 'not-written') return notWritten()
  auditLogger.info('{login} saved alias {alias}{renamed}: {before} to {after}', {
    login: change.login,
    alias: name,
    renamed: previousName === undefined || previousName === name ? '' : ` (was ${previousName})`,
    before: aliasText(before),
    after: aliasText(loadConfigFromFile().aliases[name])
  })
  return undefined
}

/**
 * Deletes an alias for an editor.
 *
 * @param login - the operator, for the audit line
 * @param name - the alias
 * @returns why it was refused, or `undefined` when it was deleted
 */
export function removeAlias(login: string, name: string): Refusal | undefined {
  const unusable = fileUnusable()
  if (unusable !== undefined) return unusable
  const before = loadConfigFromFile().aliases
  if (!Object.hasOwn(before, name)) return notFound('unknown_alias', `There is no alias ${name}.`)
  if (!deleteAlias(name)) return notWritten()
  auditLogger.info('{login} deleted alias {alias}: {before}', {
    login,
    alias: name,
    before: aliasText(before[name])
  })
  return undefined
}
