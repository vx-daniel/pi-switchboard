/**
 * The console's alias editor (#230): the menus behind the Models view's rows.
 *
 * @remarks
 * Every change is saved to `proxy-config.json` as soon as it is made (`src/tui/aliases.ts`), and
 * the next request uses it. A target is picked from the exposed models only, and its effort only
 * from that model's ladder, so the editor can't write an alias the proxy would leave out. The
 * dialogs come in as {@link AliasScreens}: pi's selector and input in the console, scripted
 * answers in tests.
 *
 * @packageDocumentation
 */

import {
  type AliasModel,
  type AliasTarget,
  FailureClassSchema,
  type FamilyTarget,
  isFamilyTarget,
  targetName,
  targetSummary
} from '@proxy/config/schema'
import type { ModelExposureResult } from '@proxy/openai/model-exposure'
import { familiesIn, scanFamily } from '@proxy/openai/model-families'
import { supportedReasoningEfforts } from '@proxy/openai/reasoning-effort'
import type { ReasoningEffort } from '@proxy/openai/schemas'
import {
  type AliasDraft,
  type AliasSaveMode,
  aliasNameProblem,
  deleteAlias,
  draftOf,
  saveAlias
} from '@proxy/tui/aliases'
import type { ConsoleContext } from '@proxy/tui/console'
import { inBackground } from '@proxy/tui/console-accounts'
import { askLine, pickLabel, tickList } from '@proxy/tui/dialogs'
import { modelsItemAt, type ModelsItem, modelsViewData } from '@proxy/tui/models-view'

/** The effort option that keeps the request's own `reasoning_effort`. */
const REQUEST_EFFORT = "The request's effort (not fixed)"
/** The option that ends a menu loop. */
const DONE = 'Done'
/** The option that adds a target. */
const ADD_TARGET = '+ Add a target…'
/** The new-alias option that follows a family's newest model (#231). */
const FAMILY_KIND = 'A model family (follows the newest)'
/** What a new alias can name, when it wasn't started from a model's row. */
const NEW_KINDS = ['A model', FAMILY_KIND]
/** The actions that only a family target has (#231). */
const PIN_TO = 'Pin to…'
/** Clears a family target's pin. */
const FOLLOW_NEWEST = 'Follow newest'

/** The dialogs the editor asks through. */
export interface AliasScreens {
  /**
   * Asks the operator to pick one of `labels`.
   *
   * @param title - the question
   * @param labels - the options
   * @returns the label picked, or `undefined` when cancelled
   */
  select(title: string, labels: readonly string[]): Promise<string | undefined>
  /**
   * Asks the operator for a line of text.
   *
   * @param title - the question
   * @returns the text, or `undefined` when cancelled
   */
  input(title: string): Promise<string | undefined>
}

/** What the editor works with: its dialogs, the exposure and aliases last read, and a redraw. */
export interface AliasEditor {
  readonly screens: AliasScreens
  readonly exposure: ModelExposureResult
  readonly aliases: Readonly<Record<string, AliasTarget>>
  /** Reads the status again after a save, so the view shows the change. */
  refresh(): Promise<void>
}

/** What the editor says when `proxy-config.json` could not be written; the log says why. */
const NOT_WRITTEN = 'Could not write proxy-config.json; nothing changed. The log says why.'

/**
 * Tells the operator something that needs no answer, as a selector with one option.
 *
 * @param editor - the dialogs
 * @param message - what to say
 */
async function notify(editor: AliasEditor, message: string): Promise<void> {
  await editor.screens.select(message, ['OK'])
}

/**
 * Asks for an alias name until it is one the proxy accepts, showing why the last was refused.
 *
 * @param editor - the dialogs, the exposure and the aliases
 * @param title - the question
 * @param previousName - the alias being renamed, which may keep its name
 * @returns the name, or `undefined` when cancelled
 */
async function askAliasName(
  editor: AliasEditor,
  title: string,
  previousName?: string
): Promise<string | undefined> {
  const taken = Object.keys(editor.aliases).filter((alias) => alias !== previousName)
  let question = title
  for (;;) {
    const name = await editor.screens.input(question)
    if (name === undefined) return undefined
    const problem = aliasNameProblem(name, editor.exposure, taken)
    if (problem === undefined) return name
    question = `${problem} ${title}`
  }
}

