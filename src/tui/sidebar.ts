/**
 * The console's sidebar (#61): the proxy's status at a glance beside the current view. Panels
 * show each login's quota windows (QUOTA), the chat requests in flight (IN FLIGHT), the last
 * minute and the latest finished requests (RECENT), and the traffic since the proxy started
 * (SESSION). The proxy's own status (address, auth, uptime, models) is the status strip's.
 *
 * @remarks
 * Rendering only: the console gathers a {@link SidebarInput} snapshot and redraws. Nothing here
 * reads global state, so a render is a function of its input and the clock in it.
 *
 * @packageDocumentation
 */

import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import type { Cooldown } from '@proxy/pi/cooldowns'
import type { ProviderQuota, QuotaWindow } from '@proxy/pi/quota'
import {
  type ActiveRequest,
  FINISHED_KEPT,
  type FinishedRequest,
  REJECTED_KEPT,
  type RequestOutcome
} from '@proxy/server/active-requests'
import type { RouteTotals } from '@proxy/server/route-totals'
import {
  compactCount,
  compactDuration,
  FRAME_COLUMNS,
  latency,
  panel,
  quotaColor,
  spread,
  USED_LEVELS
} from '@proxy/tui/panel'
import { fitLabel, sum } from '@proxy/tui/stats-view'
import { paint, strong, tabAccent } from '@proxy/tui/theme'

/** The narrowest terminal that shows the sidebar; narrower, the view takes the whole width. */
const MIN_TERMINAL_WIDTH = 100
/** The sidebar's width: this share of the terminal, within {@link SIDEBAR_WIDTH}. */
const SIDEBAR_SHARE = 0.3
/** The narrowest and widest the sidebar gets. */
const SIDEBAR_WIDTH = { least: 34, most: 48 } as const
/** Cells in a quota window's bar. */
const BAR_CELLS = 8
/** Columns a window's time to reset takes (` ↻` and up to `59m59s`), so the bars line up. */
const RESET_COLUMNS = 8
/** Requests in flight listed before the rest are summed up as `+N more`. */
const MAX_ACTIVE_LISTED = 6
/** Finished requests listed in the RECENT panel, newest first. */
const MAX_RECENT_LISTED = 5
/** The window the RECENT panel's rate and averages cover. */
const RATE_WINDOW_MS = 60_000
/** Each outcome's mark and colour in the RECENT panel. */
const OUTCOME_MARKS: Readonly<Record<RequestOutcome, string>> = {
  ok: paint('success', '✓'),
  failed: paint('error', '✗'),
  left: paint('dim', '↩'),
  rejected: paint('warning', '⊘')
}
/** Percent in a whole. */
const PERCENT = 100
/** Decimal places a cost is shown with: a request can cost a fraction of a cent. */
const COST_DECIMALS = 4
/** The mark before a login, and before a request in flight. */
const MARK = '●'

/** One login, as the sidebar shows it: never the credential itself. */
export interface SidebarAccount {
  readonly provider: string
  /** `oauth` (an account) or `api_key`. */
  readonly type: 'oauth' | 'api_key'
  /** The label the operator gave the login (`labels`), or `undefined` for none. */
  readonly label: string | undefined
  /** How many of its models are available. */
  readonly models: number
  /** Its latest quota report, or `undefined` when it reported none. */
  readonly quota: ProviderQuota | undefined
  /** Whether it has less left than its `routing.reserve` (#69). */
  readonly belowReserve: boolean
}

/** Everything one render of the sidebar shows. */
export interface SidebarInput {
  /** The current time, for elapsed times and time left. */
  readonly now: number
  readonly accounts: readonly SidebarAccount[]
  /** Active cooldowns, soonest end first. */
  readonly cooldowns: readonly Cooldown[]
  /** Chat requests in flight, oldest first. */
  readonly active: readonly ActiveRequest[]
  /** The finished chat requests kept, newest first. */
  readonly finished: readonly FinishedRequest[]
  /** #70's route totals since the proxy started. */
  readonly totals: readonly RouteTotals[]
}

/**
 * Picks the sidebar's width for a terminal.
 *
 * @param terminalWidth - the terminal's columns
 * @returns the sidebar's columns, or `undefined` when the terminal is too narrow to show it
 */
export function sidebarWidth(terminalWidth: number): number | undefined {
  if (terminalWidth < MIN_TERMINAL_WIDTH) return undefined
  const share = Math.round(terminalWidth * SIDEBAR_SHARE)
  return Math.min(SIDEBAR_WIDTH.most, Math.max(SIDEBAR_WIDTH.least, share))
}

