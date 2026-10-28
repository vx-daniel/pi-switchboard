/**
 * The console's Models view (#230): the exposed models as a matrix of the reasoning efforts each
 * supports, grouped by provider; an ALIASES box with every configured alias, its targets, efforts,
 * `fallbackOn`, what each family target resolves to (#231) and any diagnostic, then the row that
 * adds an alias; and a LATEST box with the built-in `-latest` aliases, apart from the operator's.
 *
 * @remarks
 * The selection moves over every row: Enter on a model starts a new alias for it, on an alias
 * opens its menu, on the new-alias row starts a new alias, and on a built-in alias offers to pin
 * it. The matrix and the boxes each scroll to keep the selection on screen, since a login can
 * expose more models than the screen has rows. The boxes sit beside the matrix on a wide view,
 * under it otherwise, ALIASES above LATEST.
 *
 * @packageDocumentation
 */

import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'
import {
  type AliasModel,
  type AliasTarget,
  aliasFallbackOn,
  aliasModels,
  type FamilyTarget,
  isAliasChain,
  isFamilyTarget
} from '@proxy/config/schema'
import type { AliasDiagnostic, FamilyResolution } from '@proxy/openai/model-aliases'
import type { ExposedModel, ModelExposureResult } from '@proxy/openai/model-exposure'
import { supportedReasoningEfforts } from '@proxy/openai/reasoning-effort'
import { REASONING_EFFORTS, type ReasoningEffort } from '@proxy/openai/schemas'
import { activeCooldown, loginSubject } from '@proxy/pi/cooldowns'
import { compactDuration, firstShown, FRAME_COLUMNS, panel } from '@proxy/tui/panel'
import { highlight, paint, strong, tabAccent } from '@proxy/tui/theme'
import { MS_PER_SECOND } from '@proxy/utils/time'

/** The label of the row after the aliases, which adds one. */
const NEW_ALIAS_ROW = '+ New alias…'
/** Each effort's heading over its column of the matrix, short enough for {@link EFFORT_COLUMNS}. */
const EFFORT_HEADINGS: Readonly<Record<ReasoningEffort, string>> = {
  none: 'none',
  minimal: 'min',
  low: 'low',
  medium: 'med',
  high: 'high',
  xhigh: 'xhi',
  max: 'max'
}
/** Columns per effort in the matrix. */
const EFFORT_COLUMNS = 6
/** Columns the effort cells take together. */
const EFFORTS_WIDTH = REASONING_EFFORTS.length * EFFORT_COLUMNS
/** Columns the selection mark takes before a row: `› ` or two spaces. */
const MARK_COLUMNS = 2
/** The matrix's model column: as wide as fits between these. */
const NAME_COLUMNS = { least: 14, most: 30 } as const
/**
 * Columns after the effort cells for a model's cooldown, its space before it included: at least
 * the longest countdown, `cooling 12d23h`; at most with its reason as well.
 */
const COOLDOWN_COLUMNS = { least: 15, most: 29 } as const
/** The alias column in the ALIASES box. */
const ALIAS_NAME_COLUMNS = 16
/** Where an alias's targets start in the box: after the selection mark, the alias and a space. */
const ALIAS_TARGETS_COLUMN = MARK_COLUMNS + ALIAS_NAME_COLUMNS + 1
/** Where a diagnostic starts in the box, under its alias. */
const DIAGNOSTIC_INDENT = '    '
/**
 * The ALIASES box's narrowest width beside the matrix: an alias and one family target with what
 * it resolves to (`anthropic/claude-opus → claude-opus-5-5 (newest)`) need about this much.
 */
const ALIAS_BOX_LEAST_WIDTH = 60
/** Columns between the matrix and the ALIASES box beside it. */
const PANE_GAP = 2
/** The narrowest view with the box beside the matrix rather than under it. */
const SIDE_BY_SIDE_LEAST_WIDTH =
  MARK_COLUMNS +
  NAME_COLUMNS.most +
  EFFORTS_WIDTH +
  COOLDOWN_COLUMNS.least +
  PANE_GAP +
  ALIAS_BOX_LEAST_WIDTH
/** Rows the matrix and the box keep at least when one is under the other: a heading and a few rows. */
const PART_LEAST_ROWS = 5
/** The shortest view with both the matrix and the box under it. */
const STACKED_LEAST_ROWS = PART_LEAST_ROWS + PART_LEAST_ROWS
/** Halves of a cell's spare columns: one before a centred text, one after. */
const HALVES = 2
/** Rows a box's frame takes. */
const BOX_BORDER_ROWS = 2