/**
 * Asks the effort a model runs at, offering only the levels it supports.
 *
 * @param editor - the dialogs and the exposure
 * @param canonicalId - the model
 * @returns the effort, `null` for the request's, or `undefined` when cancelled or not exposed
 */
async function pickEffort(
  editor: AliasEditor,
  canonicalId: string
): Promise<ReasoningEffort | null | undefined> {
  const exposed = editor.exposure.byCanonicalId.get(canonicalId)
  if (exposed === undefined) {
    // No ladder to check an effort against; changing it would only clear the one set.
    await notify(
      editor,
      `${canonicalId} is not exposed, so its effort can't be checked; it is unchanged.`
    )
    return undefined
  }
  const efforts = supportedReasoningEfforts(exposed.model)
  const label = await editor.screens.select(`Reasoning effort for ${canonicalId}`, [
    REQUEST_EFFORT,
    ...efforts
  ])
  if (label === undefined) return undefined
  return efforts.find((level) => level === label) ?? null
}

/**
 * Sets the effort a target runs at, or clears it for the request's.
 *
 * @param target - the target
 * @param effort - the effort, or `null` for the request's
 * @returns the target with that effort
 */
function withEffort(target: AliasModel, effort: ReasoningEffort | null): AliasModel {
  if (isFamilyTarget(target)) {
    const { reasoningEffort: _family, ...family } = target
    return effort === null ? family : { ...family, reasoningEffort: effort }
  }
  const { reasoningEffort: _model, ...model } = target
  return effort === null ? model : { ...model, reasoningEffort: effort }
}

/**
 * Asks for a model and the effort it runs at, offering only exposed models and the levels the
 * model supports.
 *
 * @param editor - the dialogs and the exposure
 * @param title - the question for the model
 * @param model - the model, when it is already chosen
 * @returns the target, or `undefined` when cancelled
 */
async function pickTarget(
  editor: AliasEditor,
  title: string,
  model?: string
): Promise<AliasModel | undefined> {
  const ids = editor.exposure.models.map((exposed) => exposed.canonicalId)
  const chosen = model ?? (await editor.screens.select(title, ids))
  if (chosen === undefined) return undefined
  const effort = await pickEffort(editor, chosen)
  if (effort === undefined) return undefined
  return effort === null ? { model: chosen } : { model: chosen, reasoningEffort: effort }
}

/**
 * Lists a family's exposed members: those with a version newest first, then the others (dated
 * snapshots, unreadable IDs), which only a pin can name.
 *
 * @param editor - the exposure
 * @param family - the family
 * @returns their canonical IDs; none for an unknown family
 */
function familyMembers(editor: AliasEditor, family: string): string[] {
  const scan = scanFamily(family, editor.exposure.byCanonicalId.keys())
  if (scan === undefined) return []
  const newestFirst = scan.members.map((member) => member.canonicalId)
  return [...newestFirst, ...scan.all.filter((member) => !newestFirst.includes(member))]
}

/**
 * Finds the model a family target serves now, as exposure resolves it: its pin, else the newest
 * exposed member.
 *
 * @param editor - the exposure
 * @param target - the family target
 * @returns its canonical ID, or `undefined` when the family has no exposed member
 */
function familyModel(editor: AliasEditor, target: FamilyTarget): string | undefined {
  return (
    target.pin ??
    scanFamily(target.family, editor.exposure.byCanonicalId.keys())?.members[0]?.canonicalId
  )
}

/**
 * Asks for a family to follow, among those with an exposed member, and the effort it runs at.
 *
 * @param editor - the dialogs and the exposure
 * @returns the family target, or `undefined` when cancelled or none has an exposed member
 */
async function pickFamilyTarget(editor: AliasEditor): Promise<FamilyTarget | undefined> {
  const families = familiesIn(editor.exposure.byCanonicalId.keys())
  if (families.length === 0) {
    await notify(editor, 'No model family has an exposed model.')
    return undefined
  }
  const family = await editor.screens.select('Family to follow (its newest model)', families)
  if (family === undefined) return undefined
  const model = familyModel(editor, { family })
  const effort = model === undefined ? null : await pickEffort(editor, model)
  if (effort === undefined) return undefined
  return effort === null ? { family } : { family, reasoningEffort: effort }
}

