/**
 * The console's Stats dashboard (#216): the stats file's history over a window (today, the last
 * week, or all 30 days kept), as an overview, a timeline of requests, a table per served model, and
 * what went wrong.
 *
 * @remarks
 * {@link dashboardRows} renders a {@link DashboardData} snapshot and reads nothing else;
 * {@link createDashboardSource} reads that snapshot from the stats store, at most every few seconds
 * for one window and chart width, so redraws on every request don't query the file each time.
 * {@link openStatsView} is what the console holds: the dashboard while the stats file is open, the
 * totals since the proxy started otherwise.
 *
 * @packageDocumentation
 */

import { proxyLogger } from '@proxy/logging'
import { routeTotals, routeTotalsSince } from '@proxy/server/route-totals'
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
import { MS_PER_MINUTE, STATS_WINDOWS, type StatsWindow, windowMinutes } from '@proxy/stats/windows'
import {
  compactCount,
  compactDuration,
  FRAME_COLUMNS,
  latency,
  panel,
  spread
} from '@proxy/tui/panel'
import { fitLabel, statsRows } from '@proxy/tui/stats-view'
import { type ConsoleColor, highlight, paint } from '@proxy/tui/theme'

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
/** Percent in a whole. */
const PERCENT = 100
/** Decimal places a cost is shown with. */
const COST_DECIMALS = 2
/** The dashboard's panels that always show; ALIASES shows when a request named an alias. */
const PANELS = ['OVERVIEW', 'TIMELINE', 'MODELS', 'ERRORS'] as const
/** Rows a panel's frame takes: its top and bottom borders. */
const BORDER_ROWS = 2
/** Rows the panels' frames take. */
const FRAME_ROWS = PANELS.length * BORDER_ROWS
/**
 * Rows that don't change with the screen, by where they are: the window line, the overview's
 * lines, the timeline's peak and axis lines, the models' heading and the errors' lines.
 */
const FIXED_LINES = { window: 1, overview: 2, timeline: 2, modelsHeading: 1, errors: 2 } as const
/** Rows the ALIASES panel takes besides its alias rows: its frame and its heading. */
const ALIAS_PANEL_ROWS = BORDER_ROWS + 1
/** The label column's narrowest width. */
const LABEL_LEAST = 12
/** Which of the usage table's number columns is the failures. */
const FAILED_COLUMN = 1
/** What the ALIASES panel calls requests that named a model directly. */
const DIRECT_LABEL = 'direct'

/** The usage table's number columns, for models and aliases alike. */
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
  {
    title: 'tok in/out',
    width: 13,
    cell: (usage) => `${compactCount(usage.inputTokens)}/${compactCount(usage.outputTokens)}`
  },
  { title: 'cost', width: 8, cell: (usage) => `$${usage.costUsd.toFixed(COST_DECIMALS)}` }
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
 * Formats a time that may be missing.
 *
 * @param ms - the time, or `undefined`
 * @returns the time, or `-`
 */
function optionalLatency(ms: number | undefined): string {
  return ms === undefined ? '-' : latency(ms)
}

/**
 * Renders the line that names the windows, the current one marked, and the timeline's bar size.
 *
 * @param data - the snapshot
 * @param width - the line's columns
 * @returns the line
 */
