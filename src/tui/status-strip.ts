/**
 * The console's status strip (#61): the screen's first row, what the proxy is doing at a glance.
 * The name and version, a `● SERVING` badge, where it listens and how; then the details that fit,
 * and on the right the last half hour of chat requests as a sparkline with the current rate, and
 * what today's requests cost while the stats file is read.
 *
 * @remarks
 * Rendering only: the console gathers a {@link StatusStripInput} snapshot and redraws. When the
 * row is too narrow, the left details drop from the end down to the address and the auth, then the
 * right group drops from its start, then the rest is cut. An error (the exposure config, pi's
 * `models.json`) is never dropped: it comes right after the auth. Proxy auth off is a badge that
 * says so in its text, in the warning color on loopback and the error color beyond it (#287);
 * beyond loopback the screen also gives it a row of its own ({@link authOffRow}).
 *
 * @packageDocumentation
 */

import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import { FINISHED_KEPT, type FinishedRequest } from '@proxy/server/active-requests'
import { compactDuration, usd } from '@proxy/tui/panel'
import { alertBadge, badge, paint, strong, tabAccent } from '@proxy/tui/theme'
import { MS_PER_MINUTE } from '@proxy/utils/time'

/** Minutes the sparkline covers, one cell each. */
export const SPARKLINE_MINUTES = 30
/** Minutes the rate averages over. */
const RATE_WINDOW_MINUTES = 5
/** The sparkline's tallest cell. */
const FULL_CELL = '█'
/** The sparkline's cells, lowest first: a minute with no request is the lowest, in the border color. */
const SPARK_CELLS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', FULL_CELL] as const
/** Columns around the right group: one before it, one after it at the row's edge. */
const RIGHT_GROUP_MARGIN = 2
/** The strip's leading mark. */
const MARK = '◆'
/** Between the strip's parts. */
const SEPARATOR = paint('border', ' · ')
/** Decimal places of the rate. */
const RATE_DECIMALS = 1
/** The left details kept whatever the width with a token: the address and the auth. */
const LEFT_DETAILS_KEPT = 2

/** Everything one render of the strip shows. */
export interface StatusStripInput {
  readonly version: string
  /** `host:port`, without the scheme. */
  readonly address: string
  /** Proxy auth: `token` or `off`. */
  readonly proxyAuth: 'token' | 'off'
  /** Whether the proxy listens beyond this machine: auth off is an error there, not a warning. */
  readonly beyondLoopback: boolean
  /** Exposed model count or the exposure config's error, or `undefined` before the first read. */
  readonly exposed: number | string | undefined
  /** Available model count, or `undefined` before the first read. */
  readonly available: number | undefined
  /** How long the proxy has run, in milliseconds. */
  readonly uptimeMs: number
  /** Open client connections, or `undefined` before the first count. */
  readonly connections: number | undefined
  /** Active cooldowns. */
  readonly cooldowns: number
  /** Whether pi's `models.json` failed to load. */
  readonly modelsJsonError: boolean
  /** Chat requests finished per minute over the last {@link SPARKLINE_MINUTES}, oldest first. */
  readonly perMinute: readonly number[]
  /** Whether the kept finished requests may miss some of the oldest minutes. */
  readonly saturated: boolean
  /** What today's requests cost in US dollars, or `undefined` when the stats aren't read. */
  readonly todayCostUsd: number | undefined
}

/**
 * Counts the chat requests that finished in each of the last `minutes` minutes.
 *
 * @remarks
 * The console keeps the newest {@link FINISHED_KEPT} finished requests, so under load the oldest
 * minutes may be undercounted; `saturated` says when that is possible, and the strip marks the
 * rate with `+` then.
 *
 * @param finished - the finished requests kept, in any order
 * @param now - the current time, in milliseconds since the epoch
 * @param minutes - how many minutes to count, ending with the current one
 * @returns the counts, oldest first, and whether the kept requests may miss some
 */
export function requestsPerMinute(
  finished: readonly FinishedRequest[],
  now: number,
  minutes = SPARKLINE_MINUTES
): { readonly perMinute: number[]; readonly saturated: boolean } {
  const currentMinute = Math.floor(now / MS_PER_MINUTE)
  const firstMinute = currentMinute - minutes + 1
  const perMinute = Array.from({ length: minutes }, () => 0)
  for (const request of finished) {
    const index = Math.floor(request.endedAt / MS_PER_MINUTE) - firstMinute
    if (index >= 0 && index < minutes) perMinute[index] = (perMinute[index] ?? 0) + 1
  }
  return { perMinute, saturated: finished.length >= FINISHED_KEPT }
}

/**
 * Draws the sparkline: one cell per minute, as tall as the minute's share of the busiest minute.
 *
 * @param perMinute - the counts, oldest first
 * @returns the cells
 */
function sparkline(perMinute: readonly number[]): string {
  const peak = Math.max(1, ...perMinute)
  const top = SPARK_CELLS.length - 1
  return perMinute
    .map((minuteCount) => {
      if (minuteCount === 0) return paint('border', SPARK_CELLS[0])
      const level = Math.min(top, Math.max(1, Math.round((minuteCount / peak) * top)))
      return paint('accent', SPARK_CELLS[level] ?? FULL_CELL)
    })
    .join('')
}

/**
 * Formats the rate: the average of the last {@link RATE_WINDOW_MINUTES} minutes, with `+` when
 * the kept requests may miss some.
 *
 * @param input - the snapshot
 * @returns the rate, such as `1.8 req/min`
 */
