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
  type FailureClass,
  FailureClassSchema
} from '@proxy/config/schema'
import type { ModelExposureResult } from '@proxy/openai/model-exposure'
import { supportedReasoningEfforts } from '@proxy/openai/reasoning-effort'
import {
  type AliasDraft,
  aliasNameProblem,
  deleteAlias,
  draftOf,
  saveAlias
} from '@proxy/tui/aliases'
import type { ConsoleContext } from '@proxy/tui/console'
import { inBackground } from '@proxy/tui/console-accounts'
import { askLine, pickLabel } from '@proxy/tui/dialogs'
import { modelsItemAt, type ModelsItem, modelsViewData } from '@proxy/tui/models-view'

/** The effort option that keeps the request's own `reasoning_effort`. */
const REQUEST_EFFORT = "The request's effort (not fixed)"
/** The option that ends a menu loop. */
const DONE = 'Done'
/** The option that adds a target. */
const ADD_TARGET = '+ Add a target…'

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
  const exposed = editor.exposure.byCanonicalId.get(chosen)
  // A target that is not exposed has no ladder to offer: only the request's effort is safe.
  const efforts = exposed === undefined ? [] : supportedReasoningEfforts(exposed.model)
  const label = await editor.screens.select(`Reasoning effort for ${chosen}`, [
    REQUEST_EFFORT,
    ...efforts
  ])
  if (label === undefined) return undefined
  const effort = efforts.find((level) => level === label)
  return effort === undefined ? { model: chosen } : { model: chosen, reasoningEffort: effort }
}

/**
 * Saves an alias, then reads the status again.
 *
 * @param editor - the editor
 * @param name - the alias
 * @param draft - its models and `fallbackOn`
 * @param previousName - the name it had, when renamed
 */
async function save(
  editor: AliasEditor,
  name: string,
  draft: AliasDraft,
  previousName?: string
): Promise<void> {
  saveAlias(name, draft, previousName)
  await editor.refresh()
}

/**
 * Creates an alias: its name, its first model and that model's effort.
 *
 * @param editor - the editor
 * @param model - the model to start from, when the alias was started from a model's row
 */
async function newAlias(editor: AliasEditor, model?: string): Promise<void> {
  const name = await askAliasName(editor, 'Name for the new alias (e.g. reviewer, builder-high)')
  if (name === undefined) return
  const target = await pickTarget(editor, `Model for ${name}`, model)
  if (target !== undefined) await save(editor, name, { models: [target], fallbackOn: [] })
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
    if (current === undefined) return undefined
    const target = await pickTarget(editor, '', current.model)
    return target === undefined ? undefined : models.with(index, target)
  },
  'Move up': (_editor, models, index) => Promise.resolve(swapped(models, index, index - 1)),
  'Move down': (_editor, models, index) => Promise.resolve(swapped(models, index, index + 1)),
  // An alias with no target names nothing; deleting the alias says that.
  'Remove': (_editor, models, index) =>
    Promise.resolve(models.length === 1 ? undefined : models.toSpliced(index, 1))
}

/**
 * Shows an alias's targets, each with its effort, and the menu's other rows.
 *
 * @param models - the targets
 * @returns one label per target, in order
 */
function targetLabels(models: readonly AliasModel[]): string[] {
  return models.map(({ model, reasoningEffort }, index) => {
    const effort = reasoningEffort === undefined ? '' : ` @${reasoningEffort}`
    return `${String(index + 1)}. ${model}${effort}`
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
  const action = await editor.screens.select(choice, Object.keys(TARGET_ACTIONS))
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
    if (next !== undefined) {
      models = next
      await save(editor, name, { models, fallbackOn: start.fallbackOn })
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
  const classes = FailureClassSchema.options
  const chosen = new Set<FailureClass>(start.fallbackOn)
  for (;;) {
    const rows = classes.map((failure) => `[${chosen.has(failure) ? 'x' : ' '}] ${failure}`)
    const choice = await editor.screens.select(`Fall back from ${name} on`, [...rows, DONE])
    if (choice === undefined) return
    if (choice === DONE) break
    const failure = classes[rows.indexOf(choice)]
    if (failure !== undefined && !chosen.delete(failure)) chosen.add(failure)
  }
  // In the schema's order, whatever order they were ticked in.
  const fallbackOn = classes.filter((failure) => chosen.has(failure))
  await save(editor, name, { ...start, fallbackOn })
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
  if (renamed !== undefined && renamed !== name) await save(editor, renamed, draft, name)
}

/**
 * Deletes an alias once the operator confirms.
 *
 * @param editor - the editor
 * @param name - the alias
 */
async function confirmDelete(editor: AliasEditor, name: string): Promise<void> {
  const sure = await editor.screens.select(`Delete the alias ${name}?`, ['Delete it', 'Keep it'])
  if (sure !== 'Delete it') return
  deleteAlias(name)
  await editor.refresh()
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
  const choice = await editor.screens.select(`Alias ${item.name}`, Object.keys(ALIAS_ACTIONS))
  const action = choice === undefined ? undefined : ALIAS_ACTIONS[choice]
  await action?.(editor, item.name, draftOf(item.target))
}

/**
 * Opens what Enter does on the Models view's selected row, on pi's own dialogs.
 *
 * @param context - the console
 */
export function openSelectedModelsItem(context: ConsoleContext): void {
  const { status, modelsSelected } = context.state
  if (status?.exposure === undefined) return
  const item = modelsItemAt(modelsViewData(status.exposure, status.aliases), modelsSelected)
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