/**
 * Asks which exposed member of its family to pin a family target to.
 *
 * @param editor - the dialogs and the exposure
 * @param target - the family target
 * @returns the target pinned, or `undefined` when cancelled
 */
async function pinTo(editor: AliasEditor, target: FamilyTarget): Promise<FamilyTarget | undefined> {
  const pin = await editor.screens.select(
    `Pin ${target.family} to`,
    familyMembers(editor, target.family)
  )
  return pin === undefined ? undefined : { ...target, pin }
}

/**
 * Clears a family target's pin, so it follows the newest again.
 *
 * @param target - the family target
 * @returns the target without its pin
 */
function followNewest(target: FamilyTarget): FamilyTarget {
  const { pin: _cleared, ...following } = target
  return following
}

/**
 * Saves an alias, then reads the status again; says why when nothing was saved.
 *
 * @param editor - the editor
 * @param name - the alias
 * @param draft - its models and `fallbackOn`
 * @param mode - whether it is new, or the name it had
 * @returns whether it was saved
 */
async function save(
  editor: AliasEditor,
  name: string,
  draft: AliasDraft,
  mode: AliasSaveMode
): Promise<boolean> {
  const outcome = saveAlias(name, draft, mode)
  if (outcome === 'written') await editor.refresh()
  else if (outcome === 'name-taken') {
    await notify(editor, `An alias named "${name}" was added meanwhile; nothing changed.`)
  } else await notify(editor, NOT_WRITTEN)
  return outcome === 'written'
}

/**
 * Creates an alias: its name, then a model or a family (#231) and the effort it runs at.
 *
 * @param editor - the editor
 * @param model - the model to start from, when the alias was started from a model's row
 */
async function newAlias(editor: AliasEditor, model?: string): Promise<void> {
  const name = await askAliasName(editor, 'Name for the new alias (e.g. reviewer, builder-high)')
  if (name === undefined) return
  const kind =
    model === undefined ? await editor.screens.select(`${name} names`, NEW_KINDS) : undefined
  if (model === undefined && kind === undefined) return
  const target =
    kind === FAMILY_KIND
      ? await pickFamilyTarget(editor)
      : await pickTarget(editor, `Model for ${name}`, model)
  if (target !== undefined) {
    await save(editor, name, { models: [target], fallbackOn: [] }, { creating: true })
  }
}

/**
 * Swaps a target with its neighbour.
 *
 * @param models - the targets
 * @param index - the target's place
 * @param other - the neighbour's place
 * @returns the targets after the swap, or `undefined` when there is no neighbour there
 */
function swapped(
  models: readonly AliasModel[],
  index: number,
  other: number
): AliasModel[] | undefined {
  const moving = models[index]
  const neighbour = models[other]
  if (moving === undefined || neighbour === undefined) return undefined
  const next = [...models]
  next[other] = moving
  next[index] = neighbour
  return next
}

/** What can be done to one target, and how each changes the targets. */
const TARGET_ACTIONS: Readonly<
  Record<
    string,
    (
      editor: AliasEditor,
      models: readonly AliasModel[],
      index: number
    ) => Promise<AliasModel[] | undefined>
  >
> = {
  'Set the reasoning effort': async (editor, models, index) => {
    const current = models[index]
    const model =
      current === undefined || !isFamilyTarget(current)
        ? current?.model
        : familyModel(editor, current)
    if (current === undefined) return undefined
    if (model === undefined) {
      // A family with no exposed member has no ladder; the effort set stays.
      await notify(
        editor,
        `${targetName(current)} has no exposed model, so its effort can't be checked; it is unchanged.`
      )
      return undefined
    }
    const effort = await pickEffort(editor, model)
    return effort === undefined ? undefined : models.with(index, withEffort(current, effort))
  },
  [PIN_TO]: async (editor, models, index) => {
    const current = models[index]
    if (current === undefined || !isFamilyTarget(current)) return undefined
    const pinned = await pinTo(editor, current)
    return pinned === undefined ? undefined : models.with(index, pinned)
  },
  [FOLLOW_NEWEST]: (_editor, models, index) => {
    const current = models[index]
    if (current === undefined || !isFamilyTarget(current)) return Promise.resolve(undefined)
    return Promise.resolve(models.with(index, followNewest(current)))
  },
  'Move up': (_editor, models, index) => Promise.resolve(swapped(models, index, index - 1)),
  'Move down': (_editor, models, index) => Promise.resolve(swapped(models, index, index + 1)),
  // An alias with no target names nothing; deleting the alias says that.
  'Remove': (_editor, models, index) =>
    Promise.resolve(models.length === 1 ? undefined : models.toSpliced(index, 1))
}