function rateText(input: StatusStripInput): string {
  const recent = input.perMinute.slice(-RATE_WINDOW_MINUTES)
  const total = recent.reduce((requests, minuteCount) => requests + minuteCount, 0)
  const rate = (total / RATE_WINDOW_MINUTES).toFixed(RATE_DECIMALS)
  return `${strong(rate)}${input.saturated ? '+' : ''}${paint('dim', ' req/min')}`
}

/**
 * Lists the right group, in the order it drops from: the sparkline, the rate, then today's cost.
 *
 * @param input - the snapshot
 * @returns the parts, left to right
 */
function rightParts(input: StatusStripInput): string[] {
  const parts = [`${paint('dim', 'last 30 min ')}${sparkline(input.perMinute)}`, rateText(input)]
  if (input.todayCostUsd !== undefined) {
    const cost = strong(tabAccent(usd(input.todayCostUsd)))
    parts.push(`${cost}${paint('dim', ' today')}`)
  }
  return parts
}

/**
 * Lists the left details: the address and, with a token, the auth first (never dropped), then the
 * errors (never dropped either), then what the row's width allows. Auth off is the badge instead.
 *
 * @param input - the snapshot
 * @returns the details, in order
 */
function leftDetails(input: StatusStripInput): string[] {
  const details = [input.address]
  if (input.proxyAuth === 'token') details.push(`${paint('dim', 'auth ')}token`)
  if (typeof input.exposed === 'string') details.push(paint('error', 'exposure config error'))
  if (input.modelsJsonError) details.push(paint('error', 'models.json error'))
  if (typeof input.exposed === 'number' && input.available !== undefined) {
    const counts = `${String(input.exposed)}/${String(input.available)}`
    details.push(`${counts}${paint('dim', ' models exposed')}`)
  }
  details.push(`${paint('dim', 'up ')}${compactDuration(input.uptimeMs)}`)
  if (input.connections !== undefined) {
    details.push(`${String(input.connections)}${paint('dim', ' conn')}`)
  }
  details.push(`${String(input.cooldowns)}${paint('dim', ' cooldowns')}`)
  return details
}

/**
 * Counts the left details that are never dropped: the address, the auth with a token, and any
 * error.
 *
 * @param input - the snapshot
 * @returns how many
 */
function leftDetailsKept(input: StatusStripInput): number {
  let kept = input.proxyAuth === 'token' ? LEFT_DETAILS_KEPT : LEFT_DETAILS_KEPT - 1
  if (typeof input.exposed === 'string') kept += 1
  if (input.modelsJsonError) kept += 1
  return kept
}

/**
 * Draws the badge after the name: `● SERVING` with a token; with auth off, a badge that says so
 * and names the key that sets a token, in the warning color on loopback and the error color beyond
 * it (#287). It takes `SERVING`'s place, so it is never dropped, even on the narrowest terminal.
 *
 * @param input - the snapshot
 * @returns the badge
 */
function statusBadge(input: StatusStripInput): string {
  if (input.proxyAuth === 'token') return badge(' ● SERVING ')
  return alertBadge(input.beyondLoopback ? 'error' : 'warning', ' ⚠ AUTH OFF (p) ')
}

/**
 * Renders the row the screen shows under the strip while proxy auth is off and the proxy listens
 * beyond this machine (#287): a solid error-colored bar across the screen, the address and the key
 * first, so a narrow terminal cuts the explanation rather than them.
 *
 * @param address - `host:port`, without the scheme
 * @param width - the terminal's columns
 * @returns the row, `width` columns
 */
export function authOffRow(address: string, width: number): string {
  const text = ` ⚠ Proxy auth is off on ${address} · p sets a token · anyone who can reach it can use your logins`
  return alertBadge('error', truncateToWidth(text, width, '…', true))
}

/**
 * Renders the status strip, exactly `width` columns wide.
 *
 * @param input - the snapshot
 * @param width - the terminal's columns
 * @returns the row, untruncated styles aside
 */
export function statusStrip(input: StatusStripInput, width: number): string {
  const name = `${tabAccent(` ${MARK} `)}${strong('pi-switchboard')}`
  const serving = `  ${statusBadge(input)}  `
  let fixed = `${name} ${paint('dim', input.version)}${serving}`
  const left = leftDetails(input)
  const right = rightParts(input)
  const kept = leftDetailsKept(input)
  // One space before the right group, and one after it at the row's edge.
  const overflow = (): number =>
    visibleWidth(fixed) +
    visibleWidth(left.join(SEPARATOR)) +
    (right.length > 0 ? visibleWidth(right.join(SEPARATOR)) + RIGHT_GROUP_MARGIN : 0) -
    width
  while (overflow() > 0 && left.length > kept) left.pop()
  while (overflow() > 0 && right.length > 0) right.shift()
  // Still too wide for the address, the auth and the errors: the version goes before they are cut.
  if (overflow() > 0) fixed = `${name}${serving}`
  const leftText = `${fixed}${left.join(SEPARATOR)}`
  if (right.length === 0) return truncateToWidth(leftText, width, '…', true)
  const rightText = `${right.join(SEPARATOR)} `
  const gap = Math.max(1, width - visibleWidth(leftText) - visibleWidth(rightText))
  return `${leftText}${' '.repeat(gap)}${rightText}`
}