/** What the Models view lists: the exposed models, the configured and the built-in aliases. */
export interface ModelsData {
  /** The exposed models, in list order. */
  readonly models: readonly ExposedModel[]
  /** The configured aliases, as the config holds them, exposed or not. */
  readonly aliases: Readonly<Record<string, AliasTarget>>
  /** The built-in `-latest` aliases (#231), in the LATEST box; absent for none. */
  readonly latest?: Readonly<Record<string, FamilyTarget>>
  /** Why aliases or their targets are left out. */
  readonly diagnostics: readonly AliasDiagnostic[]
  /** What each family target resolves to now (#231). */
  readonly families: readonly FamilyResolution[]
  /** Why nothing is listed: the exposure config's error. */
  readonly unavailable?: string
}

/** What the Models view shows. */
export interface ModelsView extends ModelsData {
  /** The selected item: a model, an alias, the new-alias row, then a built-in alias. */
  readonly selected: number
}

/** What the view reads from the console's last status. */
export interface ModelsStatus {
  /** The exposure last read; `undefined` with an invalid exposure config. */
  readonly exposure: ModelExposureResult | undefined
  /** The configured aliases. */
  readonly aliases: Readonly<Record<string, AliasTarget>>
  /** The exposed model count, or why the exposure config is invalid. */
  readonly exposed: number | string
}

/**
 * Gathers what the view lists from the console's last status.
 *
 * @param status - the last status read, or `undefined` before the first read
 * @returns the models, the aliases and their diagnostics, and why there are none when the
 *   exposure config is invalid; nothing before the first read
 */
export function modelsViewData(status: ModelsStatus | undefined): ModelsData {
  if (status === undefined) return { models: [], aliases: {}, diagnostics: [], families: [] }
  const { exposure, exposed } = status
  return {
    models: exposure?.models ?? [],
    aliases: status.aliases,
    latest: exposure?.latestAliases ?? {},
    diagnostics: exposure?.aliasDiagnostics ?? [],
    families: exposure?.familyResolutions ?? [],
    ...(typeof exposed === 'string' ? { unavailable: exposed } : {})
  }
}

/** What a selected item is. */
export type ModelsItem =
  | { readonly kind: 'model'; readonly model: ExposedModel }
  | { readonly kind: 'alias'; readonly name: string; readonly target: AliasTarget }
  | { readonly kind: 'new' }
  /** A built-in `-latest` alias, which only a configured alias of its name changes. */
  | { readonly kind: 'latest'; readonly name: string; readonly target: FamilyTarget }

/** The exposed models of one provider, in list order. */
interface ProviderGroup {
  readonly provider: string
  readonly models: readonly ExposedModel[]
}

/**
 * Groups the exposed models by provider, the providers in the order they first appear. The
 * matrix shows them in these groups, and the selection moves in the same order.
 *
 * @param models - the exposed models, in list order
 * @returns the groups
 */
function providerGroups(models: readonly ExposedModel[]): ProviderGroup[] {
  const groups = new Map<string, ExposedModel[]>()
  for (const model of models) {
    const group = groups.get(model.provider)
    if (group === undefined) groups.set(model.provider, [model])
    else group.push(model)
  }
  return [...groups].map(([provider, members]) => ({ provider, models: members }))
}

/**
 * Lists the view's selectable items in order: the models by provider, the aliases, the new-alias
 * row, then the built-in aliases.
 *
 * @param view - the models and the aliases
 * @returns every item
 */
export function modelsItems(
  view: Pick<ModelsData, 'models' | 'aliases' | 'latest'>
): readonly ModelsItem[] {
  const models = providerGroups(view.models).flatMap((group) => group.models)
  return [
    ...models.map((model): ModelsItem => ({ kind: 'model', model })),
    ...Object.entries(view.aliases).map(([name, target]): ModelsItem => ({
      kind: 'alias',
      name,
      target
    })),
    { kind: 'new' },
    ...Object.entries(view.latest ?? {}).map(([name, target]): ModelsItem => ({
      kind: 'latest',
      name,
      target
    }))
  ]
}

/**
 * Finds the selected item, keeping the selection on the list.
 *
 * @param data - the models and the aliases
 * @param selected - the selected row, which may be past the list's end after a delete
 * @returns the item; the last one when the selection is past the end
 */
