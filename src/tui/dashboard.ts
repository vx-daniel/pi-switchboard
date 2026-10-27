/**
 * The console's Stats dashboard (#216): the stats file's history over a window (today, the last
 * week, or all 30 days kept), as headline numbers in tiles, a timeline of requests, a table per
 * served model, and a line on what went wrong.
 *
 * @remarks
 * {@link dashboardRows} renders a {@link DashboardData} snapshot and reads nothing else;
 * {@link createDashboardSource} reads that snapshot from the stats store, at most every few seconds
 * for one window and chart width, so redraws on every request don't query the file each time.
 * {@link createTodayCostSource} reads today's cost for the status strip the same way, apart from
 * the dashboard's snapshot so the two don't push each other out.
 * {@link openStatsView} is what the console holds: the dashboard while the stats file is open, the
 * totals since the proxy started otherwise.
 *
 * @packageDocumentation
 */

import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import { proxyLogger } from '@proxy/logging'
import { routeTotals, routeTotalsSince } from '@proxy/server/route-totals'
import { promptTokens } from '@proxy/stats/cache'
import { statsFilePath } from '@proxy/stats/recorder'
import {
  type AliasStats,
  type ErrorStats,
  type MinuteRange,
  type ModelStats,
  openStatsStore,
  type StatsStore,
  type TimelineBucket,
  type UsageStats
} from '@proxy/stats/store'
import {
  STATS_KEPT_DAYS,
  STATS_WINDOWS,
  type StatsWindow,
  windowMinutes
} from '@proxy/stats/windows'
import { STATS_WINDOW_KEYS } from '@proxy/tui/navigation'
import {
  compactCount,
  compactDuration,
  FRAME_COLUMNS,
  hitRate,
  latency,
  panel,
  spread,
  usd
} from '@proxy/tui/panel'
import { fitLabel, statsRows } from '@proxy/tui/stats-view'
import { activeTab, type ConsoleColor, keycap, paint, strong, tabAccent } from '@proxy/tui/theme'
import { errorMessage } from '@proxy/utils/guards'
import { MS_PER_MINUTE } from '@proxy/utils/time'

/** Logger for the console's own actions. */
const consoleLogger = proxyLogger('tui')

/** Minutes in an hour. */
const MINUTES_PER_HOUR = 60
/** How long a snapshot is reused for one window and width, in milliseconds. */
const SNAPSHOT_MS = 5000
/** Rows the timeline's bars take at most and at least. */
const CHART_ROWS = { most: 16, least: 3 } as const
/** Model rows the layout makes room for before the timeline takes the rest. */
const MODEL_ROWS_WANTED = 6
/** Alias rows the layout makes room for, when any request named an alias. */
const ALIAS_ROWS_WANTED = 4
/** The bar heights, in eighths of a row. */
const EIGHTHS = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const
/** Eighths in a full cell. */
const FULL_CELL = 8
/** Decimal places the COST tile's cost per request is shown with: most requests cost under a cent. */
const PER_REQUEST_COST_DECIMALS = 3
/** Decimal places the REQUESTS tile's rate per hour is shown with. */
const RATE_DECIMALS = 1
/** The dashboard's panels that always show; ALIASES shows when a request named an alias. */
const PANELS = ['TIMELINE', 'MODELS'] as const
/** Rows a panel's frame takes: its top and bottom borders. */
const BORDER_ROWS = 2
/** Rows the panels' frames take. */
const FRAME_ROWS = PANELS.length * BORDER_ROWS
/**
 * Rows that don't change with the screen, by where they are: the window line, the timeline's peak
 * and axis lines, the models' heading and the errors line.
 */