/**
 * Renders one quota window: its name, a bar, the share used and the time to its reset.
 *
 * @param window - the window
 * @param account - the provider, for its reserve
 * @param input - the snapshot, for the clock
 * @param width - the content's columns
 * @returns the line
 */
function windowLine(
  window: QuotaWindow,
  account: SidebarAccount,
  input: SidebarInput,
  width: number
): string {
  const used = Math.min(1, Math.max(0, window.used))
  const filled = Math.round(used * BAR_CELLS)
  const color = quotaColor(used, account.belowReserve)
  // The unused part in the border's color, so an empty window reads as a track, not a block.
  const bar = `${paint(color, '█'.repeat(filled))}${paint('border', '░'.repeat(BAR_CELLS - filled))}`
  const percent = paint(color, `${String(Math.round(used * PERCENT))}%`.padStart('100%'.length))
  const untilReset =
    window.resetsAt === undefined ? '' : ` ↻${compactDuration(window.resetsAt - input.now)}`
  const reset = paint('dim', untilReset.padEnd(RESET_COLUMNS))
  return spread(`  ${window.name}`, `${bar} ${percent}${reset}`, width)
}

/**
 * Renders a cooldown under its provider: the whole provider, or one of its models.
 *
 * @param cooldown - the cooldown
 * @param now - the current time
 * @param width - the content's columns
 * @returns the line
 */
function cooldownLine(cooldown: Cooldown, now: number, width: number): string {
  const subject =
    cooldown.scope === 'provider'
      ? 'cooling'
      : (cooldown.model?.slice(cooldown.provider.length + 1) ?? 'model')
  const left = compactDuration(cooldown.until - now)
  return paint('warning', spread(`  ⏸ ${subject}`, left, width))
}

/**
 * Renders a login's first row: a mark and the provider, then its label, or its login type and
 * model count when it has no label.
 *
 * @param account - the login
 * @param width - the content's columns
 * @returns the row
 */
function accountHeader(account: SidebarAccount, width: number): string {
  const login = account.type === 'oauth' ? 'account' : 'API key'
  const right =
    account.label === undefined
      ? paint('dim', `${login} · ${String(account.models)}`)
      : paint('accent', account.label)
  return spread(`${paint('success', MARK)} ${strong(account.provider)}`, right, width)
}

/**
 * Renders one login: its first row, then each quota window (or that it reports none), whether it
 * is below its reserve, and its cooldowns.
 *
 * @param account - the login
 * @param input - the snapshot
 * @param width - the content's columns
 * @returns the lines
 */
function accountLines(account: SidebarAccount, input: SidebarInput, width: number): string[] {
  const lines = [accountHeader(account, width)]
  const windows = account.quota?.windows ?? []
  if (windows.length === 0) lines.push(paint('dim', '  no quota reported'))
  for (const window of windows) lines.push(windowLine(window, account, input, width))
  if (account.belowReserve) lines.push(paint('error', '  below reserve'))
  for (const cooldown of input.cooldowns) {
    if (cooldown.provider === account.provider) lines.push(cooldownLine(cooldown, input.now, width))
  }
  return lines
}

/**
 * Says whether a login has nothing to warn about: no cooldown, not below its reserve, and every
 * quota window under the share shown as nearly spent.
 *
 * @param account - the login
 * @param input - the snapshot, for the cooldowns
 * @returns whether it is quiet
 */
function quiet(account: SidebarAccount, input: SidebarInput): boolean {
  return (
    !account.belowReserve &&
    !input.cooldowns.some((cooldown) => cooldown.provider === account.provider) &&
    (account.quota?.windows ?? []).every((window) => window.used < USED_LEVELS.warn)
  )
}

/**
 * Renders the QUOTA panel's lines: every login, or how to add one. Under stress a quiet login
 * takes its first row only, so the logins in trouble stand out and the panel stays short.
 *
 * @param input - the snapshot
 * @param width - the content's columns
 * @param collapseQuiet - whether to collapse quiet logins
 * @returns the lines
 */
function quotaLines(input: SidebarInput, width: number, collapseQuiet: boolean): string[] {
  if (input.accounts.length === 0) return [paint('dim', 'No logins · n to log in')]
  return input.accounts.flatMap((account) =>
    collapseQuiet && quiet(account, input)
      ? [accountHeader(account, width)]
      : accountLines(account, input, width)
  )
}