function windowLine(data: DashboardData, width: number): string {
  const labels = { today: ' today ', week: ' week ', all: ' all 30 days ' } as const
  const tabs = STATS_WINDOWS.map((window) =>
    window === data.window ? highlight(labels[window]) : labels[window]
  ).join(' ')
  const length =
    data.bucketMinutes < MINUTES_PER_HOUR
      ? `${String(data.bucketMinutes)} min`
      : compactDuration(data.bucketMinutes * MS_PER_MINUTE)
  const bar = `${length} per bar`
  return spread(` ${tabs}`, paint('dim', bar), width)
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

/**
 * Renders the OVERVIEW panel's two lines: the window's requests, failures and rejections, then its
 * average times, tokens and cost.
 *
 * @param data - the snapshot
 * @returns the lines
 */
function overviewLines(data: DashboardData): string[] {
  const dot = paint('dim', ' · ')
  const served = data.models.reduce((total, model) => total + model.requests, 0)
  const failed = data.models.reduce((total, model) => total + model.failed, 0)
  const rejected = data.errors.rejected.reduce((total, row) => total + row.count, 0)
  const share = served > 0 ? ` (${((failed / served) * PERCENT).toFixed(1)}%)` : ''
  const counts = [`${compactCount(served)} requests`]
  counts.push(failed > 0 ? paint('error', `${compactCount(failed)} failed${share}`) : '0 failed')
  if (rejected > 0) counts.push(paint('warning', `${compactCount(rejected)} rejected`))
  const tokensIn = data.models.reduce((total, model) => total + model.inputTokens, 0)
  const tokensOut = data.models.reduce((total, model) => total + model.outputTokens, 0)
  const cost = data.models.reduce((total, model) => total + model.costUsd, 0)
  const usage = [
    `avg ${weightedLatency(data.models, (model) => model.averageMs)}`,
    `1st event ${weightedLatency(data.models, (model) => model.averageFirstEventMs)}`,
    `tokens ${compactCount(tokensIn)} in / ${compactCount(tokensOut)} out`,
    `cost $${cost.toFixed(COST_DECIMALS)}`
  ]
  return [counts.join(dot), usage.join(dot)]
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
 * Renders the ERRORS panel's two lines: failed attempts by class, rejected requests by status.
 *
 * @param errors - the window's errors
 * @param width - the content's columns
 * @returns the lines
 */
function errorLines(errors: ErrorStats, width: number): string[] {
  const dot = paint('dim', ' · ')
  const failures = errors.failures.map((row) => `${row.failureClass} ${compactCount(row.count)}`)
  const rejected = errors.rejected.map((row) => `${String(row.status)} ×${compactCount(row.count)}`)
  const failedText =
    failures.length === 0 ? paint('dim', 'none') : paint('error', failures.join(dot))
  const rejectedText =
    rejected.length === 0 ? paint('dim', 'none') : paint('warning', rejected.join(dot))
  return [spread('failed', failedText, width), spread('rejected', rejectedText, width)]
}

/**
 * Renders the dashboard: the window line, then OVERVIEW, TIMELINE, MODELS, ALIASES (when a request
 * named an alias) and ERRORS. The timeline takes the room the tables don't need, between 3 and 16
 * rows of bars; on a short screen the tables give way first, then the bars, then the bottom is
 * cut.
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
  const aliasPanel = aliases.length === 0 ? 0 : ALIAS_PANEL_ROWS
  const fixed =
    FRAME_ROWS + aliasPanel + Object.values(FIXED_LINES).reduce((total, rows) => total + rows, 0)
  const modelsWanted = Math.min(Math.max(1, data.models.length), MODEL_ROWS_WANTED)
  const aliasesWanted = Math.min(aliases.length, ALIAS_ROWS_WANTED)
  const chart = Math.min(
    CHART_ROWS.most,
    Math.max(CHART_ROWS.least, size.height - fixed - modelsWanted - aliasesWanted)
  )
  const tableRoom = Math.max(1, size.height - fixed - chart)
  const aliasRoom = aliases.length === 0 ? 0 : Math.max(1, Math.min(aliasesWanted, tableRoom - 1))
  const modelRoom = Math.max(1, tableRoom - aliasRoom)
  const modelEntries = data.models.map((model) => ({ label: model.model, usage: model }))
  const aliasEntries = aliases.map((alias) => ({
    label: alias.alias === '' ? DIRECT_LABEL : alias.alias,
    usage: alias
  }))
  const rows = [
    windowLine(data, size.width),
    ...panel('OVERVIEW', overviewLines(data), size.width),
    ...panel('TIMELINE', timelineLines(data, chart, inner), size.width),
    ...panel('MODELS', usageLines('model', modelEntries, modelRoom, inner), size.width),
    ...(aliases.length === 0
      ? []
      : panel('ALIASES', usageLines('alias', aliasEntries, aliasRoom, inner), size.width)),
    ...panel('ERRORS', errorLines(data.errors, inner), size.width)
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
 * Opens the Stats view: the dashboard over the stats file, read beside the recorder's own
 * connection (the file is in WAL mode, so reading doesn't wait for the recorder's writes), or the
 * totals since the proxy started when stats are off or the file can't be opened.
 *
 * @remarks
 * A read that fails once the file is open (a locked or damaged file) is logged once, and the view
 * shows the totals for the rest of the session: trying again on every redraw could wait out the
 * store's busy timeout each time, on the thread that serves requests.
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
    return { rows: (_window, size) => totalsRows(off, size), close: () => undefined }
  }
  const path = statsFilePath()
  let store: DashboardStore
  try {
    store = open(path)
  } catch (error) {
    consoleLogger.warn('The Stats view shows totals only: could not open {path}: {reason}', {
      path,
      reason: error instanceof Error ? error.message : String(error)
    })
    const unopened =
      'The stats file could not be opened (see the log): totals since the proxy started.'
    return { rows: (_window, size) => totalsRows(unopened, size), close: () => undefined }
  }
  const read = createDashboardSource(store)
  const unreadable =
    'The stats file could not be read (see the log; restart the console to retry): totals since the proxy started.'
  let readFailed = false
  return {
    rows: (window, size) => {
      if (readFailed) return totalsRows(unreadable, size)
      try {
        return dashboardRows(read(window, chartColumns(size.width)), size)
      } catch (error) {
        readFailed = true
        consoleLogger.warn('The Stats view shows totals only: could not read {path}: {reason}', {
          path,
          reason: error instanceof Error ? error.message : String(error)
        })
        return totalsRows(unreadable, size)
      }
    },
    close: () => store.close()
  }
}
