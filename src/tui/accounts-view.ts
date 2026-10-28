/**
 * The console's Accounts view (#61): each login pi has a credential for, as the proxy sees it,
 * with its quota (#69), its reserve, its cooldowns and its place in its provider's routing order
 * (#233), then the row that opens pi's login selector; under them, the selected row in full.
 *
 * @remarks
 * Rendering only: the console gathers an {@link AccountsView} snapshot (the quota store, the
 * reserve check and the cooldowns read once per frame) and redraws, so a render is a function of
 * its input. The table keeps every login's share used per window at any width: a narrow view
 * drops the gauges, never the numbers. The detail pane shows what a row can only abbreviate
 * (each window's reset, the reserve, the source, the verification, the actions) when the view has
 * room for it under the table.
 *
 * @packageDocumentation
 */

import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import type { LoginLabels } from '@proxy/config/schema'
import type { LoginRouting } from '@proxy/openai/model-logins'
import type { Cooldown } from '@proxy/pi/cooldowns'
import type { ProviderQuota, QuotaWindow } from '@proxy/pi/quota'
import type { ProviderCredentialStatus } from '@proxy/pi/registry'
import type { ReserveSkip } from '@proxy/server/route-reserve'
import { type LoginPlace, loginPlaces } from '@proxy/tui/login-routing'
import { accountActions, clampSelection, LOGIN_ROW } from '@proxy/tui/navigation'
import {
  compactDuration,
  firstShown,
  FRAME_COLUMNS,
  gauge,
  panel,
  quotaColor
} from '@proxy/tui/panel'
import { type ConsoleColor, highlight, paint, strong, tabAccent } from '@proxy/tui/theme'

/** Widths of the table's fixed columns: login, label, kind, model count. */
const COLUMNS = { login: 22, label: 14, kind: 7, models: 6 } as const
/** Columns the selection mark and the status dot take before the login. */
const LEAD = '› ● '.length
/** Percent in a whole: a window's share used is shown as a percentage. */
const PERCENT = 100
/** Columns a window's share takes, `100%` the widest. */
const PERCENT_COLUMNS = '100%'.length
/** The gauge's cells in the table: none below the least, never more than the most. */
const TABLE_GAUGE = { least: 4, most: 16 } as const
/** The gauge's cells in the detail pane. */
const DETAIL_GAUGE = { least: 10, most: 32 } as const
/** Columns between the detail pane's window name, its gauge and the text after it. */
const DETAIL_GAP = '  '
/** Between two windows in the table's quota cell. */
const WINDOW_GAP = '  '
/** Rows the table needs above the detail pane: its heading, and a blank row between. */
const TABLE_CHROME_ROWS = 2
/** Columns between the row's fixed cells and its quota cell. */
const QUOTA_GAP = '  '
/** Columns the selection mark takes before a row. */
const MARK_COLUMNS = '› '.length
/** Columns a row's fixed cells take: the dot, login, label, kind and models, a space between each. */
const FIXED_COLUMNS =
  1 + COLUMNS.login + COLUMNS.label + COLUMNS.kind + COLUMNS.models + Object.keys(COLUMNS).length

/** What the Accounts view shows. */
export interface AccountsView {
  /** The logins pi has a credential for. */
  readonly accounts: readonly ProviderCredentialStatus[]
  /** The selected row; the row after the accounts is the login row. */
  readonly selected: number
  /** Login -> the label the operator gave it. */
  readonly labels: LoginLabels
  /** The current time, for the time to each reset and each cooldown's end. */
  readonly now: number
  /** Login -> its latest quota report; a login that reported none is left out. */
  readonly quotas: ReadonlyMap<string, ProviderQuota>
  /** Login -> why it is below its `routing.reserve`; a login that is not is left out. */
  readonly belowReserve: ReadonlyMap<string, ReserveSkip>
  /** The active cooldowns, every login's. */
  readonly cooldowns: readonly Cooldown[]
  /** `routing.logins.order` and `.disabled`: each login's place, and which are disabled (#233). */
  readonly routing: LoginRouting
}