/**
 * Renders one request in flight: a mark, the model and its elapsed time, then its alias, phase
 * and attempt.
 *
 * @param request - the request
 * @param now - the current time
 * @param width - the content's columns
 * @returns two lines
 */
function activeLines(request: ActiveRequest, now: number, width: number): string[] {
  const elapsed = tabAccent(latency(now - request.startedAt))
  const modelWidth = Math.max(1, width - visibleWidth(elapsed) - visibleWidth(`${MARK}  `))
  const model = fitLabel(request.model, modelWidth)
  // A stream waits for the model's first event, then streams; a plain request only waits.
  let state = request.stream ? 'waiting · stream' : 'waiting'
  if (request.firstEventAt !== undefined) state = paint('success', 'streaming')
  const details = [request.alias ?? 'direct', state]
  if (request.attempt > 1) details.push(paint('warning', `try ${String(request.attempt)}`))
  return [
    spread(`${tabAccent(MARK)} ${model}`, elapsed, width),
    paint('dim', `  ${details.join(' · ')}`)
  ]
}

/**
 * Renders the IN FLIGHT panel's lines: the requests in flight, oldest first, or that there are
 * none.
 *
 * @param input - the snapshot
 * @param width - the content's columns
 * @returns the lines
 */
function inFlightLines(input: SidebarInput, width: number): string[] {
  if (input.active.length === 0) return [paint('dim', 'nothing in flight')]
  const listed = input.active
    .slice(0, MAX_ACTIVE_LISTED)
    .flatMap((request) => activeLines(request, input.now, width))
  const hidden = input.active.length - MAX_ACTIVE_LISTED
  return hidden > 0 ? [...listed, paint('dim', `+${String(hidden)} more`)] : listed
}

/**
 * Averages a time over the requests that have one.
 *
 * @param times - each request's time, or `undefined` for one without
 * @returns the average, or `undefined` when none has one
 */
function average(times: readonly (number | undefined)[]): number | undefined {
  const known = times.filter((time) => time !== undefined)
  if (known.length === 0) return undefined
  return known.reduce((total, time) => total + time, 0) / known.length
}

/**
 * Renders RECENT's first line: the last minute's requests, with the average time and a stream's
 * average time to its first event of those the proxy dispatched.
 *
 * @param lastMinute - the requests that finished in the last minute
 * @param width - the content's columns
 * @returns the line
 */
function lastMinuteLine(lastMinute: readonly FinishedRequest[], width: number): string {
  const rejected = lastMinute.filter((request) => request.outcome === 'rejected').length
  // Each kind keeps only its newest (FINISHED_KEPT, REJECTED_KEPT): a full one may be missing some
  // of the minute.
  const full = lastMinute.length - rejected >= FINISHED_KEPT || rejected >= REJECTED_KEPT
  const count = `${String(lastMinute.length)}${full ? '+' : ''}`
  // A rejected request is answered at once: its time would only pull the averages down.
  const dispatched = lastMinute.filter((request) => request.outcome !== 'rejected')
  const took = average(dispatched.map((request) => request.endedAt - request.startedAt))
  const first = average(
    dispatched.map((request) =>
      request.firstEventAt === undefined ? undefined : request.firstEventAt - request.startedAt
    )
  )
  const times: string[] = []
  if (took !== undefined) times.push(`${paint('dim', 'avg ')}${latency(took)}`)
  if (first !== undefined) times.push(`${paint('dim', '1st ')}${latency(first)}`)
  return spread(`${paint('dim', 'last min ')}${strong(count)}`, times.join('  '), width)
}

/**
 * Renders RECENT's second line, when the last minute had failures or rejections: how many of
 * each.
 *
 * @param lastMinute - the requests that finished in the last minute
 * @returns the line, or `undefined` when nothing went wrong
 */
function troubleLine(lastMinute: readonly FinishedRequest[]): string | undefined {
  const failed = lastMinute.filter((request) => request.outcome === 'failed').length
  const rejected = lastMinute.filter((request) => request.outcome === 'rejected').length
  const parts: string[] = []
  if (failed > 0) parts.push(paint('error', `${String(failed)} failed`))
  if (rejected > 0) {
    const full = rejected >= REJECTED_KEPT ? '+' : ''
    parts.push(paint('warning', `${String(rejected)}${full} rejected`))
  }
  return parts.length === 0 ? undefined : `  ${parts.join(' · ')}`
}

