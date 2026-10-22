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
import type { ActiveRequest } from '@proxy/server/active-requests'
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
 * Renders one login: provider, login type and model count, then each quota window, whether it is
 * below its reserve, and its cooldowns.
 *
 * @param account - the login
 * @param input - the snapshot
 * @param width - the content's columns
 * @returns the lines
 */
function accountLines(account: SidebarAccount, input: SidebarInput, width: number): string[] {
  const login = account.type === 'oauth' ? 'account' : 'API key'
  const lines = [
    spread(
      styleText('bold', account.provider),
      styleText('dim', `${login} · ${String(account.models)}`),
      width
    )
  ]
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
 * Renders the ACCOUNTS panel's lines: every login, or how to add one.
 *
 * @param input - the snapshot
 * @param width - the content's columns
 * @returns the lines
 */
function accountsLines(input: SidebarInput, width: number): string[] {
  if (input.accounts.length === 0) return [styleText('dim', 'No logins · n to log in')]
  return input.accounts.flatMap((account) => accountLines(account, input, width))
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
  if (request.phase === 'streaming') state = styleText('green', 'streaming')
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

/**
 * Renders the sidebar: PROXY, ACCOUNTS, ACTIVE and TRAFFIC panels, a blank row between them when
 * they fit with it.
 *
 * @param input - the snapshot
 * @param size - the space available
 * @param size.height - rows; panels that do not fit are cut at the bottom
 * @param size.width - columns, borders included
 * @returns the rows, each exactly `size.width` columns wide
 */
export function sidebarRows(
  input: SidebarInput,
  size: { readonly height: number; readonly width: number }
): string[] {
  const inner = Math.max(1, size.width - FRAME_COLUMNS)
  const panels = [
    panel('PROXY', proxyLines(input, inner), size.width),
    panel(`ACCOUNTS · ${String(input.accounts.length)}`, accountsLines(input, inner), size.width),
    panel(`ACTIVE · ${String(input.active.length)}`, activeRequestLines(input, inner), size.width),
    panel('TRAFFIC', trafficLines(input, inner), size.width)
  ]
  const tight = panels.flat()
  const spaced = panels.flatMap((rows, index) => (index === 0 ? rows : ['', ...rows]))
  const rows = spaced.length <= size.height ? spaced : tight.slice(0, size.height)
  return rows.map((row) => truncateToWidth(row, size.width, '', true))
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
