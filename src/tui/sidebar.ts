/**
 * The console's sidebar (#61): the proxy's status at a glance beside the current view. Panels
 * show the proxy (address, auth, uptime, open connections, models), each login with its quota
 * windows and cooldowns, the chat requests in flight, and the traffic since the proxy started.
 *
 * @remarks
 * Rendering only: the console gathers a {@link SidebarInput} snapshot and redraws. Nothing here
 * reads global state, so a render is a function of its input and the clock in it.
 *
 * @packageDocumentation
 */

import { styleText } from 'node:util'

import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import { MS_PER_SECOND } from '@proxy/config/schema'
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
import { fitLabel, sum } from '@proxy/tui/stats-view'

/** The narrowest terminal that shows the sidebar; narrower, the view takes the whole width. */
const MIN_TERMINAL_WIDTH = 100
/** The sidebar's width: this share of the terminal, within {@link SIDEBAR_WIDTH}. */
const SIDEBAR_SHARE = 0.3
/** The narrowest and widest the sidebar gets. */
const SIDEBAR_WIDTH = { least: 34, most: 48 } as const
/** Columns a panel's frame takes: `│ ` before the content and ` │` after. */
const FRAME_COLUMNS = 4
/** Cells in a quota window's bar. */
const BAR_CELLS = 8
/** Columns a window's time to reset takes (` ↻` and up to `59m59s`), so the bars line up. */
const RESET_COLUMNS = 8
/** Share used from which a window shows as nearly spent, then as spent. */
const USED_LEVELS = { warn: 0.7, high: 0.9 } as const
/** Requests in flight listed before the rest are summed up as `+N more`. */
const MAX_ACTIVE_LISTED = 6
/** Finished requests listed in the RECENT panel, newest first. */
const MAX_RECENT_LISTED = 5
/** The window the RECENT panel's rate and averages cover. */
const RATE_WINDOW_MS = 60_000
/** Each outcome's mark and colour in the RECENT panel. */
const OUTCOME_MARKS: Readonly<Record<RequestOutcome, string>> = {
  ok: styleText('green', '✓'),
  failed: styleText('red', '✗'),
  left: styleText('dim', '↩'),
  rejected: styleText('yellow', '⊘')
}
/** Percent in a whole. */
const PERCENT = 100
/** Seconds in a minute, minutes in an hour. */
const SIXTY = 60
/** Hours in a day. */
const HOURS_PER_DAY = 24
/** A thousand, for compact token counts. */
const THOUSAND = 1000
/** A million, for compact token counts. */
const MILLION = 1_000_000
/** Decimal places a cost is shown with: a request can cost a fraction of a cent. */
const COST_DECIMALS = 4
/** Columns a panel's two corners take, on its top and bottom borders. */
const CORNER_COLUMNS = 2
/** Digits the minutes or hours after the first unit are padded to: `4m05s`, `1h02m`. */
const PAD_DIGITS = 2

/** The proxy's own status, from the server config and the status the console reads. */
export interface SidebarProxy {
  /** `host:port`, without the scheme. */
  readonly address: string
  /** Proxy auth: `token` or `off`. */
  readonly proxyAuth: string
  /** When the console started the proxy, in milliseconds since the epoch. */
  readonly startedAt: number
  /** Open client connections, or `undefined` before the first count. */
  readonly connections: number | undefined
  /** Exposed model count or the exposure config's error, or `undefined` before the first read. */
  readonly exposed: number | string | undefined
  /** Available model count, or `undefined` before the first read. */
  readonly available: number | undefined
  /** Whether pi's `models.json` failed to load. */
  readonly modelsJsonError: boolean
}

/** One login, as the sidebar shows it: never the credential itself. */
export interface SidebarAccount {
  readonly provider: string
  /** `oauth` (an account) or `api_key`. */
  readonly type: 'oauth' | 'api_key'
  /** How many of its models are available. */
  readonly models: number
  /** Its latest quota report, or `undefined` when it reported none. */
  readonly quota: ProviderQuota | undefined
  /** Whether it has less left than its `routing.reserve` (#69). */
  readonly belowReserve: boolean
}