export function modelsItemAt(data: ModelsData, selected: number): ModelsItem {
  const items = modelsItems(data)
  return items[Math.min(Math.max(selected, 0), items.length - 1)] ?? { kind: 'new' }
}

/** The matrix's widths that change with the view. */
interface MatrixColumns {
  /** The model column. */
  readonly name: number
  /** Columns after the effort cells for a cooldown. */
  readonly cooldown: number
}

/**
 * Renders a model's cooldown, if it has one: the time left (`42s`, `3m00s`), and the reason when it fits too,
 * so a narrow cell keeps the countdown.
 *
 * @param model - the exposed model
 * @param now - the time now, in milliseconds since the epoch
 * @param room - the cell's columns
 * @returns the cell, or `''`
 */
function cooldownCell(model: ExposedModel, now: number, room: number): string {
  const cooldown = activeCooldown(loginSubject(model), now)
  if (cooldown === undefined) return ''
  // Rounded up to the second: a cooldown with a moment left still reads `1s`, not `0s`.
  const left = Math.max(0, Math.ceil((cooldown.until - now) / MS_PER_SECOND)) * MS_PER_SECOND
  const countdown = `cooling ${compactDuration(left)}`
  const withReason = `${countdown} ${cooldown.reason}`
  return paint('warning', visibleWidth(withReason) <= room ? withReason : countdown)
}

/**
 * Centres a text in an effort's column.
 *
 * @param text - the text, at most {@link EFFORT_COLUMNS} wide
 * @returns the cell
 */
function effortCell(text: string): string {
  const before = Math.floor((EFFORT_COLUMNS - visibleWidth(text)) / HALVES)
  const after = Math.max(0, EFFORT_COLUMNS - before - visibleWidth(text))
  return `${' '.repeat(before)}${text}${' '.repeat(after)}`
}

/**
 * Renders one exposed model: its public ID, a dot under each effort it supports, any cooldown.
 *
 * @param model - the exposed model
 * @param columns - the model column's and the cooldown's widths
 * @param now - the time now, for the cooldown
 * @returns the row's text, without its selection mark
 */
function modelRow(model: ExposedModel, columns: MatrixColumns, now: number): string {
  const supported = new Set<ReasoningEffort>(supportedReasoningEfforts(model.model))
  const cells = REASONING_EFFORTS.map((effort) =>
    effortCell(supported.has(effort) ? paint('accent', '●') : paint('border', '·'))
  )
  const name = truncateToWidth(model.publicId, columns.name, '…', true)
  return `${name}${cells.join('')} ${cooldownCell(model, now, columns.cooldown)}`
}

/**
 * Shortens a canonical ID to its model ID, for a family's members: the family names the provider.
 *
 * @param canonicalId - `provider/model-id`
 * @returns the model ID
 */
function modelIdOf(canonicalId: string): string {
  return canonicalId.slice(canonicalId.indexOf('/') + 1)
}

/**
 * Renders a family target with what it resolves to: `→ claude-opus-5-5 (newest)`, or its pin and
 * the newest, and a newer member the exposure config hides.
 *
 * @param family - the family target's family
 * @param resolution - what it resolves to now, or `undefined` for an unknown family
 * @returns the cell
 */
function familyCell(family: string, resolution: FamilyResolution | undefined): string {
  if (resolution === undefined) return family
  const newest = resolution.newest === null ? 'none exposed' : modelIdOf(resolution.newest)
  const shown =
    resolution.pin === null
      ? `${family} → ${newest} (newest)`
      : `${family} pinned: ${modelIdOf(resolution.pin)} · newest: ${newest}`
  if (resolution.newerHidden === null) return shown
  return `${shown}${paint('dim', ` · newer hidden: ${modelIdOf(resolution.newerHidden)}`)}`
}

/**
 * Renders one alias target, with the effort it sets.
 *
 * @param target - the target
 * @param resolution - what it resolves to, for a family target
 * @returns the cell
 */
function targetCell(target: AliasModel, resolution: FamilyResolution | undefined): string {
  const shown = isFamilyTarget(target) ? familyCell(target.family, resolution) : target.model
  return target.reasoningEffort === undefined ? shown : `${shown} @${target.reasoningEffort}`
}

