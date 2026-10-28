/**
 * What the console's views, sidebar and status strip draw with: framed panels, lines with a label
 * and a value, gauges, and compact numbers and times.
 *
 * @packageDocumentation
 */

import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import { cacheHitRate, type InputTokens } from '@proxy/stats/cache'
import { type ConsoleColor, paint, strong } from '@proxy/tui/theme'
import { MS_PER_SECOND } from '@proxy/utils/time'

/** Columns a panel's frame takes: `│ ` before the content and ` │` after. */
export const FRAME_COLUMNS = 4
/** Columns a panel's two corners take, on its top and bottom borders. */
const CORNER_COLUMNS = 2
/** Seconds in a minute, minutes in an hour. */
const SIXTY = 60
/** Hours in a day. */
const HOURS_PER_DAY = 24
/** Digits the minutes or hours after the first unit are padded to: `4m05s`, `1h02m`. */
const PAD_DIGITS = 2
/** A thousand, for compact counts. */
const THOUSAND = 1000
/** A million, for compact counts. */
const MILLION = 1_000_000
/** Decimal places a cost is shown with unless asked for more: dollars and cents. */
const CENTS_DECIMALS = 2
/** A share's scale as a percentage. */
const PERCENT = 100
/** Share used from which a quota window shows as nearly spent, then as spent. */
export const USED_LEVELS = { warn: 0.7, high: 0.9 } as const
/** A gauge cell's eighths, from one eighth filled to full. */
const EIGHTHS_LEFT = ['▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'] as const
/** Eighths in a gauge cell. */
const EIGHTHS = EIGHTHS_LEFT.length

/**
 * Frames a panel: a titled top border, each line between side borders, a bottom border.
 *
 * @param title - the title, shown in the top border
 * @param lines - the content lines; each is cut or padded to the content's width
 * @param width - the panel's columns, borders included
 * @param extra - a word after the title in the top border, dimmer (`4 logins`); `''` for none
 * @returns the panel's rows
 */
export function panel(
  title: string,
  lines: readonly string[],
  width: number,
  extra = ''
): string[] {
  const inner = Math.max(1, width - FRAME_COLUMNS)
  const fullLabel = `${strong(paint('accent', ` ${title}`))}${extra === '' ? '' : paint('dim', ` ${extra}`)} `
  // The corners and the border's first `─` around the title: a longer title is cut with `…`, so
  // the top border is never wider than the panel (a long login and its label, #260 review).
  const labelRoom = Math.max(0, width - CORNER_COLUMNS - 1)
  const label =
    visibleWidth(fullLabel) > labelRoom ? truncateToWidth(fullLabel, labelRoom, '…') : fullLabel
  const rest = Math.max(0, width - CORNER_COLUMNS - 1 - visibleWidth(label))
  const top = `${paint('border', '╭─')}${label}${paint('border', `${'─'.repeat(rest)}╮`)}`
  const body = lines.map(
    (line) =>
      `${paint('border', '│ ')}${truncateToWidth(line, inner, '…', true)}${paint('border', ' │')}`
  )
  const bottom = paint('border', `╰${'─'.repeat(Math.max(0, width - CORNER_COLUMNS))}╯`)
  return [top, ...body, bottom]
}

/**
 * Lays out a label on the left and a value on the right of one content line.
 *
 * @param label - the left part; cut with `…` when the line is too narrow
 * @param value - the right part, kept whole
 * @param width - the content's columns
 * @returns the line
 */
export function spread(label: string, value: string, width: number): string {
  const room = Math.max(1, width - visibleWidth(value) - 1)
  const left = truncateToWidth(label, room, '…')
  const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(value))
  return `${left}${' '.repeat(gap)}${value}`
}

/**
 * Formats a length of time compactly: `42s`, `4m05s`, `1h02m`, `3d4h`.
 *
 * @param ms - the length, in milliseconds; a negative one counts as zero
 * @returns the text
 */