/** Everything one render of the sidebar shows. */
export interface SidebarInput {
  /** The current time, for uptimes, elapsed times and time left. */
  readonly now: number
  readonly proxy: SidebarProxy
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
 * Formats a token count compactly: `950`, `12.3K`, `1.2M`.
 *
 * @param value - the count
 * @returns the text
 */
function compactCount(value: number): string {
  if (value < THOUSAND) return String(value)
  const [scaled, unit] = value < MILLION ? [value / THOUSAND, 'K'] : [value / MILLION, 'M']
  return `${scaled.toFixed(1).replace(/\.0$/, '')}${unit}`
}

/**
 * Lays out a label on the left and a value on the right of one content line.
 *
 * @param label - the left part; cut with `…` when the line is too narrow
 * @param value - the right part, kept whole
 * @param width - the content's columns
 * @returns the line
 */
function spread(label: string, value: string, width: number): string {
  const room = Math.max(1, width - visibleWidth(value) - 1)
  const left = truncateToWidth(label, room, '…')
  const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(value))
  return `${left}${' '.repeat(gap)}${value}`
}

/**
 * Frames a panel: a titled top border, each line between side borders, a bottom border.
 *
 * @param title - the title, shown in the top border
 * @param lines - the content lines; each is cut or padded to the content's width
 * @param width - the panel's columns, borders included
 * @returns the panel's rows
 */
function panel(title: string, lines: readonly string[], width: number): string[] {
  const inner = Math.max(1, width - FRAME_COLUMNS)
  const label = ` ${title} `
  const rest = Math.max(0, width - CORNER_COLUMNS - 1 - visibleWidth(label))
  const top = `${styleText('dim', '╭─')}${styleText('bold', label)}${styleText('dim', `${'─'.repeat(rest)}╮`)}`
  const body = lines.map(
    (line) =>
      `${styleText('dim', '│ ')}${truncateToWidth(line, inner, '…', true)}${styleText('dim', ' │')}`
  )
  const bottom = styleText('dim', `╰${'─'.repeat(Math.max(0, width - CORNER_COLUMNS))}╯`)
  return [top, ...body, bottom]
}

/**
 * Renders the PROXY panel's lines: address and auth, uptime and connections, models, and what is
 * wrong, if anything.
 *
 * @param input - the snapshot
 * @param width - the content's columns
 * @returns the lines
 */
function proxyLines(input: SidebarInput, width: number): string[] {
  const { proxy, now } = input
  const connections = proxy.connections === undefined ? '' : ` · ${String(proxy.connections)} conn`
  const lines = [
    spread(proxy.address, `auth ${proxy.proxyAuth}`, width),
    `up ${compactDuration(now - proxy.startedAt)}${connections}`
  ]
  if (typeof proxy.exposed === 'string') lines.push(styleText('red', 'exposure config error'))
  else if (proxy.exposed !== undefined && proxy.available !== undefined) {
    lines.push(`models ${String(proxy.exposed)}/${String(proxy.available)} exposed`)
  }
  if (input.cooldowns.length > 0) {
    lines.push(styleText('yellow', `${String(input.cooldowns.length)} cooling down`))
  }
  if (proxy.modelsJsonError) lines.push(styleText('red', 'models.json error'))
  return lines
}

/**
 * Picks a window's colour by how much of it is used.
 *
 * @param used - the share used, from 0 to 1
 * @param belowReserve - whether the provider is below its reserve, which is shown as spent
 * @returns the colour
 */
function usedColour(used: number, belowReserve: boolean): 'red' | 'yellow' | 'green' {
  if (belowReserve || used >= USED_LEVELS.high) return 'red'
  return used >= USED_LEVELS.warn ? 'yellow' : 'green'
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
  const colour = usedColour(used, account.belowReserve)
  const bar = `${styleText(colour, '█'.repeat(filled))}${styleText('dim', '░'.repeat(BAR_CELLS - filled))}`
  const percent = styleText(
    colour,
    `${String(Math.round(used * PERCENT))}%`.padStart('100%'.length)
  )
  const untilReset =
    window.resetsAt === undefined ? '' : ` ↻${compactDuration(window.resetsAt - input.now)}`
  const reset = styleText('dim', untilReset.padEnd(RESET_COLUMNS))
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
  return styleText('yellow', spread(`  ⏸ ${subject}`, left, width))
}

/**
 * Renders a login's first row: provider, login type and model count.
 *
 * @param account - the login
 * @param width - the content's columns
 * @returns the row
 */
function accountHeader(account: SidebarAccount, width: number): string {
  const login = account.type === 'oauth' ? 'account' : 'API key'
  return spread(
    styleText('bold', account.provider),
    styleText('dim', `${login} · ${String(account.models)}`),
    width
  )
}

/**
 * Renders one login: its first row, then each quota window, whether it is below its reserve, and
 * its cooldowns.
 *
 * @param account - the login
 * @param input - the snapshot
 * @param width - the content's columns
 * @returns the lines
 */
