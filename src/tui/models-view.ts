/**
 * The console's Models view (#230): the exposed models as a matrix of the reasoning efforts each
 * supports, grouped by provider, and an ALIASES box with every configured alias, its targets,
 * efforts, `fallbackOn`, what each family target resolves to (#231) and any diagnostic, then the
 * row that adds an alias.
 *
 * @remarks
 * The selection moves over every row: Enter on a model starts a new alias for it, on an alias
 * opens its menu, and on the last row starts a new alias. The matrix and the box each scroll to
 * keep the selection on screen, since a login can expose more models than the screen has rows.
 * The box sits beside the matrix on a wide view, under it otherwise.
 *
 * @packageDocumentation
 */

import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'
import {
  type AliasModel,
  type AliasTarget,
  aliasFallbackOn,
  aliasModels,
  isAliasChain,
  isFamilyTarget
} from '@proxy/config/schema'
import type { AliasDiagnostic, FamilyResolution } from '@proxy/openai/model-aliases'
import type { ExposedModel, ModelExposureResult } from '@proxy/openai/model-exposure'
import { supportedReasoningEfforts } from '@proxy/openai/reasoning-effort'
import { REASONING_EFFORTS, type ReasoningEffort } from '@proxy/openai/schemas'
import { activeCooldown, loginSubject } from '@proxy/pi/cooldowns'
import { firstShown, FRAME_COLUMNS, panel } from '@proxy/tui/panel'
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
 * Columns after the effort cells for a model's cooldown: at least `cooling 59s`, at most with its
 * reason as well.
 */
const COOLDOWN_COLUMNS = { least: 12, most: 26 } as const
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
/** Rows the ALIASES box's frame takes. */
const BOX_BORDER_ROWS = 2

/** What the Models view lists: the exposed models and the configured aliases. */
export interface ModelsData {
  /** The exposed models, in list order. */
  readonly models: readonly ExposedModel[]
  /** The configured aliases, as the config holds them, exposed or not. */
  readonly aliases: Readonly<Record<string, AliasTarget>>
  /** Why aliases or their targets are left out. */
  readonly diagnostics: readonly AliasDiagnostic[]
  /** What each family target resolves to now (#231). */
  readonly families: readonly FamilyResolution[]
  /** Why nothing is listed: the exposure config's error. */
  readonly unavailable?: string
}

/** What the Models view shows. */
export interface ModelsView extends ModelsData {
  /** The selected item: a model, then an alias, then the new-alias row. */
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
  const exposed = status?.exposed
  return {
    models: status?.exposure?.models ?? [],
    aliases: status?.aliases ?? {},
    diagnostics: status?.exposure?.aliasDiagnostics ?? [],
    families: status?.exposure?.familyResolutions ?? [],
    ...(typeof exposed === 'string' ? { unavailable: exposed } : {})
  }
}

/** What a selected item is. */
export type ModelsItem =
  | { readonly kind: 'model'; readonly model: ExposedModel }
  | { readonly kind: 'alias'; readonly name: string; readonly target: AliasTarget }
  | { readonly kind: 'new' }

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
 * Lists the view's selectable items in order: the models by provider, the aliases, then the
 * new-alias row.
 *
 * @param view - the models and the aliases
 * @returns every item
 */
export function modelsItems(view: Pick<ModelsData, 'models' | 'aliases'>): readonly ModelsItem[] {
  const models = providerGroups(view.models).flatMap((group) => group.models)
  return [
    ...models.map((model): ModelsItem => ({ kind: 'model', model })),
    ...Object.entries(view.aliases).map(([name, target]): ModelsItem => ({
      kind: 'alias',
      name,
      target
    })),
    { kind: 'new' }
  ]
}

/**
 * Finds the selected item, keeping the selection on the list.
 *
 * @param data - the models and the aliases
 * @param selected - the selected row, which may be past the list's end after a delete
 * @returns the item; the new-alias row when the selection is past the end
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
 * Renders a model's cooldown, if it has one: the seconds left, and the reason when it fits too,
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
  const left = Math.max(0, Math.ceil((cooldown.until - now) / MS_PER_SECOND))
  const countdown = `cooling ${String(left)}s`
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
  let position = 0
  for (const [groupIndex, group] of providerGroups(view.models).entries()) {
    if (groupIndex > 0) lines.push('')
    const count = `${String(group.models.length)} model${group.models.length === 1 ? '' : 's'}`
    lines.push(`  ${strong(tabAccent(group.provider))}  ${paint('dim', count)}`)
    for (const model of group.models) {
      if (position === view.selected) selectedLine = lines.length
      lines.push(selectable(modelRow(model, columns, now), position === view.selected))
      position += 1
    }
  }
  if (lines.length === 0) lines.push(paint('dim', '  No models exposed.'))
  return { heading: [heading], lines, selectedLine }
}

/**
 * Lays out the ALIASES box's content: a heading, each alias with its diagnostics under it, then
 * the new-alias row.
 *
 * @param view - the models, the aliases with their diagnostics, and the selection
 * @param width - the box's content columns
 * @returns the box's lines, without its frame
 */
