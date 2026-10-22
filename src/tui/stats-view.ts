/**
 * The console's Stats view (#61): #70's per-route totals as a table, one row per alias × served
 * model, with a total row, since the proxy started.
 *
 * @packageDocumentation
 */

import { styleText } from 'node:util'

import { visibleWidth } from '@earendil-works/pi-tui'
import type { RouteTotals } from '@proxy/server/route-totals'

/** Widths of the Stats view's number columns. */
const WIDTHS = { count: 8, tokens: 11, cost: 10 } as const
/** The route column's width: as wide as fits, between these. */
const ROUTE_WIDTH = { least: 16, most: 44 } as const
/** Decimal places a cost is shown with: a request can cost a fraction of a cent. */
const COST_DECIMALS = 4
/** The indent before every row. */
const INDENT = '  '
/** Rows around the route rows: the start time, the heading and the total. */
const FRAME_ROWS = 3
/** Splits text into what a terminal draws as one character. */
const GRAPHEMES = new Intl.Segmenter('en-US', { granularity: 'grapheme' })

/** The numbers the table shows for one row, or for the total. */
type Counts = Pick<
  RouteTotals,
  | 'requests'
  | 'failures'
  | 'fallbacks'
  | 'inputTokens'
  | 'outputTokens'
  | 'cacheReadTokens'
  | 'cacheWriteTokens'
  | 'costUsd'
>

/**
 * The number columns, in order: the most telling first (requests, failures, cost), so a narrow
 * terminal cuts the token counts, not the cost.
 */
const COLUMNS: readonly {
  readonly title: string
  readonly width: number
  readonly cell: (counts: Counts) => string
}[] = [
  { title: 'requests', width: WIDTHS.count, cell: (counts) => count(counts.requests) },
  { title: 'failed', width: WIDTHS.count, cell: (counts) => count(counts.failures) },
  {
    title: 'cost',
    width: WIDTHS.cost,
    cell: (counts) => `$${counts.costUsd.toFixed(COST_DECIMALS)}`
  },
  { title: 'fellback', width: WIDTHS.count, cell: (counts) => count(counts.fallbacks) },
  { title: 'input', width: WIDTHS.tokens, cell: (counts) => count(counts.inputTokens) },
  { title: 'output', width: WIDTHS.tokens, cell: (counts) => count(counts.outputTokens) },
  {
    title: 'cache',
    width: WIDTHS.tokens,
    cell: (counts) => count(counts.cacheReadTokens + counts.cacheWriteTokens)
  }
]

/**
 * Formats a count with thousands separators.
 *
 * @param value - the count
 * @returns the count, as text
 */
function count(value: number): string {
  return value.toLocaleString('en-US')
}

/**
 * Renders a row's number cells, each right-aligned in its column.
 *
 * @param counts - the numbers
 * @returns the cells, joined
 */
function countCells(counts: Counts): string {
  return COLUMNS.map((column) => column.cell(counts).padStart(column.width)).join(' ')
}

/**
 * Names a route: the alias and the model it reached, or the model alone.
 *
 * @param totals - the route's totals
 * @returns the label
 */
function routeLabel(totals: RouteTotals): string {
  return totals.alias === null ? totals.model : `${totals.alias} → ${totals.model}`
}

/**
 * Lists a route's failures by class, in name order so the list does not reorder between redraws.
 *
 * @param totals - the route's totals
 * @returns `''` with no classed failure, else the classes and counts
 */
function failureClasses(totals: RouteTotals): string {
  const classes = Object.entries(totals.failuresByClass)
    .toSorted(([first], [second]) => first.localeCompare(second))
    .map(([failure, failures]) => `${failure} ${String(failures)}`)
  return classes.length === 0 ? '' : styleText('dim', `  ${classes.join(', ')}`)
}

/**
 * Adds every route's numbers.
 *
 * @param totals - every route
 * @returns the sums
 */
