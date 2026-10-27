/**
 * What the console's Models view (`models-view.ts`, #230) says about one item: a model's cooldown
 * cell, an alias target's cell, and the detail pane for the selected item (#265), beside the
 * matrix under the boxes: a model's full public ID, provider, efforts and the levels it skips, an
 * alias's targets and effort, and what Enter does.
 *
 * @packageDocumentation
 */

import { visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'
import {
  type AliasModel,
  type AliasTarget,
  aliasModels,
  type FamilyTarget,
  isFamilyTarget
} from '@proxy/config/schema'
import type { FamilyResolution } from '@proxy/openai/model-aliases'
import type { ExposedModel } from '@proxy/openai/model-exposure'
import { supportedReasoningEfforts } from '@proxy/openai/reasoning-effort'
import { REASONING_EFFORTS, type ReasoningEffort } from '@proxy/openai/schemas'
import { activeCooldown, loginSubject } from '@proxy/pi/cooldowns'
import { compactDuration, FRAME_COLUMNS, panel } from '@proxy/tui/panel'
import { paint, tabAccent } from '@proxy/tui/theme'
import { MS_PER_SECOND } from '@proxy/utils/time'

/** What a selected item is. */
export type ModelsItem =
  | { readonly kind: 'model'; readonly model: ExposedModel }
  | { readonly kind: 'alias'; readonly name: string; readonly target: AliasTarget }
  | { readonly kind: 'new' }
  /** A built-in `-latest` alias, which only a configured alias of its name changes. */
  | { readonly kind: 'latest'; readonly name: string; readonly target: FamilyTarget }

/**
 * Renders a model's cooldown, if it has one: the time left (`42s`, `3m00s`), and the reason when it fits too,
 * so a narrow cell keeps the countdown.
 *
 * @param model - the exposed model
 * @param now - the time now, in milliseconds since the epoch
 * @param room - the cell's columns
 * @returns the cell, or `''`
 */
export function cooldownCell(model: ExposedModel, now: number, room: number): string {
  const cooldown = activeCooldown(loginSubject(model), now)
  if (cooldown === undefined) return ''
  // Rounded up to the second: a cooldown with a moment left still reads `1s`, not `0s`.
  const left = Math.max(0, Math.ceil((cooldown.until - now) / MS_PER_SECOND)) * MS_PER_SECOND
  const countdown = `cooling ${compactDuration(left)}`
  const withReason = `${countdown} ${cooldown.reason}`
  return paint('warning', visibleWidth(withReason) <= room ? withReason : countdown)
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
export function targetCell(target: AliasModel, resolution: FamilyResolution | undefined): string {
  const shown = isFamilyTarget(target) ? familyCell(target.family, resolution) : target.model
  return target.reasoningEffort === undefined ? shown : `${shown} @${target.reasoningEffort}`
}

/**
 * Lays a field of the detail pane out: its name, dim, then its value, wrapped under the value's
 * column so a long public ID or chain is never cut.
 *
 * @param name - the field's name
 * @param value - its value
 * @param width - the pane's content columns
 * @returns the field's lines
 */
function detailField(name: string, value: string, width: number): string[] {
  const indent = name.length + 1
  const [first = '', ...rest] = wrapTextWithAnsi(value, Math.max(1, width - indent))
  return [`${paint('dim', name)} ${first}`, ...rest.map((line) => `${' '.repeat(indent)}${line}`)]
}

/**
 * Renders what Enter does on the selected item, for the last line of the detail pane.
 *
 * @param text - what it does
 * @returns the line
 */
function enterHint(text: string): string {
  return `${tabAccent('↵')} ${paint('dim', text)}`
}

/**
 * Describes the efforts a model runs at: the range, how many, and the levels inside the range it
 * skips.
 *
 * @param model - the exposed model
 * @returns `range`, as `low → high (4 levels)`, a single level, or `none (no reasoning)`; and
 *   `skips`, the levels inside the range the model does not run at (none when it skips none)
 */
function effortFacts(model: ExposedModel): { range: string; skips: readonly ReasoningEffort[] } {
  const supported = supportedReasoningEfforts(model.model)
  const [lowest = 'none'] = supported
  const highest = supported.at(-1) ?? lowest
  if (supported.length <= 1) {
    return { range: lowest === 'none' ? 'none (no reasoning)' : lowest, skips: [] }
  }
  const inside = REASONING_EFFORTS.slice(
    REASONING_EFFORTS.indexOf(lowest),
    REASONING_EFFORTS.indexOf(highest) + 1
  )
  return {
    range: `${lowest} → ${highest} (${String(supported.length)} levels)`,
    skips: inside.filter((effort) => !supported.includes(effort))
  }
}

/**
 * Lists the detail pane's lines for a model: its full public ID, provider and login, its efforts
 * and the levels it skips, its cooldown with the reason, and what Enter does.
 *
 * @param model - the exposed model
 * @param width - the pane's content columns
 * @param now - the time now, for the cooldown
 * @returns the lines
 */
function modelDetailLines(model: ExposedModel, width: number, now: number): string[] {
  const { range, skips } = effortFacts(model)
  const login = model.login === model.provider ? [] : detailField('login', model.login, width)
  const cooldown = cooldownCell(model, now, Number.POSITIVE_INFINITY)
  return [
    ...detailField('id', model.publicId, width),
    ...detailField('provider', model.provider, width),
    ...login,
    ...detailField('efforts', range, width),
    ...(skips.length === 0 ? [] : detailField('skips', skips.join(', '), width)),
    ...(cooldown === '' ? [] : wrapTextWithAnsi(cooldown, width)),
    '',
    enterHint('makes an alias for this model')
  ]
}

/**
 * Lists the detail pane's lines for an alias, configured or built in: its targets with the effort
 * each sets, the effort it runs at, and what Enter does.
 *
 * @param item - the alias
 * @param families - what the family targets resolve to now
 * @param width - the pane's content columns
 * @returns the lines
 */
function aliasDetailLines(
  item: Extract<ModelsItem, { kind: 'alias' | 'latest' }>,
  families: readonly FamilyResolution[],
  width: number
): string[] {
  const targets = aliasModels(item.target)
  const cells = targets.map((target, position) =>
    targetCell(
      target,
      families.find((family) => family.alias === item.name && family.position === position)
    )
  )
  const efforts = [...new Set(targets.map((target) => target.reasoningEffort ?? 'the request’s'))]
  const hint =
    item.kind === 'latest'
      ? 'pins it: an alias of its name replaces the built-in one'
      : 'rename, change its targets, fallbackOn, or delete'
  return [
    ...detailField(targets.length === 1 ? 'target' : 'targets', cells.join(' › '), width),
    ...detailField('effort', efforts.join(', '), width),
    '',
    enterHint(hint)
  ]
}

/**
 * Frames the detail pane for the selected item: a model, an alias, or the new-alias row.
 *
 * @param item - the selected item
 * @param families - what the family targets resolve to now
 * @param width - the pane's columns, its frame included
 * @param now - the time now, for a model's cooldown
 * @returns the pane's rows
 */
export function detailPane(
  item: ModelsItem,
  families: readonly FamilyResolution[],
  width: number,
  now: number
): string[] {
  const inner = Math.max(1, width - FRAME_COLUMNS)
  if (item.kind === 'model') {
    return panel('MODEL', modelDetailLines(item.model, inner, now), width)
  }
  if (item.kind === 'new') {
    const hint = enterHint('names a new alias, then picks its models and efforts')
    return panel('NEW ALIAS', wrapTextWithAnsi(hint, inner), width)
  }
  const title = item.kind === 'latest' ? 'BUILT-IN ALIAS' : 'ALIAS'
  return panel(title, aliasDetailLines(item, families, inner), width, item.name)
}