/**
 * Renders one alias: its name, its targets each with the effort it sets, and `fallbackOn`, wrapped
 * onto more lines under the targets when they don't fit, so a chain and its family resolutions
 * are never cut.
 *
 * @param alias - the alias
 * @param alias.name - its name
 * @param alias.target - what it names
 * @param alias.selected - whether it is the selected row
 * @param families - what the family targets resolve to now
 * @param width - the box's content columns
 * @returns the alias's lines, the first with its selection mark
 */
function aliasLines(
  alias: { readonly name: string; readonly target: AliasTarget; readonly selected: boolean },
  families: readonly FamilyResolution[],
  width: number
): string[] {
  const { name, target, selected } = alias
  const targets = aliasModels(target)
    .map((aliasTarget, position) =>
      targetCell(
        aliasTarget,
        families.find((family) => family.alias === name && family.position === position)
      )
    )
    .join(' › ')
  const fallback = isAliasChain(target)
    ? paint('dim', `  on ${aliasFallbackOn(target).join(', ') || 'nothing'}`)
    : ''
  const wrapped = wrapTextWithAnsi(
    `${targets}${fallback}`,
    Math.max(1, width - ALIAS_TARGETS_COLUMN)
  )
  const [first = '', ...rest] = wrapped
  const head = selectable(
    `${truncateToWidth(name, ALIAS_NAME_COLUMNS, '…', true)} ${first}`,
    selected
  )
  return [head, ...rest.map((line) => `${' '.repeat(ALIAS_TARGETS_COLUMN)}${line}`)]
}

/**
 * Renders an alias's diagnostic under it, wrapped to the box: it says why the proxy leaves the
 * alias or a target out, so it is never cut.
 *
 * @param diagnostic - the diagnostic
 * @param width - the box's content columns
 * @returns its lines
 */
function diagnosticLines(diagnostic: AliasDiagnostic, width: number): string[] {
  const text = `${diagnostic.code}: ${diagnostic.message}`
  return wrapTextWithAnsi(text, Math.max(1, width - DIAGNOSTIC_INDENT.length)).map((line) =>
    paint('error', `${DIAGNOSTIC_INDENT}${line}`)
  )
}

/**
 * Marks the selected row: a pointer, in the theme's selection colors.
 *
 * @param text - the row's text
 * @param selected - whether it is the selected row
 * @returns the row, indented
 */
function selectable(text: string, selected: boolean): string {
  return selected ? highlight(`› ${text}`) : `  ${text}`
}

/** One part of the view, the matrix or the box, before it is scrolled. */
interface ViewPart {
  /** The heading lines, kept on screen while the rest scrolls. */
  readonly heading: readonly string[]
  readonly lines: readonly string[]
  /** The line of the selected item, when it is in this part. */
  readonly selectedLine: number | undefined
  /** The lines that hold a model, in the matrix; none in a box. */
  readonly modelLines?: readonly number[]
}

/**
 * Lays out the matrix: a heading with the efforts, then each provider's name and model count,
 * and its models, a blank line between providers.
 *
 * @param view - the models and the selection
 * @param columns - the model column's and the cooldown's widths
 * @param now - the time now, for cooldowns
 * @returns the matrix's lines
 */
function matrixPart(view: ModelsView, columns: MatrixColumns, now: number): ViewPart {
  const efforts = REASONING_EFFORTS.map((effort) => effortCell(EFFORT_HEADINGS[effort])).join('')
  const heading = paint(
    'dim',
    `${' '.repeat(MARK_COLUMNS)}${'model'.padEnd(columns.name)}${efforts}`
  )
  const lines: string[] = []
  let selectedLine: number | undefined
  const modelLines: number[] = []
  let position = 0
  for (const [groupIndex, group] of providerGroups(view.models).entries()) {
    if (groupIndex > 0) lines.push('')
    const count = `${String(group.models.length)} model${group.models.length === 1 ? '' : 's'}`
    lines.push(`  ${strong(tabAccent(group.provider))}  ${paint('dim', count)}`)
    for (const model of group.models) {
      if (position === view.selected) selectedLine = lines.length
      modelLines.push(lines.length)
      lines.push(selectable(modelRow(model, columns, now), position === view.selected))
      position += 1
    }
  }
  if (lines.length === 0) lines.push(paint('dim', '  No models exposed.'))
  return { heading: [heading], lines, selectedLine, modelLines }
}

/**
 * Renders a run of aliases, each with its diagnostics under it.
 *
 * @param entries - the aliases, by name
 * @param first - the first one's place among the view's items
 * @param view - the diagnostics, the family resolutions and the selection
 * @param width - the box's content columns
 * @returns the lines, and the selected alias's line when it is one of them
 */