function sum(totals: readonly RouteTotals[]): Counts {
  const zero: Counts = {
    requests: 0,
    failures: 0,
    fallbacks: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0
  }
  return totals.reduce<Counts>(
    (sums, route) => ({
      requests: sums.requests + route.requests,
      failures: sums.failures + route.failures,
      fallbacks: sums.fallbacks + route.fallbacks,
      inputTokens: sums.inputTokens + route.inputTokens,
      outputTokens: sums.outputTokens + route.outputTokens,
      cacheReadTokens: sums.cacheReadTokens + route.cacheReadTokens,
      cacheWriteTokens: sums.cacheWriteTokens + route.cacheWriteTokens,
      costUsd: sums.costUsd + route.costUsd
    }),
    zero
  )
}

/**
 * Picks the route column's width: what the terminal leaves after the number columns, within
 * {@link ROUTE_WIDTH}.
 *
 * @param width - the terminal's width
 * @returns the route column's width
 */
function routeWidth(width: number): number {
  const numbers = COLUMNS.reduce((total, column) => total + column.width + 1, INDENT.length)
  return Math.min(ROUTE_WIDTH.most, Math.max(ROUTE_WIDTH.least, width - numbers))
}

/**
 * Fits a label to the route column by display width, so a wide or combining character does not
 * misalign the numbers: too long, it keeps its end (the served model, which tells an alias's rows
 * apart) behind a `…`.
 *
 * @param text - the label
 * @param width - the column's width
 * @returns the label, exactly `width` columns wide
 */
function fitLabel(text: string, width: number): string {
  let kept = text
  if (visibleWidth(kept) > width) {
    const graphemes = Array.from(GRAPHEMES.segment(text), (part) => part.segment)
    while (graphemes.length > 0 && visibleWidth(`…${graphemes.join('')}`) > width) {
      graphemes.shift()
    }
    kept = `…${graphemes.join('')}`
  }
  return kept + ' '.repeat(Math.max(0, width - visibleWidth(kept)))
}

/**
 * Fits the route rows to the room left: when they do not fit, the last one says how many more
 * there are.
 *
 * @param rows - one row per route
 * @param room - the rows available for them
 * @returns the rows to show
 */
function fitRows(rows: readonly string[], room: number): readonly string[] {
  if (rows.length <= room) return rows
  if (room <= 0) return []
  const hidden = rows.length - room + 1
  return [...rows.slice(0, room - 1), styleText('dim', `${INDENT}… ${String(hidden)} more`)]
}

/**
 * Renders the Stats view: when counting began, a heading, one row per route, and the total.
 *
 * @param totals - #70's totals, in their stable order
 * @param since - when counting began, in epoch milliseconds
 * @param size - the space available
 * @param size.height - rows; on a short screen the route rows give way, not the total
 * @param size.width - columns; the route column narrows to fit ({@link fitLabel}), and rows are
 *   cut at the edge
 * @returns the rows
 */
export function statsRows(
  totals: readonly RouteTotals[],
  since: number,
  size: { readonly height: number; readonly width: number }
): string[] {
  const started = new Date(since).toLocaleString('en-US', { hour12: false })
  const sinceLine = styleText(
    'dim',
    `${INDENT}Since ${started}; counted in memory, reset on restart.`
  )
  if (totals.length === 0) return [sinceLine, `${INDENT}No requests yet.`].slice(0, size.height)
  const labelWidth = routeWidth(size.width)
  const titles = COLUMNS.map((column) => column.title.padStart(column.width)).join(' ')
  const heading = styleText('dim', `${INDENT}${fitLabel('route', labelWidth)} ${titles}`)
  const rows = totals.map(
    (route) =>
      `${INDENT}${fitLabel(routeLabel(route), labelWidth)} ${countCells(route)}${failureClasses(route)}`
  )
  const total = styleText(
    'bold',
    `${INDENT}${fitLabel('total', labelWidth)} ${countCells(sum(totals))}`
  )
  const room = size.height - FRAME_ROWS
  return [sinceLine, heading, ...fitRows(rows, room), total].slice(0, size.height)
}