const FIXED_LINES = { window: 1, timeline: 2, modelsHeading: 1, errors: 1 } as const
/** Rows the tiles take: a blank row under the window line, then each tile's label, number and caption. */
const TILE_ROWS = 4
/** The dashboard's narrowest width that shows all six tiles; a narrower one shows four. */
const ALL_TILES_LEAST_WIDTH = 110
/** What comes before the first tile's text, and between a tile's rule and its text. */
const TILE_PADDING = ' '
/** Rows the ALIASES panel takes besides its alias rows: its frame and its heading. */
const ALIAS_PANEL_ROWS = BORDER_ROWS + 1
/** The label column's narrowest width. */
const LABEL_LEAST = 12
/** Which of the usage table's number columns is the failures. */
const FAILED_COLUMN = 1
/** What the frame's bottom border notes while the dashboard is shown. */
const KEPT_NOTE = `stats kept ${String(STATS_KEPT_DAYS)} days`
/** What the ALIASES panel calls requests that named a model directly. */
const DIRECT_LABEL = 'direct'

/**
 * The usage table's number columns, for models and aliases alike. `in` is the whole prompt, cached
 * parts included, as a chat completion's `prompt_tokens` is; `hit` is the share of it read from
 * the cache.
 */
const USAGE_COLUMNS: readonly {
  readonly title: string
  readonly width: number
  readonly cell: (usage: UsageStats) => string
}[] = [
  { title: 'req', width: 7, cell: (usage) => compactCount(usage.requests) },
  { title: 'fail', width: 5, cell: (usage) => compactCount(usage.failed) },
  { title: 'fb', width: 4, cell: (usage) => compactCount(usage.fallbacks) },
  { title: 'avg', width: 7, cell: (usage) => optionalLatency(usage.averageMs) },
  { title: 'slow', width: 7, cell: (usage) => latency(usage.slowestMs) },
  { title: '1st', width: 7, cell: (usage) => optionalLatency(usage.averageFirstEventMs) },
  { title: 'hit', width: 4, cell: (usage) => hitRate(usage) },
  {
    title: 'tok in/out',
    width: 13,
    cell: (usage) => `${compactCount(promptTokens(usage))}/${compactCount(usage.outputTokens)}`
  },
  { title: 'cost', width: 8, cell: (usage) => usd(usage.costUsd) }
]

/** What one render of the dashboard shows. */
export interface DashboardData {
  readonly window: StatsWindow
  /** The minutes the window covers. */
  readonly range: MinuteRange
  /** Minutes per timeline bucket. */
  readonly bucketMinutes: number
  readonly timeline: readonly TimelineBucket[]
  readonly models: readonly ModelStats[]
  /** Each alias's numbers, requests that named a model directly under ''. */
  readonly aliases: readonly AliasStats[]
  readonly errors: ErrorStats
}

/**
 * Works out a window's minutes, and the bucket size that fits its timeline in the chart's columns.
 *
 * @param window - the window
 * @param now - the current time, in milliseconds since the epoch
 * @param columns - the chart's width: one column per bucket
 * @returns the minutes and the bucket size
 */
export function windowRange(
  window: StatsWindow,
  now: number,
  columns: number
): { range: MinuteRange; bucketMinutes: number } {
  const range = windowMinutes(window, now)
  const span = range.toMinute - range.fromMinute
  return { range, bucketMinutes: Math.max(1, Math.ceil(span / Math.max(1, columns))) }
}

/**
 * Counts how many columns the dashboard's timeline has at a width: one bar per column.
 *
 * @param width - the dashboard's width
 * @returns the chart's columns
 */
function chartColumns(width: number): number {
  return Math.max(1, width - FRAME_COLUMNS)
}

/**
 * Creates the dashboard's reader of the stats store: a snapshot is read again only after a few
 * seconds, or for another window or chart width.
 *
 * @param store - the stats store
 * @param now - the clock
 * @returns a function from a window and the chart's width to the snapshot
 */