/**
 * Renders one finished request: its mark, its model and how long it took. A rejected one shows the
 * status it was answered with instead, and `-` for a model it did not get as far as naming.
 *
 * @param request - the request
 * @param width - the content's columns
 * @returns the line
 */
function finishedLine(request: FinishedRequest, width: number): string {
  const end =
    request.status === undefined
      ? latency(request.endedAt - request.startedAt)
      : String(request.status)
  // The row is the mark, the model and the time, a space between each.
  const modelWidth = width - visibleWidth(end) - visibleWidth('✓  ')
  const model = fitLabel(request.model === '' ? '-' : request.model, Math.max(1, modelWidth))
  return `${OUTCOME_MARKS[request.outcome]} ${model} ${paint('dim', end)}`
}

/**
 * Renders the RECENT panel's lines: a summary (the last minute's requests and average times, then
 * its failures and rejections if any), then the latest finished requests.
 *
 * @param input - the snapshot
 * @param lastMinute - the requests that finished in the last minute
 * @param width - the content's columns
 * @returns the summary and the list apart: a short screen cuts the list first
 */
function recentLines(
  input: SidebarInput,
  lastMinute: readonly FinishedRequest[],
  width: number
): { summary: string[]; list: string[] } {
  if (input.finished.length === 0) return { summary: [paint('dim', 'none yet')], list: [] }
  const summary = [lastMinuteLine(lastMinute, width)]
  const trouble = troubleLine(lastMinute)
  if (trouble !== undefined) summary.push(trouble)
  const list = input.finished
    .slice(0, MAX_RECENT_LISTED)
    .map((request) => finishedLine(request, width))
  return { summary, list }
}

/**
 * Renders the SESSION panel's lines: requests, failures and fallbacks, tokens, cache and cost
 * since the proxy started.
 *
 * @param input - the snapshot
 * @param width - the content's columns
 * @returns the lines
 */
function sessionLines(input: SidebarInput, width: number): string[] {
  const counts = sum(input.totals)
  const failed = String(counts.failures)
  const separator = paint('border', ' · ')
  return [
    spread('requests', strong(String(counts.requests)), width),
    spread(
      'failed · fallbacks',
      `${counts.failures > 0 ? paint('error', failed) : failed}${separator}${String(counts.fallbacks)}`,
      width
    ),
    spread(
      'tokens in / out',
      `${compactCount(counts.inputTokens)}${paint('border', ' / ')}${compactCount(counts.outputTokens)}`,
      width
    ),
    spread('cache', compactCount(counts.cacheReadTokens + counts.cacheWriteTokens), width),
    spread('cost', tabAccent(`$${counts.costUsd.toFixed(COST_DECIMALS)}`), width)
  ]
}

/** One panel before it is framed: its title, its lines, and how many of them a short screen keeps. */
interface PanelSpec {
  readonly id: 'quota' | 'inFlight' | 'recent' | 'session'
  readonly title: string
  /** A word after the title: how many logins, how many in flight. */
  readonly extra: string
  readonly lines: readonly string[]
  /** The lines kept when the screen is short: all of them, but RECENT's summary only. */
  readonly keep: number
}

/**
 * Describes a panel a short screen keeps whole or not at all.
 *
 * @param id - which panel
 * @param title - its title
 * @param extra - the word after its title
 * @param lines - its lines
 * @returns the panel
 */
function whole(
  id: PanelSpec['id'],
  title: string,
  extra: string,
  lines: readonly string[]
): PanelSpec {
  return { id, title, extra, lines, keep: lines.length }
}

/**
 * Says whether the proxy is under stress: something cooling down, a login below its reserve, or a
 * request that failed or was rejected in the last minute.
 *
 * @param input - the snapshot
 * @param lastMinute - the requests that finished in the last minute
 * @returns whether it is
 */
function underStress(input: SidebarInput, lastMinute: readonly FinishedRequest[]): boolean {
  return (
    input.cooldowns.length > 0 ||
    input.accounts.some((account) => account.belowReserve) ||
    lastMinute.some((request) => request.outcome === 'failed' || request.outcome === 'rejected')
  )
}

/**
 * Titles the RECENT panel with what went wrong in the last minute: the failures, or, with none,
 * the rejected requests, so whatever put the proxy under stress is named where a cut list can't
 * hide it.
 *
 * @param lastMinute - the requests that finished in the last minute
 * @returns the word after the title, or `''`
 */