/** How the Accounts view looks up each login's quota and reserve: the stores, or a test's maps. */
export interface AccountLookups {
  /**
   * Reads a login's latest quota report.
   *
   * @param login - the login
   * @returns the report, or `undefined` when it reported none
   */
  quota(login: string): ProviderQuota | undefined
  /**
   * Checks whether a login is below its `routing.reserve`.
   *
   * @param login - the login
   * @returns why it is, or `undefined` when it is not
   */
  belowReserve(login: string): ReserveSkip | undefined
}

/**
 * Builds the Accounts view's snapshot: the logins and the selection as given, with each login's
 * quota report and reserve check looked up once.
 *
 * @param base - the logins, the selected row, the labels, the clock and the cooldowns
 * @param lookups - where each login's quota and reserve come from
 * @returns the snapshot
 */
export function accountsSnapshot(
  base: Omit<AccountsView, 'quotas' | 'belowReserve'>,
  lookups: AccountLookups
): AccountsView {
  const quotas = new Map<string, ProviderQuota>()
  const belowReserve = new Map<string, ReserveSkip>()
  for (const { provider } of base.accounts) {
    const quota = lookups.quota(provider)
    if (quota !== undefined) quotas.set(provider, quota)
    const skip = lookups.belowReserve(provider)
    if (skip !== undefined) belowReserve.set(provider, skip)
  }
  return { ...base, quotas, belowReserve }
}

/** One login's row, before it is laid out. */
interface AccountFacts {
  readonly account: ProviderCredentialStatus
  readonly label: string | undefined
  readonly windows: readonly QuotaWindow[]
  readonly reserve: ReserveSkip | undefined
  readonly cooldowns: readonly Cooldown[]
  readonly place: LoginPlace | undefined
}

/**
 * Gathers what the view knows about one login.
 *
 * @param account - the login's credential status; never the credential itself
 * @param view - the snapshot
 * @param places - every login's place in its provider's routing order
 * @returns the facts
 */
function factsOf(
  account: ProviderCredentialStatus,
  view: AccountsView,
  places: ReadonlyMap<string, LoginPlace>
): AccountFacts {
  return {
    account,
    label: view.labels[account.provider],
    windows: view.quotas.get(account.provider)?.windows ?? [],
    reserve: view.belowReserve.get(account.provider),
    cooldowns: view.cooldowns.filter((cooldown) => cooldown.provider === account.provider),
    place: places.get(account.provider)
  }
}

/**
 * Formats a share as a percentage.
 *
 * @param share - the share, from 0 to 1
 * @returns the text, such as `12%`
 */
function percent(share: number): string {
  return `${String(Math.round(share * PERCENT))}%`
}

/**
 * Picks the status dot's color: red when the last verification failed, yellow while the login is
 * cooling down or below its reserve, green otherwise.
 *
 * @param facts - the login
 * @returns the color
 */
function dotColor(facts: AccountFacts): ConsoleColor {
  if (facts.account.verified === false) return 'error'
  if (facts.cooldowns.length > 0 || facts.reserve !== undefined) return 'warning'
  return 'success'
}

/**
 * Renders the last verification of a login: `✓ verified`, or `✗` and why it failed.
 *
 * @param account - the login's credential status
 * @returns the note, or `undefined` when it was not verified (`v` verifies every login)
 */
function verificationNote(account: ProviderCredentialStatus): string | undefined {
  if (account.verified === undefined) return undefined
  if (account.verified) return paint('success', '✓ verified')
  return paint('error', `✗ ${account.error ?? 'failed'}`)
}

/**
 * Renders what a row notes after its quota: whether the login is disabled or called first among
 * several (#233), the reserve, the soonest cooldown's time left, the last verification.
 *
 * @param facts - the login
 * @param now - the current time
 * @returns the notes, each with a leading space; `''` for none
 */