export function createDashboardSource(
  store: Pick<StatsStore, 'timeline' | 'models' | 'aliases' | 'errors'>,
  now: () => number = Date.now
): (window: StatsWindow, columns: number) => DashboardData {
  let cached: { key: string; at: number; data: DashboardData } | undefined
  return (window, columns) => {
    const at = now()
    const key = `${window}:${String(columns)}`
    if (cached?.key === key && at - cached.at < SNAPSHOT_MS) return cached.data
    const { range, bucketMinutes } = windowRange(window, at, columns)
    const data: DashboardData = {
      window,
      range,
      bucketMinutes,
      timeline: store.timeline(range, bucketMinutes),
      models: store.models(range),
      aliases: store.aliases(range),
      errors: store.errors(range)
    }
    cached = { key, at, data }
    return data
  }
}

/**
 * Creates the status strip's reader of today's cost: the cost of the requests since local
 * midnight, read again only after a few seconds. It keeps its own snapshot, so the strip reading
 * it on every redraw doesn't push out the dashboard's.
 *
 * @param store - the stats store
 * @param now - the clock
 * @returns a function to today's cost, in US dollars
 */
export function createTodayCostSource(
  store: Pick<StatsStore, 'models'>,
  now: () => number = Date.now
): () => number {
  let cached: { at: number; costUsd: number } | undefined
  return () => {
    const at = now()
    if (cached !== undefined && at - cached.at < SNAPSHOT_MS) return cached.costUsd
    const models = store.models(windowMinutes('today', at))
    const costUsd = models.reduce((total, model) => total + model.costUsd, 0)
    cached = { at, costUsd }
    return costUsd
  }
}

/**
 * Formats a time that may be missing.
 *
 * @param ms - the time, or `undefined`
 * @returns the time, or `-`
 */
function optionalLatency(ms: number | undefined): string {
  return ms === undefined ? '-' : latency(ms)
}

/**
 * Renders the line of window pills: each window's key and name, the current one as an amber pill.
 *
 * @param current - the window shown
 * @param width - the line's columns
 * @returns the line
 */
function windowLine(current: StatsWindow, width: number): string {
  const pills = STATS_WINDOWS.map((window) => {
    const [key, label] = STATS_WINDOW_KEYS[window]
    if (window === current) return activeTab(` ${key}  ${label} `)
    return `${keycap(` ${key} `)} ${paint('muted', label)}`
  })
  return truncateToWidth(` ${pills.join('   ')}`, width, '…', true)
}

/**
 * Formats the minutes one timeline bar covers, for the TIMELINE panel's top border.
 *
 * @param bucketMinutes - minutes per bucket
 * @returns the text, such as `22 min per bar` or `4h per bar`
 */
function perBarLabel(bucketMinutes: number): string {
  const length =
    bucketMinutes < MINUTES_PER_HOUR
      ? `${String(bucketMinutes)} min`
      : compactDuration(bucketMinutes * MS_PER_MINUTE)
  return `${length} per bar`
}

/**
 * Averages a time over the models that have one, weighted by their requests.
 *
 * @param models - the models
 * @param pick - the time to average
 * @returns the average, or `-` with none
 */
function weightedLatency(
  models: readonly ModelStats[],
  pick: (model: ModelStats) => number | undefined
): string {
  let total = 0
  let count = 0
  for (const model of models) {
    const value = pick(model)
    if (value === undefined) continue
    total += value * model.requests
    count += model.requests
  }
  return count > 0 ? latency(total / count) : '-'
}

/** The window's numbers summed over its models, for the tiles and the errors line. */
interface WindowTotals {
  readonly served: number
  readonly failed: number
  /** Requests rejected before reaching a model, of any status. */
  readonly rejected: number
  /** The whole prompt, cached parts included. */
  readonly promptTokens: number
  readonly outputTokens: number
  readonly costUsd: number
  /** The slowest request of any model. */
  readonly slowestMs: number
}

/**
 * Sums the window's numbers over its models.
 *
 * @param data - the snapshot
 * @returns the totals
 */