function accountLines(account: SidebarAccount, input: SidebarInput, width: number): string[] {
  const lines = [accountHeader(account, width)]
  for (const window of account.quota?.windows ?? []) {
    lines.push(windowLine(window, account, input, width))
  }
  if (account.belowReserve) lines.push(styleText('red', '  below reserve'))
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
 * Renders the ACCOUNTS panel's lines: every login, or how to add one. Under stress a quiet login
 * takes its first row only, so the logins in trouble stand out and the panel stays short.
 *
 * @param input - the snapshot
 * @param width - the content's columns
 * @param collapseQuiet - whether to collapse quiet logins
 * @returns the lines
 */
function accountsLines(input: SidebarInput, width: number, collapseQuiet: boolean): string[] {
  if (input.accounts.length === 0) return [styleText('dim', 'No logins · n to log in')]
  return input.accounts.flatMap((account) =>
    collapseQuiet && quiet(account, input)
      ? [accountHeader(account, width)]
      : accountLines(account, input, width)
  )
}

/**
 * Renders one request in flight: the model and its elapsed time, then its alias, mode, phase and
 * attempt.
 *
 * @param request - the request
 * @param now - the current time
 * @param width - the content's columns
 * @returns two lines
 */
function activeLines(request: ActiveRequest, now: number, width: number): string[] {
  const elapsed = compactDuration(now - request.startedAt)
  const modelWidth = Math.max(1, width - visibleWidth(elapsed) - 1)
  const model = fitLabel(request.model, modelWidth)
  // A stream waits for the model's first event, then streams; a plain request only waits.
  let state = request.stream ? 'waiting · stream' : 'waiting'
  if (request.firstEventAt !== undefined) state = styleText('green', 'streaming')
  const details = [request.alias ?? 'direct', state]
  if (request.attempt > 1) details.push(styleText('yellow', `try ${String(request.attempt)}`))
  return [`${model} ${elapsed}`, `  ${details.join(styleText('dim', ' · '))}`]
}

/**
 * Renders the ACTIVE panel's lines: the requests in flight, oldest first, or that there are none.
 *
 * @param input - the snapshot
 * @param width - the content's columns
 * @returns the lines
 */
function activeRequestLines(input: SidebarInput, width: number): string[] {
  if (input.active.length === 0) return [styleText('dim', 'idle')]
  const listed = input.active
    .slice(0, MAX_ACTIVE_LISTED)
    .flatMap((request) => activeLines(request, input.now, width))
  const hidden = input.active.length - MAX_ACTIVE_LISTED
  return hidden > 0 ? [...listed, styleText('dim', `+${String(hidden)} more`)] : listed
}

/**
 * Formats a request's time: `850ms`, `2.3s`, then as {@link compactDuration} from a minute.
 *
 * @param ms - the time, in milliseconds
 * @returns the text
 */
function latency(ms: number): string {
  if (ms < MS_PER_SECOND) return `${String(Math.max(0, Math.round(ms)))}ms`
  if (ms < SIXTY * MS_PER_SECOND) return `${(ms / MS_PER_SECOND).toFixed(1)}s`
  return compactDuration(ms)
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
 * Renders RECENT's last-minute line: the requests, with the failed and the rejected ones apart.
 *
 * @param lastMinute - the requests that finished in the last minute
 * @param width - the content's columns
 * @returns the line
 */
function lastMinuteLine(lastMinute: readonly FinishedRequest[], width: number): string {
  const rejected = lastMinute.filter((request) => request.outcome === 'rejected').length
  // Each kind keeps only its newest (FINISHED_KEPT, REJECTED_KEPT): a full one may be missing some
  // of the minute.
  const rejectedFull = rejected >= REJECTED_KEPT
  const full = lastMinute.length - rejected >= FINISHED_KEPT || rejectedFull
  const parts = [`${String(lastMinute.length)}${full ? '+' : ''} req`]
  const failed = lastMinute.filter((request) => request.outcome === 'failed').length
  if (failed > 0) parts.push(styleText('red', `${String(failed)} failed`))
  if (rejected > 0) {
    parts.push(styleText('yellow', `${String(rejected)}${rejectedFull ? '+' : ''} rejected`))
  }
  return spread('last minute', parts.join(' · '), width)
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
  return `${OUTCOME_MARKS[request.outcome]} ${model} ${styleText('dim', end)}`
}

/**
 * Renders the RECENT panel's lines: a summary (the last minute's requests, failures and
 * rejections, the average time and average time to a stream's first event of those the proxy
 * dispatched), then the latest finished requests.
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
  if (input.finished.length === 0) return { summary: [styleText('dim', 'none yet')], list: [] }
  const summary = [lastMinuteLine(lastMinute, width)]
  // A rejected request is answered at once: its time would only pull the average down.
  const dispatched = lastMinute.filter((request) => request.outcome !== 'rejected')
  const took = average(dispatched.map((request) => request.endedAt - request.startedAt))
  if (took !== undefined) summary.push(spread('  avg time', latency(took), width))
  const first = average(
    dispatched.map((request) =>
      request.firstEventAt === undefined ? undefined : request.firstEventAt - request.startedAt
    )
  )
  if (first !== undefined) summary.push(spread('  first event', latency(first), width))
  const list = input.finished
    .slice(0, MAX_RECENT_LISTED)
    .map((request) => finishedLine(request, width))
  return { summary, list }
}

/**
 * Renders the TRAFFIC panel's lines: requests, failures, fallbacks, tokens and cost since the
 * proxy started.
 *
 * @param input - the snapshot
 * @param width - the content's columns
 * @returns the lines
 */
function trafficLines(input: SidebarInput, width: number): string[] {
  const counts = sum(input.totals)
  const failed = String(counts.failures)
  return [
    spread('requests', String(counts.requests), width),
    spread('failed', counts.failures > 0 ? styleText('red', failed) : failed, width),
    spread('fallbacks', String(counts.fallbacks), width),
    spread(
      'tokens in/out',
      `${compactCount(counts.inputTokens)} / ${compactCount(counts.outputTokens)}`,
      width
    ),
    spread('cache', compactCount(counts.cacheReadTokens + counts.cacheWriteTokens), width),
    spread('cost', `$${counts.costUsd.toFixed(COST_DECIMALS)}`, width)
  ]
}

/** One panel before it is framed: its title, its lines, and how many of them a short screen keeps. */
interface PanelSpec {
  readonly id: 'proxy' | 'accounts' | 'active' | 'recent' | 'traffic'
  readonly title: string
  readonly lines: readonly string[]
  /** The lines kept when the screen is short: all of them, but RECENT's summary only. */
  readonly keep: number
}

/**
 * Describes a panel a short screen keeps whole or not at all.
 *
 * @param id - which panel
 * @param title - its title
 * @param lines - its lines
 * @returns the panel
 */
function whole(id: PanelSpec['id'], title: string, lines: readonly string[]): PanelSpec {
  return { id, title, lines, keep: lines.length }
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
 * @returns the title
 */
function recentTitle(lastMinute: readonly FinishedRequest[]): string {
  const failed = lastMinute.filter((request) => request.outcome === 'failed').length
  if (failed > 0) return `RECENT · ${String(failed)} failed`
  const rejected = lastMinute.filter((request) => request.outcome === 'rejected').length
  return rejected > 0 ? `RECENT · ${String(rejected)} rejected` : 'RECENT'
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
    const rows = panel(spec.title, spec.lines, width)
    return gaps && index > 0 ? ['', ...rows] : rows
  })
}

/**
 * Fits the panels to the height: with blank rows between them if they fit so, else without; then
 * without TRAFFIC; then with RECENT's list cut down to its summary; then cut at the bottom.
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
  const kept = specs.filter((spec) => spec.id !== 'traffic')
  const over = stack(kept, size.width, false).length - size.height
  const trimmed = kept.map((spec) =>
    spec.id === 'recent'
      ? { ...spec, lines: spec.lines.slice(0, Math.max(spec.keep, spec.lines.length - over)) }
      : spec
  )
  return stack(trimmed, size.width, false).slice(0, Math.max(0, size.height))
}

/**
 * Renders the sidebar: PROXY, ACCOUNTS, ACTIVE, RECENT and TRAFFIC panels. Under stress
 * ({@link underStress}) ACTIVE and RECENT come before ACCOUNTS, whose quiet logins collapse to one
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
  const proxy = whole('proxy', 'PROXY', proxyLines(input, inner))
  const accounts = whole(
    'accounts',
    `ACCOUNTS · ${String(input.accounts.length)}`,
    accountsLines(input, inner, stressed)
  )
  const active = whole(
    'active',
    `ACTIVE · ${String(input.active.length)}`,
    activeRequestLines(input, inner)
  )
  const recentPanel: PanelSpec = {
    id: 'recent',
    title: recentTitle(lastMinute),
    lines: [...recent.summary, ...recent.list],
    keep: recent.summary.length
  }
  const traffic = whole('traffic', 'TRAFFIC', trafficLines(input, inner))
  const order = stressed
    ? [proxy, active, recentPanel, accounts, traffic]
    : [proxy, accounts, active, recentPanel, traffic]
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