function aliasEntryLines(
  entries: readonly (readonly [string, AliasTarget])[],
  first: number,
  view: ModelsView,
  width: number
): { readonly lines: string[]; readonly selectedLine: number | undefined } {
  const lines: string[] = []
  let selectedLine: number | undefined
  for (const [offset, [aliasName, target]] of entries.entries()) {
    const selected = first + offset === view.selected
    if (selected) selectedLine = lines.length
    lines.push(...aliasLines({ name: aliasName, target, selected }, view.families, width))
    for (const diagnostic of view.diagnostics.filter(({ alias }) => alias === aliasName)) {
      lines.push(...diagnosticLines(diagnostic, width))
    }
  }
  return { lines, selectedLine }
}

/**
 * Lays out the ALIASES box's content: a heading, each configured alias with its diagnostics
 * under it, then the new-alias row.
 *
 * @param view - the models, the aliases with their diagnostics, and the selection
 * @param width - the box's content columns
 * @returns the box's lines, without its frame
 */
function aliasPart(view: ModelsView, width: number): ViewPart {
  const heading = paint('dim', `  ${'alias'.padEnd(ALIAS_NAME_COLUMNS)} targets`)
  const entries = Object.entries(view.aliases)
  const { lines, selectedLine } = aliasEntryLines(entries, view.models.length, view, width)
  const onNew = view.models.length + entries.length === view.selected
  return {
    heading: [heading],
    lines: [...lines, selectable(NEW_ALIAS_ROW, onNew)],
    selectedLine: onNew ? lines.length : selectedLine
  }
}

/**
 * Lays out the LATEST box's content: a heading, then each built-in `-latest` alias with what its
 * family resolves to.
 *
 * @param view - the models, the aliases, and the selection
 * @param width - the box's content columns
 * @returns the box's lines, without its frame; none without built-in aliases
 */
function latestPart(view: ModelsView, width: number): ViewPart {
  const heading = paint('dim', `  ${'alias'.padEnd(ALIAS_NAME_COLUMNS)} family`)
  // After the models, the configured aliases and the new-alias row.
  const first = view.models.length + Object.keys(view.aliases).length + 1
  return {
    heading: [heading],
    ...aliasEntryLines(Object.entries(view.latest ?? {}), first, view, width)
  }
}

/** One of the boxes beside or under the matrix: its title, count and content. */
interface SideBox {
  readonly title: string
  readonly count: number
  readonly part: ViewPart
}

/**
 * Lays out the boxes: ALIASES, then LATEST while there is a built-in alias.
 *
 * @param view - what the view shows
 * @param width - the boxes' columns, their frames included
 * @returns the boxes, top first
 */
function sideBoxes(view: ModelsView, width: number): readonly SideBox[] {
  const aliases: SideBox = {
    title: 'ALIASES',
    count: Object.keys(view.aliases).length,
    part: aliasPart(view, width - FRAME_COLUMNS)
  }
  const latestCount = Object.keys(view.latest ?? {}).length
  if (latestCount === 0) return [aliases]
  const latest = latestPart(view, width - FRAME_COLUMNS)
  return [aliases, { title: 'LATEST', count: latestCount, part: latest }]
}

/**
 * Counts the rows a box wants: its heading, every line, and its frame.
 *
 * @param box - the box
 * @returns the rows
 */
function boxWanted(box: SideBox): number {
  return box.part.heading.length + box.part.lines.length + BOX_BORDER_ROWS
}

/**
 * Shares a height among stacked boxes. Each gets what it wants when they fit; otherwise the
 * focused one takes what the others leave while each keeps {@link PART_LEAST_ROWS}, and the others
 * share the rest, top first.
 *
 * @param wanted - the rows each box wants, top first
 * @param focus - the box with the selection, or the first
 * @param height - the rows for all of them
 * @returns each box's rows
 */
function boxHeights(wanted: readonly number[], focus: number, height: number): number[] {
  if (wanted.reduce((total, rows) => total + rows, 0) <= height) return [...wanted]
  const othersLeast = wanted.reduce(
    (total, rows, place) => (place === focus ? total : total + Math.min(rows, PART_LEAST_ROWS)),
    0
  )
  const focused = Math.min(wanted[focus] ?? 0, Math.max(0, height - othersLeast))
  let left = height - focused
  return wanted.map((rows, place) => {
    if (place === focus) return focused
    const given = Math.min(rows, left)
    left -= given
    return given
  })
}