function recentExtra(lastMinute: readonly FinishedRequest[]): string {
  const failed = lastMinute.filter((request) => request.outcome === 'failed').length
  if (failed > 0) return `· ${String(failed)} failed`
  const rejected = lastMinute.filter((request) => request.outcome === 'rejected').length
  return rejected > 0 ? `· ${String(rejected)} rejected` : ''
}

/**
 * Frames the panels and stacks them.
 *
 * @param specs - the panels, in order
 * @param width - the sidebar's columns
 * @param gaps - whether to leave a blank row between panels
 * @returns the rows
 */
function stack(specs: readonly PanelSpec[], width: number, gaps: boolean): string[] {
  return specs.flatMap((spec, index) => {
    const rows = panel(spec.title, spec.lines, width, spec.extra)
    return gaps && index > 0 ? ['', ...rows] : rows
  })
}

/**
 * Fits the panels to the height: with blank rows between them if they fit so, else without; then
 * without SESSION; then with RECENT's list cut down to its summary; then cut at the bottom.
 *
 * @param specs - the panels, in order
 * @param size - the space available
 * @param size.height - rows
 * @param size.width - columns
 * @returns the rows, at most `size.height`
 */
function fitPanels(
  specs: readonly PanelSpec[],
  size: { readonly height: number; readonly width: number }
): string[] {
  const spaced = stack(specs, size.width, true)
  if (spaced.length <= size.height) return spaced
  const tight = stack(specs, size.width, false)
  if (tight.length <= size.height) return tight
  const kept = specs.filter((spec) => spec.id !== 'session')
  const over = stack(kept, size.width, false).length - size.height
  const trimmed = kept.map((spec) =>
    spec.id === 'recent'
      ? { ...spec, lines: spec.lines.slice(0, Math.max(spec.keep, spec.lines.length - over)) }
      : spec
  )
  return stack(trimmed, size.width, false).slice(0, Math.max(0, size.height))
}

/**
 * Renders the sidebar: QUOTA, IN FLIGHT, RECENT and SESSION panels. Under stress
 * ({@link underStress}) IN FLIGHT and RECENT come before QUOTA, whose quiet logins collapse to one
 * row, and RECENT's title carries the last minute's failures.
 *
 * @param input - the snapshot
 * @param size - the space available
 * @param size.height - rows; panels that do not fit give way as {@link fitPanels} says
 * @param size.width - columns, borders included
 * @returns the rows, each exactly `size.width` columns wide
 */
export function sidebarRows(
  input: SidebarInput,
  size: { readonly height: number; readonly width: number }
): string[] {
  const inner = Math.max(1, size.width - FRAME_COLUMNS)
  const lastMinute = input.finished.filter(
    (request) => input.now - request.endedAt < RATE_WINDOW_MS
  )
  const stressed = underStress(input, lastMinute)
  const recent = recentLines(input, lastMinute, inner)
  const logins = `${String(input.accounts.length)} ${input.accounts.length === 1 ? 'login' : 'logins'}`
  const quota = whole('quota', 'QUOTA', logins, quotaLines(input, inner, stressed))
  const inFlight = whole(
    'inFlight',
    'IN FLIGHT',
    String(input.active.length),
    inFlightLines(input, inner)
  )
  const recentPanel: PanelSpec = {
    id: 'recent',
    title: 'RECENT',
    extra: recentExtra(lastMinute),
    lines: [...recent.summary, ...recent.list],
    keep: recent.summary.length
  }
  const session = whole('session', 'SESSION', '', sessionLines(input, inner))
  const order = stressed
    ? [inFlight, recentPanel, quota, session]
    : [quota, inFlight, recentPanel, session]
  return fitPanels(order, size).map((row) => truncateToWidth(row, size.width, '', true))
}

/**
 * Places the sidebar to the right of the view, one space between them.
 *
 * @param main - the view's rows
 * @param side - the sidebar's rows
 * @param mainWidth - the view's columns: each of its rows is cut or padded to it
 * @returns the combined rows, as many as the longer of the two
 */
export function besideSidebar(
  main: readonly string[],
  side: readonly string[],
  mainWidth: number
): string[] {
  const height = Math.max(main.length, side.length)
  return Array.from(
    { length: height },
    (_, row) => `${truncateToWidth(main[row] ?? '', mainWidth, '', true)} ${side[row] ?? ''}`
  )
}