export function compactDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / MS_PER_SECOND))
  if (seconds < SIXTY) return `${String(seconds)}s`
  const minutes = Math.floor(seconds / SIXTY)
  const padded = (value: number): string => String(value).padStart(PAD_DIGITS, '0')
  if (minutes < SIXTY) return `${String(minutes)}m${padded(seconds % SIXTY)}s`
  const hours = Math.floor(minutes / SIXTY)
  if (hours < HOURS_PER_DAY) return `${String(hours)}h${padded(minutes % SIXTY)}m`
  return `${String(Math.floor(hours / HOURS_PER_DAY))}d${String(hours % HOURS_PER_DAY)}h`
}

/**
 * Formats a request's time: `850ms`, `2.3s`, then as {@link compactDuration} from a minute.
 *
 * @param ms - the time, in milliseconds
 * @returns the text
 */
export function latency(ms: number): string {
  if (ms < MS_PER_SECOND) return `${String(Math.max(0, Math.round(ms)))}ms`
  if (ms < SIXTY * MS_PER_SECOND) return `${(ms / MS_PER_SECOND).toFixed(1)}s`
  return compactDuration(ms)
}

/**
 * Picks the first row shown of a list that scrolls, so a chosen row stays on screen.
 *
 * @param chosen - the row to keep on screen, such as the selected one
 * @param rows - the list's rows
 * @param visible - how many of them fit
 * @returns the first row shown
 */
export function firstShown(chosen: number, rows: number, visible: number): number {
  if (rows <= visible) return 0
  return Math.min(rows - visible, Math.max(0, chosen - visible + 1))
}

/**
 * Formats a cost in US dollars: `$1.23`, or with more places, `$0.0042`.
 *
 * @param amount - the cost, in US dollars
 * @param decimals - the decimal places; more than cents where a request's cost matters
 * @returns the text
 */
export function usd(amount: number, decimals = CENTS_DECIMALS): string {
  return `$${amount.toFixed(decimals)}`
}

/**
 * Formats a count compactly: `950`, `12.3K`, `1.2M`.
 *
 * @param value - the count
 * @returns the text
 */
export function compactCount(value: number): string {
  if (value < THOUSAND) return String(value)
  const [scaled, unit] = value < MILLION ? [value / THOUSAND, 'K'] : [value / MILLION, 'M']
  return `${scaled.toFixed(1).replace(/\.0$/, '')}${unit}`
}

/**
 * Formats the share of the prompt read from the cache: `97%`, or `-` with no prompt tokens.
 *
 * @param tokens - the input token counts
 * @returns the text
 */
export function hitRate(tokens: InputTokens): string {
  const rate = cacheHitRate(tokens)
  return rate === undefined ? '-' : `${String(Math.round(rate * PERCENT))}%`
}

/**
 * Picks a quota window's color by how much of it is used: green, yellow from
 * {@link USED_LEVELS}`.warn`, red from `.high` or when the login is below its reserve.
 *
 * @param used - the share used, from 0 to 1
 * @param belowReserve - whether the login is below its reserve, which is shown as spent
 * @returns the role to color it with
 */
export function quotaColor(used: number, belowReserve: boolean): ConsoleColor {
  if (belowReserve || used >= USED_LEVELS.high) return 'error'
  return used >= USED_LEVELS.warn ? 'warning' : 'success'
}

/**
 * Draws a share as a gauge in eighths of a cell, the rest a track in the border's color. A share
 * above zero shows at least one eighth, so a little used never reads as none.
 *
 * @param share - the share, from 0 to 1 (outside that, clamped)
 * @param cells - the gauge's columns
 * @param color - the filled part's color
 * @returns the gauge, exactly `cells` columns
 */
export function gauge(share: number, cells: number, color: ConsoleColor): string {
  const clamped = Math.min(1, Math.max(0, share))
  const units = clamped > 0 ? Math.max(1, Math.round(clamped * cells * EIGHTHS)) : 0
  const full = Math.floor(units / EIGHTHS)
  const part = units % EIGHTHS
  const partial = part === 0 ? '' : (EIGHTHS_LEFT[part - 1] ?? '')
  const filled = `${'█'.repeat(full)}${partial}`
  const track = '░'.repeat(Math.max(0, cells - full - (part === 0 ? 0 : 1)))
  return `${paint(color, filled)}${paint('border', track)}`
}