/**
 * Stacks the boxes in a height, the one with the selection (the first, when none has it) given
 * the room when they don't all fit; each scrolls to keep its selected line on screen.
 *
 * @param boxes - the boxes, top first
 * @param size - the rows and columns for them
 * @param size.height - rows
 * @param size.width - columns
 * @returns the rows
 */
function stackedBoxes(
  boxes: readonly SideBox[],
  size: { readonly height: number; readonly width: number }
): string[] {
  const focus = Math.max(
    0,
    boxes.findIndex((box) => box.part.selectedLine !== undefined)
  )
  const heights = boxHeights(boxes.map(boxWanted), focus, size.height)
  return boxes.flatMap((box, place) => {
    const height = heights[place] ?? 0
    // A frame with no room inside says nothing: the box gives its rows up.
    if (height <= BOX_BORDER_ROWS) return []
    const content = scrolled(box.part, height - BOX_BORDER_ROWS)
    return panel(box.title, content, size.width, String(box.count)).slice(0, height)
  })
}

/**
 * Scrolls a part to a height, keeping its heading and its selected line on screen.
 *
 * @param part - the part
 * @param height - rows for it
 * @returns the rows shown
 */
function scrolled(part: ViewPart, height: number): string[] {
  const { first, room } = scrollWindow(part, height)
  return [...part.heading, ...part.lines.slice(first, first + room)].slice(0, Math.max(0, height))
}

/**
 * Works out which of a part's lines show in a height: those from `first`, `room` of them.
 *
 * @param part - the part
 * @param height - rows for it, its heading included
 * @returns the first line shown and how many lines show
 */
function scrollWindow(part: ViewPart, height: number): { first: number; room: number } {
  const room = Math.max(0, height - part.heading.length)
  return { first: firstShown(part.selectedLine ?? 0, part.lines.length, room), room }
}

/**
 * Counts the matrix's models that show in a height.
 *
 * @param part - the matrix
 * @param height - rows for it, its heading included
 * @returns the models shown
 */
function shownModels(part: ViewPart, height: number): number {
  const { first, room } = scrollWindow(part, height)
  return (part.modelLines ?? []).filter((line) => line >= first && line < first + room).length
}

/** The Models view rendered: its rows, and how many of its models show. */
interface ModelsLayout {
  readonly rows: string[]
  readonly shown: number
}

/** The Models view rendered, with what the frame's bottom border says about it. */
export interface ModelsRender {
  readonly rows: string[]
  /**
   * `k of N models shown · ↑↓` while the matrix is taller than its space, so some models are cut
   * off (whether above or below); `''` while every model shows, for the frame's usual note.
   */
  readonly note: string
}

/**
 * Fits a row to a width: cut with `…` or padded with spaces.
 *
 * @param row - the row
 * @param width - the columns
 * @returns the row, exactly `width` columns
 */
function fitted(row: string, width: number): string {
  return truncateToWidth(row, Math.max(0, width), '…', true)
}

/**
 * Checks whether any exposed model is cooling down now.
 *
 * @param models - the exposed models
 * @param now - the time now
 * @returns whether one is
 */
function anyCooling(models: readonly ExposedModel[], now: number): boolean {
  return models.some((model) => activeCooldown(loginSubject(model), now) !== undefined)
}

/**
 * Counts the columns a cooldown has in the matrix: what is left after the mark, the model column,
 * the effort cells and a space.
 *
 * @param matrixWidth - the matrix's columns
 * @param nameColumns - the model column's width
 * @returns the columns, none when the row is full
 */
function cooldownRoom(matrixWidth: number, nameColumns: number): number {
  return Math.max(0, matrixWidth - MARK_COLUMNS - nameColumns - EFFORTS_WIDTH - 1)
}

/**
 * Puts the box beside the matrix: the matrix takes what the effort cells and a cooldown need, the
 * box the rest.
 *
 * @param view - what the view shows
 * @param size - the view's rows and columns
 * @param size.height - rows
 * @param size.width - columns
 * @param now - the time now, for cooldowns
 * @returns the rows
 */