/**
 * Lists what can be done to a target: a family target can also be pinned, or follow the newest.
 *
 * @param target - the target
 * @returns the menu's options
 */
function targetActions(target: AliasModel | undefined): string[] {
  const actions = Object.keys(TARGET_ACTIONS)
  if (target !== undefined && isFamilyTarget(target)) return actions
  return actions.filter((action) => action !== PIN_TO && action !== FOLLOW_NEWEST)
}

/**
 * Shows an alias's targets, each with its effort, and the menu's other rows.
 *
 * @param models - the targets
 * @returns one label per target, in order
 */
function targetLabels(models: readonly AliasModel[]): string[] {
  return models.map((target, index) => {
    const effort = target.reasoningEffort === undefined ? '' : ` @${target.reasoningEffort}`
    return `${String(index + 1)}. ${targetSummary(target)}${effort}`
  })
}

/**
 * Runs one step of the targets menu: adds a target, or acts on the one picked.
 *
 * @param editor - the editor
 * @param name - the alias
 * @param models - its targets now
 * @returns the targets after the step, `undefined` when nothing changed, or `'done'` to close
 */
async function targetsStep(
  editor: AliasEditor,
  name: string,
  models: readonly AliasModel[]
): Promise<AliasModel[] | undefined | 'done'> {
  const rows = targetLabels(models)
  const choice = await editor.screens.select(`Targets of ${name}`, [...rows, ADD_TARGET, DONE])
  if (choice === undefined || choice === DONE) return 'done'
  if (choice === ADD_TARGET) {
    const target = await pickTarget(editor, `Add a target to ${name}`)
    return target === undefined ? undefined : [...models, target]
  }
  const index = rows.indexOf(choice)
  const action = await editor.screens.select(choice, targetActions(models[index]))
  const change = action === undefined ? undefined : TARGET_ACTIONS[action]
  return change === undefined ? undefined : change(editor, models, index)
}

/**
 * Edits an alias's targets in a loop, saving each change, until the operator is done.
 *
 * @param editor - the editor
 * @param name - the alias
 * @param start - the alias as it was when the menu opened
 */
async function editTargets(editor: AliasEditor, name: string, start: AliasDraft): Promise<void> {
  let models = start.models
  for (;;) {
    const next = await targetsStep(editor, name, models)
    if (next === 'done') return
    // The menu keeps building on what is saved: a failed save must not carry into the next one.
    const draft = { models: next ?? models, fallbackOn: start.fallbackOn }
    if (next !== undefined && (await save(editor, name, draft, { previousName: name }))) {
      models = next
    }
  }
}

/**
 * Edits the failure classes that move an alias to its next target, as a list of checkboxes, and
 * saves them when the operator is done.
 *
 * @param editor - the editor
 * @param name - the alias
 * @param start - the alias as it was when the menu opened
 */
async function editFallbackOn(editor: AliasEditor, name: string, start: AliasDraft): Promise<void> {
  const fallbackOn = await tickList(
    editor.screens,
    `Fall back from ${name} on`,
    FailureClassSchema.options,
    start.fallbackOn
  )
  if (fallbackOn !== undefined) {
    await save(editor, name, { ...start, fallbackOn }, { previousName: name })
  }
}

/**
 * Renames an alias, keeping its place.
 *
 * @param editor - the editor
 * @param name - the alias
 * @param draft - what it names
 */