function aliasPart(view: ModelsView, width: number): ViewPart {
  const heading = paint('dim', `  ${'alias'.padEnd(ALIAS_NAME_COLUMNS)} targets`)
  const lines: string[] = []
  let selectedLine: number | undefined
  let position = view.models.length
  for (const [aliasName, target] of Object.entries(view.aliases)) {
    if (position === view.selected) selectedLine = lines.length
    const selected = position === view.selected
    lines.push(...aliasLines({ name: aliasName, target, selected }, view.families, width))
    for (const diagnostic of view.diagnostics.filter(({ alias }) => alias === aliasName)) {
      lines.push(...diagnosticLines(diagnostic, width))
    }
    position += 1
  }
  if (position === view.selected) selectedLine = lines.length
  lines.push(selectable(NEW_ALIAS_ROW, position === view.selected))
  return { heading: [heading], lines, selectedLine }
}

/**
 * Scrolls a part to a height, keeping its heading and its selected line on screen.
 *
 * @param part - the part
 * @param height - rows for it
 * @returns the rows shown
 */
function scrolled(part: ViewPart, height: number): string[] {
  const room = Math.max(0, height - part.heading.length)
  const first = firstShown(part.selectedLine ?? 0, part.lines.length, room)
  return [...part.heading, ...part.lines.slice(first, first + room)].slice(0, Math.max(0, height))
}

/**
 * Frames the ALIASES box around its scrolled content.
 *
 * @param part - the box's content
 * @param aliasCount - the configured aliases, for the title
 * @param size - the box's rows and columns, its frame included
 * @param size.height - rows
 * @param size.width - columns
 * @returns the box's rows
 */
function aliasBox(
  part: ViewPart,
  aliasCount: number,
  size: { readonly height: number; readonly width: number }
): string[] {
  const content = scrolled(part, size.height - BOX_BORDER_ROWS)
  return panel('ALIASES', content, size.width, String(aliasCount)).slice(0, size.height)
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
): string[] {
  // Room for a cooldown's reason only while a model is cooling: the box takes it otherwise.
  const cooldownColumns = anyCooling(view.models, now)
    ? COOLDOWN_COLUMNS.most
    : COOLDOWN_COLUMNS.least
  const matrixWidth = Math.min(
    MARK_COLUMNS + NAME_COLUMNS.most + EFFORTS_WIDTH + cooldownColumns,
    size.width - PANE_GAP - ALIAS_BOX_LEAST_WIDTH
  )
  const boxWidth = size.width - matrixWidth - PANE_GAP
  const aliases = aliasPart(view, boxWidth - FRAME_COLUMNS)
  const boxHeight = Math.min(
    size.height,
    aliases.heading.length + aliases.lines.length + BOX_BORDER_ROWS
  )
  const box = aliasBox(aliases, Object.keys(view.aliases).length, {
    height: boxHeight,
    width: boxWidth
  })
  const columns = {
    name: NAME_COLUMNS.most,
    cooldown: cooldownRoom(matrixWidth, NAME_COLUMNS.most)
  }
  const matrix = scrolled(matrixPart(view, columns, now), size.height)
  return Array.from(
    { length: Math.min(size.height, Math.max(matrix.length, box.length)) },
    (_, row) =>
      `${fitted(matrix[row] ?? '', matrixWidth)}${' '.repeat(PANE_GAP)}${fitted(box[row] ?? '', boxWidth)}`
  )
}

/**
 * Puts the box under the matrix. When both don't fit, each keeps {@link PART_LEAST_ROWS} and the
 * box gives up the rest to the matrix; on a screen too short for both, only the part with the
 * selection shows.
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
): string[] {
  const nameColumns = Math.max(
    NAME_COLUMNS.least,
    Math.min(NAME_COLUMNS.most, size.width - MARK_COLUMNS - EFFORTS_WIDTH - COOLDOWN_COLUMNS.least)
  )
  const columns = { name: nameColumns, cooldown: cooldownRoom(size.width, nameColumns) }
  const matrix = matrixPart(view, columns, now)
  const aliases = aliasPart(view, size.width - FRAME_COLUMNS)
  const aliasCount = Object.keys(view.aliases).length
  const boxWanted = aliases.heading.length + aliases.lines.length + BOX_BORDER_ROWS
  let boxHeight = Math.min(boxWanted, Math.max(PART_LEAST_ROWS, size.height - PART_LEAST_ROWS))
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
    ...(boxHeight === 0
      ? []
      : aliasBox(aliases, aliasCount, { height: boxHeight, width: size.width }))
  ]
  return rows.map((row) => fitted(row, size.width))
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
 * @returns the rows; one line saying why when the exposure config is invalid
 */
export function modelsRows(
  view: ModelsView,
  size: { readonly height: number; readonly width: number },
  now: number = Date.now()
): string[] {
  if (view.unavailable !== undefined) {
    return [fitted(paint('error', `  Models unavailable: ${view.unavailable}`), size.width)]
  }
  const items = modelsItems(view)
  const selected = Math.min(Math.max(view.selected, 0), items.length - 1)
  const clamped = { ...view, selected }
  if (size.width >= SIDE_BY_SIDE_LEAST_WIDTH) return sideBySideRows(clamped, size, now)
  return stackedRows(clamped, size, now)
}