function rowNotes(facts: AccountFacts, now: number): string {
  const notes: string[] = []
  if (facts.place?.disabled === true) notes.push(paint('dim', 'disabled'))
  else if (facts.place?.first === true && facts.place.count > 1) {
    notes.push(paint('accent', '▲ first'))
  }
  if (facts.reserve !== undefined) notes.push(paint('error', 'below reserve'))
  const soonest = facts.cooldowns.reduce<Cooldown | undefined>(
    (first, cooldown) => (first === undefined || cooldown.until < first.until ? cooldown : first),
    undefined
  )
  if (soonest !== undefined) {
    notes.push(paint('warning', `⏸ ${compactDuration(soonest.until - now)}`))
  }
  const verification = verificationNote(facts.account)
  if (verification !== undefined) notes.push(verification)
  return notes.map((note) => ` ${note}`).join('')
}

/**
 * Picks the table's gauge size for a quota cell of some width: as wide as the cell allows, within
 * {@link TABLE_GAUGE}, or none when even the least does not fit.
 *
 * @param windows - the login's windows
 * @param room - the cell's columns
 * @returns the gauge's cells, or 0 for none
 */
function tableGaugeCells(windows: readonly QuotaWindow[], room: number): number {
  const text = windows.reduce(
    (total, window) => total + visibleWidth(window.name) + 1 + PERCENT_COLUMNS,
    0
  )
  const gaps = WINDOW_GAP.length * Math.max(0, windows.length - 1)
  // One space between each gauge and its share.
  const perWindow = Math.floor((room - text - gaps - windows.length) / windows.length)
  if (perWindow < TABLE_GAUGE.least) return 0
  return Math.min(TABLE_GAUGE.most, perWindow)
}

/**
 * Picks the table's one gauge size: the largest every login's row has room for beside its notes,
 * so the gauges line up in a column; 0 when some row has no room for even the least.
 *
 * @param facts - the logins
 * @param width - a row's columns, after the selection mark
 * @param now - the current time, for the notes
 * @returns the gauge's cells
 */
function tableGauge(facts: readonly AccountFacts[], width: number, now: number): number {
  const withQuota = facts.filter((login) => login.windows.length > 0)
  if (withQuota.length === 0) return 0
  return Math.min(
    ...withQuota.map((login) => {
      const room = width - FIXED_COLUMNS - QUOTA_GAP.length - visibleWidth(rowNotes(login, now))
      return tableGaugeCells(login.windows, room)
    })
  )
}

/**
 * Renders a row's quota cell: each window's name, a gauge when there is room, and its share used.
 *
 * @param facts - the login
 * @param cells - the gauge's cells, the table's one size; 0 for none
 * @returns the cell; `—` for a login that reported no quota
 */
function quotaCell(facts: AccountFacts, cells: number): string {
  if (facts.windows.length === 0) return paint('border', '—')
  const belowReserve = facts.reserve !== undefined
  return facts.windows
    .map((window) => {
      const color = quotaColor(window.used, belowReserve)
      const bar = cells === 0 ? '' : `${gauge(window.used, cells, color)} `
      const share = paint(color, percent(window.used).padStart(PERCENT_COLUMNS))
      return `${paint('dim', window.name)} ${bar}${share}`
    })
    .join(WINDOW_GAP)
}

/**
 * Renders one login's row, without its selection mark: a status dot, the login, its label, its
 * kind, its model count, its quota and its notes.
 *
 * @param facts - the login
 * @param cells - the gauge's cells, the table's one size
 * @param now - the current time
 * @returns the row
 */
function accountRow(facts: AccountFacts, cells: number, now: number): string {
  const { account } = facts
  const label = facts.label === undefined ? paint('border', '—') : paint('accent', facts.label)
  const kind = account.type === 'oauth' ? 'account' : 'API key'
  // A login is cut with `…` when longer than its column (`qwen-token-plan-individual`, a
  // models.json provider), so the columns after it stay aligned; a disabled one is dimmed (#233).
  const name = truncateToWidth(account.provider, COLUMNS.login, '…', true)
  const fixed = [
    paint(dotColor(facts), '●'),
    facts.place?.disabled === true ? paint('dim', name) : name,
    truncateToWidth(label, COLUMNS.label, '…', true),
    paint('muted', kind.padEnd(COLUMNS.kind)),
    String(account.availableModelCount).padStart(COLUMNS.models)
  ].join(' ')
  return `${fixed}${QUOTA_GAP}${quotaCell(facts, cells)}${rowNotes(facts, now)}`
}