async function rename(editor: AliasEditor, name: string, draft: AliasDraft): Promise<void> {
  const renamed = await askAliasName(editor, `New name for ${name}`, name)
  if (renamed !== undefined && renamed !== name) {
    await save(editor, renamed, draft, { previousName: name })
  }
}

/**
 * Deletes an alias once the operator confirms; says so when the file could not be written.
 *
 * @param editor - the editor
 * @param name - the alias
 */
async function confirmDelete(editor: AliasEditor, name: string): Promise<void> {
  const sure = await editor.screens.select(`Delete the alias ${name}?`, ['Delete it', 'Keep it'])
  if (sure !== 'Delete it') return
  if (deleteAlias(name)) await editor.refresh()
  else await notify(editor, NOT_WRITTEN)
}

/** An alias's menu: each entry and what it does. */
const ALIAS_ACTIONS: Readonly<
  Record<string, (editor: AliasEditor, name: string, draft: AliasDraft) => Promise<void>>
> = {
  'Rename': rename,
  'Targets and efforts': editTargets,
  'Fall back on (fallbackOn)': editFallbackOn,
  'Delete': (editor, name) => confirmDelete(editor, name)
}

/**
 * Runs what Enter does on a built-in `-latest` alias (#231): it has no config entry to rename or
 * delete, so its one action pins it, saving an alias of its name that replaces it.
 *
 * @param editor - the editor
 * @param name - the alias
 * @param target - the family it follows
 */
async function pinBuiltIn(editor: AliasEditor, name: string, target: AliasTarget): Promise<void> {
  const draft = draftOf(target)
  const choice = await editor.screens.select(`Alias ${name} (built in: follows the newest)`, [
    PIN_TO
  ])
  if (choice !== PIN_TO) return
  const next = await TARGET_ACTIONS[PIN_TO]?.(editor, draft.models, 0)
  if (next !== undefined) await save(editor, name, { ...draft, models: next }, { creating: true })
}

/**
 * Runs what Enter does on a Models view row: an alias's menu, or a new alias (for the row's
 * model, on a model's row).
 *
 * @param editor - the editor
 * @param item - the selected row
 */
export async function runModelsItem(editor: AliasEditor, item: ModelsItem): Promise<void> {
  if (item.kind !== 'alias') {
    await newAlias(editor, item.kind === 'model' ? item.model.canonicalId : undefined)
    return
  }
  if (item.builtIn) {
    await pinBuiltIn(editor, item.name, item.target)
    return
  }
  const draft = draftOf(item.target)
  const [only] = draft.models
  // A single family target is pinned from the alias's own menu; a chain's from its targets.
  const family = draft.models.length === 1 && only !== undefined && isFamilyTarget(only)
  const options = Object.keys(ALIAS_ACTIONS)
  // Pinning comes right after Rename, placed by name so a reordered menu keeps it there.
  const pinning = family ? [PIN_TO, FOLLOW_NEWEST] : []
  const choice = await editor.screens.select(
    `Alias ${item.name}`,
    options.flatMap((option) => (option === 'Rename' ? [option, ...pinning] : [option]))
  )
  if (choice === PIN_TO || choice === FOLLOW_NEWEST) {
    const next = await TARGET_ACTIONS[choice]?.(editor, draft.models, 0)
    if (next !== undefined) {
      await save(editor, item.name, { ...draft, models: next }, { previousName: item.name })
    }
    return
  }
  const action = choice === undefined ? undefined : ALIAS_ACTIONS[choice]
  await action?.(editor, item.name, draft)
}

/**
 * Opens what Enter does on the Models view's selected row, on pi's own dialogs.
 *
 * @param context - the console
 */
export function openSelectedModelsItem(context: ConsoleContext): void {
  const { status, modelsSelected } = context.state
  if (status?.exposure === undefined) return
  const item = modelsItemAt(modelsViewData(status), modelsSelected)
  const editor: AliasEditor = {
    screens: {
      select: (title, labels) => pickLabel(context.tui, title, labels),
      input: (title) => askLine(context.tui, title)
    },
    exposure: status.exposure,
    aliases: status.aliases,
    refresh: () => context.refresh()
  }
  inBackground(runModelsItem(editor, item), 'Editing aliases')
}