function windowTotals(data: DashboardData): WindowTotals {
  const totalOf = (pick: (model: ModelStats) => number): number =>
    data.models.reduce((total, model) => total + pick(model), 0)
  return {
    served: totalOf((model) => model.requests),
    failed: totalOf((model) => model.failed),
    rejected: data.errors.rejected.reduce((total, row) => total + row.count, 0),
    promptTokens: totalOf((model) => promptTokens(model)),
    outputTokens: totalOf((model) => model.outputTokens),
    costUsd: totalOf((model) => model.costUsd),
    slowestMs: Math.max(0, ...data.models.map((model) => model.slowestMs))
  }
}

/** One headline number: what it is, the number (styled), and a line on it. */
interface Tile {
  readonly label: string
  readonly value: string
  readonly caption: string
}

/**
 * Lists the tiles: requests, failures, average time, first event, tokens and cost; at a width
 * under {@link ALL_TILES_LEAST_WIDTH}, only requests, failures, average time and cost.
 *
 * @param data - the snapshot
 * @param totals - its totals
 * @param width - the dashboard's columns
 * @returns the tiles, left to right
 */
function overviewTiles(data: DashboardData, totals: WindowTotals, width: number): Tile[] {
  const hours = (data.range.toMinute - data.range.fromMinute) / MINUTES_PER_HOUR
  const perHour = hours > 0 ? totals.served / hours : 0
  const served = totals.served > 0
  const perRequest = served ? totals.costUsd / totals.served : 0
  const tiles = {
    requests: {
      label: 'REQUESTS',
      value: strong(compactCount(totals.served)),
      caption: `${perHour.toFixed(RATE_DECIMALS)} per hour`
    },
    failed: {
      label: 'FAILED',
      value: strong(paint(totals.failed > 0 ? 'error' : 'success', compactCount(totals.failed))),
      caption: `${compactCount(totals.rejected)} rejected`
    },
    average: {
      label: 'AVG TIME',
      value: strong(
        paint(
          'accent',
          weightedLatency(data.models, (model) => model.averageMs)
        )
      ),
      caption: `slowest ${served ? latency(totals.slowestMs) : '-'}`
    },
    firstEvent: {
      label: '1ST EVENT',
      value: strong(
        paint(
          'accent',
          weightedLatency(data.models, (model) => model.averageFirstEventMs)
        )
      ),
      caption: 'average wait'
    },
    tokens: {
      label: 'TOKENS OUT',
      value: strong(compactCount(totals.outputTokens)),
      caption: `${compactCount(totals.promptTokens)} in`
    },
    cost: {
      label: 'COST',
      value: strong(tabAccent(usd(totals.costUsd))),
      caption: `${usd(perRequest, PER_REQUEST_COST_DECIMALS)} each`
    }
  }
  if (width >= ALL_TILES_LEAST_WIDTH) return Object.values(tiles)
  return [tiles.requests, tiles.failed, tiles.average, tiles.cost]
}

/**
 * Renders the tiles side by side, split by thin rules: a blank row, then the labels, the numbers
 * and the captions. The tiles share the width; the last takes what dividing it leaves over, so
 * each row is exactly `width` columns.
 *
 * @param tiles - the tiles, left to right
 * @param width - the dashboard's columns
 * @returns the rows
 */
function tileRows(tiles: readonly Tile[], width: number): string[] {
  const tileWidth = Math.floor(width / Math.max(1, tiles.length))
  const line = (text: (tile: Tile) => string): string => {
    const cells = tiles.map((tile, tileIndex) => {
      const lead = tileIndex === 0 ? TILE_PADDING : `${paint('border', '│')}${TILE_PADDING}`
      const last = tileIndex === tiles.length - 1
      const columns = last ? width - tileWidth * tileIndex : tileWidth
      // One column after the text, before the next tile's rule.
      const room = Math.max(0, columns - visibleWidth(lead) - 1)
      return `${lead}${truncateToWidth(text(tile), room, '…', true)} `
    })
    return truncateToWidth(cells.join(''), width, '', true)
  }
  return [
    ' '.repeat(width),
    line((tile) => paint('dim', tile.label)),
    line((tile) => tile.value),
    line((tile) => paint('muted', tile.caption))
  ]
}