/**
 * Marks the selected row of a list: a pointer, in the theme's selection colors, across the row.
 *
 * @param text - the row's text
 * @param selected - whether it is the selected row
 * @param width - the row's columns
 * @returns the row, exactly `width` columns
 */
function selectable(text: string, selected: boolean, width: number): string {
  const row = truncateToWidth(`${selected ? '› ' : '  '}${text}`, width, '…', true)
  return selected ? highlight(row) : row
}

/**
 * Renders the table's heading.
 *
 * @param width - the view's columns
 * @returns the row
 */
function heading(width: number): string {
  const titles = [
    ' '.repeat(LEAD - 1),
    'login'.padEnd(COLUMNS.login),
    'label'.padEnd(COLUMNS.label),
    'kind'.padEnd(COLUMNS.kind),
    'models'.padStart(COLUMNS.models),
    ' quota used'
  ]
  return truncateToWidth(paint('dim', titles.join(' ')), width, '', true)
}

/**
 * Renders a login's quota windows in the detail pane: each one's name, a gauge, the share used
 * and the time to its reset, the gauges one size and in one column.
 *
 * @param facts - the login, its windows and its reserve
 * @param width - the pane's content columns
 * @param now - the current time
 * @returns one line per window
 */
function detailWindows(facts: AccountFacts, width: number, now: number): string[] {
  const names = facts.windows.map((window) => `${window.name} window`)
  const tails = facts.windows.map((window) => {
    const reset =
      window.resetsAt === undefined
        ? ''
        : `${paint('dim', ' · resets in ')}${compactDuration(window.resetsAt - now)}`
    return `${strong(percent(window.used))}${paint('dim', ' used')}${reset}`
  })
  // Measured, so the gauges line up whatever the providers call their windows, and the gauge
  // gives way before the time to reset does.
  const nameWidth = Math.max(0, ...names.map((windowName) => windowName.length))
  const tailWidth = Math.max(0, ...tails.map((tail) => visibleWidth(tail)))
  // One gap between the name and the gauge, one between the gauge and the text after it.
  const room = width - nameWidth - tailWidth - `${DETAIL_GAP}${DETAIL_GAP}`.length
  const cells = Math.min(DETAIL_GAUGE.most, Math.max(DETAIL_GAUGE.least, room))
  return facts.windows.map((window, windowIndex) => {
    const color = quotaColor(window.used, facts.reserve !== undefined)
    const name = paint('dim', (names[windowIndex] ?? '').padEnd(nameWidth))
    const bar = gauge(window.used, cells, color)
    return `${name}${DETAIL_GAP}${bar}${DETAIL_GAP}${tails[windowIndex] ?? ''}`
  })
}

/**
 * Renders a cooldown in the detail pane: the whole login, or one of its models.
 *
 * @param cooldown - the cooldown
 * @param now - the current time
 * @returns the line
 */
function detailCooldown(cooldown: Cooldown, now: number): string {
  const subject =
    cooldown.scope === 'provider'
      ? 'cooling down'
      : `${cooldown.model?.slice(cooldown.provider.length + 1) ?? 'a model'} cooling down`
  return paint('warning', `⏸ ${subject}, ${compactDuration(cooldown.until - now)} left`)
}

/**
 * Renders a login's place in its provider's routing order (#233): disabled, or its place among
 * several logins.
 *
 * @param place - the login's place
 * @returns the line, or `undefined` for a provider's only login that is not disabled
 */
function routingLine(place: LoginPlace | undefined): string | undefined {
  if (place === undefined) return undefined
  if (place.disabled) return paint('dim', 'disabled: routing never calls it; it stays logged in')
  if (place.count === 1) return undefined
  const order = `${paint('dim', 'order ')}${String(place.position)} of ${String(place.count)}`
  return place.first ? `${order}  ${paint('accent', '▲ called first')}` : order
}