function sideBySideRows(
  view: ModelsView,
  size: { readonly height: number; readonly width: number },
  now: number
): ModelsLayout {
  // Room for a cooldown's reason only while a model is cooling: the box takes it otherwise.
  const cooldownColumns = anyCooling(view.models, now)
    ? COOLDOWN_COLUMNS.most
    : COOLDOWN_COLUMNS.least
  const matrixWidth = Math.min(
    MARK_COLUMNS + NAME_COLUMNS.most + EFFORTS_WIDTH + cooldownColumns,
    size.width - PANE_GAP - ALIAS_BOX_LEAST_WIDTH
  )
  const boxWidth = size.width - matrixWidth - PANE_GAP
  const box = stackedBoxes(sideBoxes(view, boxWidth), { height: size.height, width: boxWidth })
  const columns = {
    name: NAME_COLUMNS.most,
    cooldown: cooldownRoom(matrixWidth, NAME_COLUMNS.most)
  }
  const part = matrixPart(view, columns, now)
  const matrix = scrolled(part, size.height)
  const rows = Array.from(
    { length: Math.min(size.height, Math.max(matrix.length, box.length)) },
    (_, row) =>
      `${fitted(matrix[row] ?? '', matrixWidth)}${' '.repeat(PANE_GAP)}${fitted(box[row] ?? '', boxWidth)}`
  )
  return { rows, shown: shownModels(part, size.height) }
}

/**
 * Puts the boxes under the matrix. When they don't all fit, each keeps {@link PART_LEAST_ROWS} and
 * the boxes give up the rest to the matrix; on a screen too short for both, only the part with
 * the selection shows.
 *
 * @param view - what the view shows
 * @param size - the view's rows and columns
 * @param size.height - rows
 * @param size.width - columns
 * @param now - the time now, for cooldowns
 * @returns the rows
 */
function stackedRows(
  view: ModelsView,
  size: { readonly height: number; readonly width: number },
  now: number
): ModelsLayout {
  const nameColumns = Math.max(
    NAME_COLUMNS.least,
    Math.min(NAME_COLUMNS.most, size.width - MARK_COLUMNS - EFFORTS_WIDTH - COOLDOWN_COLUMNS.least)
  )
  const columns = { name: nameColumns, cooldown: cooldownRoom(size.width, nameColumns) }
  const matrix = matrixPart(view, columns, now)
  const boxes = sideBoxes(view, size.width)
  const boxesWanted = boxes.reduce((total, box) => total + boxWanted(box), 0)
  let boxHeight = Math.min(boxesWanted, Math.max(PART_LEAST_ROWS, size.height - PART_LEAST_ROWS))
  if (size.height < STACKED_LEAST_ROWS) {
    // Too short for both: the part with the selection takes the screen.
    boxHeight = matrix.selectedLine === undefined ? size.height : 0
  }
  const matrixHeight = Math.min(
    size.height - boxHeight,
    matrix.heading.length + matrix.lines.length
  )
  const rows = [
    ...scrolled(matrix, matrixHeight),
    ...stackedBoxes(boxes, { height: boxHeight, width: size.width })
  ]
  return {
    rows: rows.map((row) => fitted(row, size.width)),
    shown: shownModels(matrix, matrixHeight)
  }
}

/**
 * Renders the Models view: the box beside the matrix from {@link SIDE_BY_SIDE_LEAST_WIDTH}
 * columns, under it otherwise, each scrolled so the selected row shows.
 *
 * @param view - the models, the aliases with their diagnostics, and the selection
 * @param size - the space available
 * @param size.height - rows
 * @param size.width - columns
 * @param now - the time now, for cooldowns
 * @returns the rows, one line saying why when the exposure config is invalid, and the note while
 *   some models are cut off
 */
export function modelsRows(
  view: ModelsView,
  size: { readonly height: number; readonly width: number },
  now: number = Date.now()
): ModelsRender {
  if (view.unavailable !== undefined) {
    const why = fitted(paint('error', `  Models unavailable: ${view.unavailable}`), size.width)
    return { rows: [why], note: '' }
  }
  const items = modelsItems(view)
  const selected = Math.min(Math.max(view.selected, 0), items.length - 1)
  const clamped = { ...view, selected }
  const { rows, shown } =
    size.width >= SIDE_BY_SIDE_LEAST_WIDTH
      ? sideBySideRows(clamped, size, now)
      : stackedRows(clamped, size, now)
  const total = view.models.length
  const note = shown < total ? `${String(shown)} of ${String(total)} models shown · ↑↓` : ''
  return { rows, note }
}