/**
 * Scales a count to eighths of a row against the busiest bucket; any count shows at least one.
 *
 * @param count - the count
 * @param peak - the busiest bucket's requests
 * @param rows - the bars' height
 * @returns the height, in eighths
 */
function eighthsOf(count: number, peak: number, rows: number): number {
  if (count === 0 || peak === 0) return 0
  return Math.max(1, Math.round((count / peak) * rows * FULL_CELL))
}

/**
 * Renders one column of a timeline row: blue for the bucket's requests, with its failed and
 * rejected requests stacked at the foot of the bar, at least one cell when there are any. The
 * share is red when any request failed, yellow when they were only rejected; a cell has one color,
 * so the cell where the share ends takes the share's color.
 *
 * @param bucket - the bucket
 * @param peak - the busiest bucket's requests
 * @param rows - the bars' height
 * @param floor - eighths below this cell
 * @returns the cell
 */
function barCell(bucket: TimelineBucket, peak: number, rows: number, floor: number): string {
  const fill = Math.min(FULL_CELL, Math.max(0, eighthsOf(bucket.requests, peak, rows) - floor))
  if (fill === 0) return ' '
  const bad = bucket.failed + bucket.rejected
  const badColor: ConsoleColor = bucket.failed > 0 ? 'error' : 'warning'
  const color = floor < eighthsOf(bad, peak, rows) ? badColor : 'accent'
  return paint(color, EIGHTHS[fill] ?? '█')
}

/**
 * Renders the timeline's bars: one column per bucket, its height the bucket's requests against the
 * busiest bucket's, in eighths of a row.
 *
 * @param timeline - the buckets, oldest first
 * @param rows - the bars' height
 * @returns the rows, top first
 */
function chartRows(timeline: readonly TimelineBucket[], rows: number): string[] {
  const peak = Math.max(0, ...timeline.map((bucket) => bucket.requests))
  return Array.from({ length: rows }, (_, row) => {
    const floor = (rows - 1 - row) * FULL_CELL
    return timeline.map((bucket) => barCell(bucket, peak, rows, floor)).join('')
  })
}

/**
 * Formats a minute for the timeline's axis: the time for today, the day otherwise.
 *
 * @param minute - the minute
 * @param window - the window
 * @returns the label
 */
