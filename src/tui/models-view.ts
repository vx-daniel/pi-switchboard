/**
 * The console's Models view (#230): the exposed models, then every configured alias with its
 * targets, efforts, `fallbackOn`, what each family target resolves to (#231) and any diagnostic,
 * then the row that adds an alias.
 *
 * @remarks
 * The selection moves over every row: Enter on a model starts a new alias for it, on an alias
 * opens its menu, and on the last row starts a new alias. The view scrolls to keep the selection on
 * screen, since a login can expose more models than the screen has rows.
 *
 * @packageDocumentation
 */

import { truncateToWidth } from '@earendil-works/pi-tui'
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
import { activeCooldown, loginSubject } from '@proxy/pi/cooldowns'
import { highlight, paint } from '@proxy/tui/theme'
import { MS_PER_SECOND } from '@proxy/utils/time'

/** The label of the row after the aliases, which adds one. */
const NEW_ALIAS_ROW = '+ New alias…'
/** Widths of the view's first columns: the model or alias name, and the provider. */
const COLUMNS = { name: 34, provider: 16 } as const

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

/**
 * Lists the view's selectable items in order: the models, the aliases, then the new-alias row.
 *
 * @param view - the models and the aliases
 * @returns every item
 */
export function modelsItems(view: Pick<ModelsData, 'models' | 'aliases'>): readonly ModelsItem[] {
  return [
    ...view.models.map((model): ModelsItem => ({ kind: 'model', model })),
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

/**
 * Renders a model's cooldown, if it has one: the reason and the seconds left.
 *
 * @param model - the exposed model
 * @param now - the time now, in milliseconds since the epoch
 * @returns the cell, or `''`
 */
function cooldownCell(model: ExposedModel, now: number): string {
  const cooldown = activeCooldown(loginSubject(model), now)
  if (cooldown === undefined) return ''
  const left = Math.max(0, Math.ceil((cooldown.until - now) / MS_PER_SECOND))
  return paint('warning', `cooling ${cooldown.reason} ${String(left)}s`)
}

/**
 * Renders one exposed model: public ID, provider, the efforts it supports, any cooldown.
 *
 * @param model - the exposed model
 * @param now - the time now, for the cooldown
 * @returns the row's text, without its selection mark
 */
function modelRow(model: ExposedModel, now: number): string {
  return [
    truncateToWidth(model.publicId, COLUMNS.name, '…', true),
    truncateToWidth(model.provider, COLUMNS.provider, '…', true),
    supportedReasoningEfforts(model.model).join(' '),
    cooldownCell(model, now)
  ].join(' ')
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
 * Renders one alias: its name, its targets each with the effort it sets, and `fallbackOn`.
 *
 * @param name - the alias
 * @param target - what it names
 * @param families - what the family targets resolve to now
 * @returns the row's text, without its selection mark
 */
function aliasRow(
  name: string,
  target: AliasTarget,
  families: readonly FamilyResolution[]
): string {
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
  return `${truncateToWidth(name, COLUMNS.name, '…', true)} ${targets}${fallback}`
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

/**
 * Renders the Models view, scrolled so the selected row shows.
 *
 * @param view - the models, the aliases with their diagnostics, and the selection
 * @param height - rows available
 * @param now - the time now, for cooldowns
 * @returns the rows; one line saying why when the exposure config is invalid
 */
export function modelsRows(view: ModelsView, height: number, now: number = Date.now()): string[] {
  if (view.unavailable !== undefined) {
    return [paint('error', `  Models unavailable: ${view.unavailable}`)]
  }
  const items = modelsItems(view)
  const current = Math.min(Math.max(view.selected, 0), items.length - 1)
  const rows: string[] = []
  let selectedRow = 0
  const heading = (text: string): void => {
    rows.push(paint('dim', `  ${text}`))
  }
  heading(`${'model'.padEnd(COLUMNS.name)} ${'provider'.padEnd(COLUMNS.provider)} efforts`)
  for (const [position, listed] of items.entries()) {
    if (listed.kind === 'alias' && position === view.models.length) {
      heading(`${'alias'.padEnd(COLUMNS.name)} targets`)
    }
    const isCurrent = position === current
    if (isCurrent) selectedRow = rows.length
    if (listed.kind === 'model') rows.push(selectable(modelRow(listed.model, now), isCurrent))
    else if (listed.kind === 'new') rows.push(selectable(NEW_ALIAS_ROW, isCurrent))
    else {
      rows.push(selectable(aliasRow(listed.name, listed.target, view.families), isCurrent))
      for (const diagnostic of view.diagnostics.filter(({ alias }) => alias === listed.name)) {
        rows.push(paint('error', `      ${diagnostic.code}: ${diagnostic.message}`))
      }
    }
  }
  const start = Math.max(0, Math.min(selectedRow - height + 1, rows.length - height))
  return rows.slice(start, start + height)
}