/**
 * Lists the detail pane's lines for a login: its kind, source and models; each quota window; the
 * reserve, cooldowns, routing place and verification when there are any; then the actions Enter
 * opens.
 *
 * @param facts - the login
 * @param width - the pane's content columns
 * @param now - the current time
 * @returns the lines
 */
function detailLines(facts: AccountFacts, width: number, now: number): string[] {
  const { account } = facts
  const kind = account.type === 'oauth' ? 'account' : 'API key'
  const field = (name: string, value: string): string => `${paint('dim', `${name} `)}${value}`
  const lines = [
    [
      field('kind', kind),
      field('source', account.source ?? '—'),
      field('models', String(account.availableModelCount))
    ].join('    '),
    ''
  ]
  if (facts.windows.length === 0) {
    lines.push(`${paint('dim', 'quota ')}no quota reported yet`)
  }
  lines.push(...detailWindows(facts, width, now))
  if (facts.reserve !== undefined) {
    const { window, left, reserve } = facts.reserve
    lines.push(
      paint(
        'error',
        `below reserve: ${percent(left)} of ${window} left, reserve ${percent(reserve)}`
      )
    )
  }
  for (const cooldown of facts.cooldowns) lines.push(detailCooldown(cooldown, now))
  const routing = routingLine(facts.place)
  if (routing !== undefined) lines.push(routing)
  const verification = verificationNote(account)
  if (verification !== undefined) lines.push(verification)
  const actions = accountActions(account, facts.place).map((choice) => choice.label.toLowerCase())
  lines.push('', `${tabAccent('↵')} ${paint('dim', `actions: ${actions.join(', ')}`)}`)
  return lines
}

/**
 * Frames the detail pane for the selected row: the login in full, or what the login row does.
 *
 * @param selected - the selected login, or `undefined` for the login row
 * @param width - the view's columns
 * @param now - the current time
 * @returns the pane's rows
 */
function detailPane(selected: AccountFacts | undefined, width: number, now: number): string[] {
  const inner = Math.max(1, width - FRAME_COLUMNS)
  if (selected === undefined) {
    const enter = `${tabAccent('↵')} ${paint('dim', "opens pi's login list: a provider, or another login of one you have")}`
    return panel('LOG IN', [enter], width)
  }
  return panel(selected.account.provider, detailLines(selected, inner, now), width, selected.label)
}

/**
 * Renders the Accounts view: a heading, one row per login, the login row, and the detail pane
 * for the selected row at the bottom when the view has room for it.
 *
 * @param view - the snapshot
 * @param size - the space available
 * @param size.height - rows
 * @param size.width - columns
 * @returns the rows, at most `size.height`, each exactly `size.width` columns
 */
export function accountRows(
  view: AccountsView,
  size: { readonly height: number; readonly width: number }
): string[] {
  const places = loginPlaces(
    view.accounts.map((account) => account.provider),
    view.routing
  )
  const facts = view.accounts.map((account) => factsOf(account, view, places))
  const current = clampSelection(view.selected, facts.length)
  const cells = tableGauge(facts, size.width - MARK_COLUMNS, view.now)
  const table = [
    ...facts.map((login, index) =>
      selectable(accountRow(login, cells, view.now), index === current, size.width)
    ),
    selectable(LOGIN_ROW, current === facts.length, size.width)
  ]
  const detail = detailPane(facts[current], size.width, view.now)
  const withDetail = TABLE_CHROME_ROWS + table.length + detail.length <= size.height
  const visible = Math.max(0, size.height - 1)
  const start = firstShown(current, table.length, visible)
  const shown = table.slice(start, start + visible)
  if (!withDetail) return [heading(size.width), ...shown].slice(0, size.height)
  const filler = size.height - 1 - shown.length - detail.length
  const blank = ' '.repeat(size.width)
  return [heading(size.width), ...shown, ...Array.from({ length: filler }, () => blank), ...detail]
}