function axisLabel(minute: number, window: StatsWindow): string {
  const date = new Date(minute * MS_PER_MINUTE)
  return window === 'today'
    ? date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
    : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/**
 * Renders the TIMELINE panel's lines: the busiest bar and the legend, the bars, and the axis from
 * the window's start to now. The bucket size is rounded up, so the bars can number fewer than the
 * columns: they end at the right, under `now`, and the start label moves with the first bar.
 *
 * @param data - the snapshot
 * @param rows - the bars' height
 * @param width - the content's columns
 * @returns the lines
 */
function timelineLines(data: DashboardData, rows: number, width: number): string[] {
  const peak = Math.max(0, ...data.timeline.map((bucket) => bucket.requests))
  const legend = `${paint('error', '█')} failed  ${paint('warning', '█')} rejected`
  const head = spread(paint('dim', `peak ${compactCount(peak)} per bar`), legend, width)
  const indent = ' '.repeat(Math.max(0, width - data.timeline.length))
  const bars = chartRows(data.timeline, rows).map((row) => `${indent}${row}`)
  const start = `${indent}${axisLabel(data.range.fromMinute, data.window)}`
  return [head, ...bars, paint('dim', spread(start, 'now', width))]
}

/**
 * Renders a usage table's lines (MODELS, ALIASES): a heading, then one row per entry, busiest
 * first, fitted to the room left.
 *
 * @param heading - the label column's title
 * @param entries - each row's label and numbers
 * @param room - the rows the entries may take
 * @param width - the content's columns
 * @returns the lines
 */
function usageLines(
  heading: string,
  entries: readonly { readonly label: string; readonly usage: UsageStats }[],
  room: number,
  width: number
): string[] {
  const numbers = USAGE_COLUMNS.reduce((total, column) => total + column.width + 1, 0)
  const labelWidth = Math.max(LABEL_LEAST, width - numbers)
  const titles = USAGE_COLUMNS.map((column) => column.title.padStart(column.width)).join(' ')
  const head = paint('dim', `${fitLabel(heading, labelWidth)} ${titles}`)
  if (entries.length === 0) return [head, paint('dim', 'No requests in this window.')]
  const rows = entries.map(({ label, usage }) => {
    const cells = USAGE_COLUMNS.map((column) => column.cell(usage).padStart(column.width))
    if (usage.failed > 0) cells[FAILED_COLUMN] = paint('error', cells[FAILED_COLUMN] ?? '')
    return `${fitLabel(label, labelWidth)} ${cells.join(' ')}`
  })
  if (rows.length <= room) return [head, ...rows]
  const kept = Math.max(0, room - 1)
  return [head, ...rows.slice(0, kept), paint('dim', `+${String(rows.length - kept)} more`)]
}

/**
 * Lists what the errors line says after its counts: the failed attempts by class, then the
 * rejected requests by status.
 *
 * @param errors - the window's errors
 * @returns the details, none when there are neither
 */
function errorDetails(errors: ErrorStats): string[] {
  const details: string[] = []
  if (errors.failures.length > 0) {
    const classes = errors.failures.map((row) => `${row.failureClass} ${compactCount(row.count)}`)
    details.push(`failed attempts ${classes.join(', ')}`)
  }
  if (errors.rejected.length > 0) {
    const statuses = errors.rejected.map(
      (row) => `${String(row.status)} ×${compactCount(row.count)}`
    )
    details.push(`rejected ${statuses.join(', ')}`)
  }
  return details
}

/**
 * Renders the line on what went wrong: a check when nothing did; otherwise the failed and rejected
 * requests, then the failed attempts by class and the rejections by status, cut at the line's end.
 *
 * @remarks
 * A request that fell back after a failed attempt is served, not failed, so a failed attempt's
 * class can show with no failed request.
 *
 * @param totals - the window's totals
 * @param errors - the window's errors
 * @param width - the line's columns
 * @returns the line
 */
function errorLine(totals: WindowTotals, errors: ErrorStats, width: number): string {
  const details = errorDetails(errors)
  if (totals.failed === 0 && totals.rejected === 0 && details.length === 0) {
    const none = paint('muted', 'no failed or rejected requests in this window')
    return truncateToWidth(` ${paint('success', '✓')} ${none}`, width, '…', true)
  }
  const failed = paint(
    totals.failed > 0 ? 'error' : 'muted',
    `${compactCount(totals.failed)} failed`
  )
  const rejected = paint(
    totals.rejected > 0 ? 'warning' : 'muted',
    `${compactCount(totals.rejected)} rejected`
  )
  let line = `${paint('error', '✗')} ${failed}${paint('dim', ' · ')}${rejected}`
  if (details.length > 0) line += paint('dim', ` — ${details.join(' · ')}`)
  return truncateToWidth(` ${line}`, width, '…', true)
}

/** How the dashboard's rows are shared out at one height. */
interface DashboardLayout {
  /** Whether the tiles show. */
  readonly tiles: boolean
  /** Rows of timeline bars. */
  readonly chart: number
  /** Rows for the MODELS table's entries. */
  readonly modelRoom: number
  /** Rows for the ALIASES table's entries; 0 without the panel. */
  readonly aliasRoom: number
}

/**
 * Shares out the dashboard's rows. What gives way first on a short screen, last first: the
 * timeline's bars past {@link CHART_ROWS}' least, the tables' rows past one each, then the tiles;
 * the timeline keeps its least rows and each table one row while the screen has room for them.
 *
 * @param entries - how many rows each table has
 * @param entries.models - models served in the window
 * @param entries.aliases - aliases in the ALIASES table; 0 when it isn't shown
 * @param height - the dashboard's rows
 * @returns the layout
 */
function dashboardLayout(
  entries: { readonly models: number; readonly aliases: number },
  height: number
): DashboardLayout {
  const aliasPanel = entries.aliases === 0 ? 0 : ALIAS_PANEL_ROWS
  const fixed =
    FRAME_ROWS + aliasPanel + Object.values(FIXED_LINES).reduce((total, rows) => total + rows, 0)
  // One row for the models, and one for the aliases when their panel shows.
  const leastTableRows = 1 + Math.min(1, entries.aliases)
  const tiles = height - fixed - CHART_ROWS.least - leastTableRows >= TILE_ROWS
  const room = height - fixed - (tiles ? TILE_ROWS : 0)
  const modelsWanted = Math.min(Math.max(1, entries.models), MODEL_ROWS_WANTED)
  const aliasesWanted = Math.min(entries.aliases, ALIAS_ROWS_WANTED)
  const chart = Math.min(
    CHART_ROWS.most,
    Math.max(CHART_ROWS.least, room - modelsWanted - aliasesWanted)
  )
  const tableRoom = Math.max(1, room - chart)
  const aliasRoom = entries.aliases === 0 ? 0 : Math.max(1, Math.min(aliasesWanted, tableRoom - 1))
  return { tiles, chart, modelRoom: Math.max(1, tableRoom - aliasRoom), aliasRoom }
}

/**
 * Renders the dashboard: the window pills, the tiles, then TIMELINE, MODELS, ALIASES (when a
 * request named an alias) and the errors line. The timeline takes the room the tables don't need,
 * between 3 and 16 rows of bars; on a short screen {@link dashboardLayout} says what gives way,
 * and below the least of everything the bottom is cut.
 *
 * @param data - the snapshot
 * @param size - the space available
 * @param size.height - rows
 * @param size.width - columns
 * @returns the rows
 */
export function dashboardRows(
  data: DashboardData,
  size: { readonly height: number; readonly width: number }
): string[] {
  const inner = Math.max(1, size.width - FRAME_COLUMNS)
  // Only direct requests: the table would repeat the totals, so it isn't shown.
  const aliases = data.aliases.some((alias) => alias.alias !== '') ? data.aliases : []
  const layout = dashboardLayout(
    { models: data.models.length, aliases: aliases.length },
    size.height
  )
  const totals = windowTotals(data)
  const modelEntries = data.models.map((model) => ({ label: model.model, usage: model }))
  const aliasEntries = aliases.map((alias) => ({
    label: alias.alias === '' ? DIRECT_LABEL : alias.alias,
    usage: alias
  }))
  const timeline = timelineLines(data, layout.chart, inner)
  const rows = [
    windowLine(data.window, size.width),
    ...(layout.tiles ? tileRows(overviewTiles(data, totals, size.width), size.width) : []),
    ...panel('TIMELINE', timeline, size.width, perBarLabel(data.bucketMinutes)),
    ...panel('MODELS', usageLines('model', modelEntries, layout.modelRoom, inner), size.width),
    ...(aliases.length === 0
      ? []
      : panel('ALIASES', usageLines('alias', aliasEntries, layout.aliasRoom, inner), size.width)),
    errorLine(totals, data.errors, size.width)
  ]
  return rows.slice(0, Math.max(0, size.height))
}

/** The console's Stats view. */
export interface StatsView {
  /**
   * Renders the view.
   *
   * @param window - the dashboard's window
   * @param size - the space available
   * @returns the rows
   */
  rows(window: StatsWindow, size: { readonly height: number; readonly width: number }): string[]
  /**
   * Reads today's cost for the status strip.
   *
   * @returns the cost in US dollars, or `undefined` when the view shows the totals instead (stats
   *   off, or the file can't be opened or read)
   */
  todayCostUsd(): number | undefined
  /**
   * Says what the frame's bottom border notes about the view.
   *
   * @returns how long the stats file keeps its history while the dashboard is shown; `''` when
   *   the view shows the totals instead
   */
  frameNote(): string
  /** Closes the stats file, if it is open. */
  close(): void
}

/** The store's methods the Stats view uses. */
type DashboardStore = Pick<StatsStore, 'timeline' | 'models' | 'aliases' | 'errors' | 'close'>

/**
 * Renders the totals since the proxy started (#70), under a line that says why the dashboard isn't
 * shown.
 *
 * @param note - why
 * @param size - the space available
 * @param size.height - rows
 * @param size.width - columns
 * @returns the rows
 */
function totalsRows(
  note: string,
  size: { readonly height: number; readonly width: number }
): string[] {
  return [
    paint('dim', note),
    ...statsRows(routeTotals(), routeTotalsSince(), { ...size, height: size.height - 1 })
  ]
}

/**
 * Builds the Stats view that shows the totals since the proxy started, with no cost for the
 * status strip.
 *
 * @param note - why the dashboard isn't shown
 * @returns the view
 */
function totalsView(note: string): StatsView {
  return {
    rows: (_window, size) => totalsRows(note, size),
    todayCostUsd: () => undefined,
    frameNote: () => '',
    close: () => undefined
  }
}

/** Reads the stats file, or, once a read has failed, falls back for good. */
type ReadGuard = <T>(read: () => T, fallback: () => T) => T

/**
 * Creates the Stats view's guard around reading the stats file: the first read that fails is
 * logged, and from then on every read, the dashboard's and the strip's alike, takes its fallback
 * without trying the file.
 *
 * @param path - the stats file, for the log
 * @returns the guard
 */
function createReadGuard(path: string): ReadGuard {
  let readFailed = false
  return (read, fallback) => {
    if (readFailed) return fallback()
    try {
      return read()
    } catch (error) {
      readFailed = true
      consoleLogger.warn('The Stats view shows totals only: could not read {path}: {reason}', {
        path,
        reason: errorMessage(error)
      })
      return fallback()
    }
  }
}

/**
 * Opens the Stats view: the dashboard over the stats file, read beside the recorder's own
 * connection (the file is in WAL mode, so reading doesn't wait for the recorder's writes), or the
 * totals since the proxy started when stats are off or the file can't be opened.
 *
 * @remarks
 * A read that fails once the file is open (a locked or damaged file) is logged once, and the view
 * shows the totals, and the status strip no cost, for the rest of the session: trying again on
 * every redraw could wait out the store's busy timeout each time, on the thread that serves
 * requests.
 *
 * @param statsEnabled - whether the proxy keeps stats (`--no-stats` turns them off)
 * @param open - opens the stats file at a path; the store's own `openStatsStore` but in tests
 * @returns the view
 */
export function openStatsView(
  statsEnabled: boolean,
  open: (path: string) => DashboardStore = openStatsStore
): StatsView {
  if (!statsEnabled) {
    const off = 'Stats are off (--no-stats): totals since the proxy started.'
    return totalsView(off)
  }
  const path = statsFilePath()
  let store: DashboardStore
  try {
    store = open(path)
  } catch (error) {
    consoleLogger.warn('The Stats view shows totals only: could not open {path}: {reason}', {
      path,
      reason: errorMessage(error)
    })
    const unopened =
      'The stats file could not be opened (see the log): totals since the proxy started.'
    return totalsView(unopened)
  }
  const read = createDashboardSource(store)
  const readTodayCost = createTodayCostSource(store)
  const unreadable =
    'The stats file could not be read (see the log; restart the console to retry): totals since the proxy started.'
  const guarded = createReadGuard(path)
  return {
    rows: (window, size) =>
      guarded(
        () => dashboardRows(read(window, chartColumns(size.width)), size),
        () => totalsRows(unreadable, size)
      ),
    todayCostUsd: () => guarded(readTodayCost, () => undefined),
    // Reads nothing: the guard gives the fallback once a read has failed and the view shows totals.
    frameNote: () =>
      guarded(
        () => KEPT_NOTE,
        () => ''
      ),
    close: () => store.close()
  }
}
