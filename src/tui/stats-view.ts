/**
 * The console's Stats view (#61): #70's per-route totals as a table, one row per alias × served
 * model, with a total row, since the proxy started.
 *
 * @packageDocumentation
 */

import { styleText } from 'node:util'

import type { RouteTotals } from '@proxy/server/route-totals'

/** Widths of the Stats view's columns. */
const WIDTHS = { route: 44, count: 8, tokens: 11, cost: 10 } as const
/** Decimal places a cost is shown with: a request can cost a fraction of a cent. */
const COST_DECIMALS = 4

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
 * Formats a count with thousands separators, right-aligned.
 *
 * @param value - the count
 * @param width - the column's width
 * @returns the cell
 */
function countCell(value: number, width: number): string {
  return value.toLocaleString('en-US').padStart(width)
}

/**
 * Renders a row's numbers: requests, failures, fallbacks, input, output and cache tokens, cost.
 *
 * @param counts - the numbers
 * @returns the cells, joined
 */
function countCells(counts: Counts): string {
  return [
    countCell(counts.requests, WIDTHS.count),
    countCell(counts.failures, WIDTHS.count),
    countCell(counts.fallbacks, WIDTHS.count),
    countCell(counts.inputTokens, WIDTHS.tokens),
    countCell(counts.outputTokens, WIDTHS.tokens),
    countCell(counts.cacheReadTokens + counts.cacheWriteTokens, WIDTHS.tokens),
    `$${counts.costUsd.toFixed(COST_DECIMALS)}`.padStart(WIDTHS.cost)
  ].join(' ')
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
 * Lists a route's failures by class, for the end of its row.
 *
 * @param totals - the route's totals
 * @returns `''` with no classed failure, else the classes and counts
 */
function failureClasses(totals: RouteTotals): string {
  const classes = Object.entries(totals.failuresByClass).map(
    ([failure, count]) => `${failure} ${String(count)}`
  )
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
 * Renders the Stats view: a heading, one row per route, and the total.
 *
 * @param totals - #70's totals, in their stable order
 * @param since - when counting began, in epoch milliseconds
 * @param height - rows available
 * @returns the rows
 */
export function statsRows(totals: readonly RouteTotals[], since: number, height: number): string[] {
  const titles = ['requests', 'failed', 'fellback', 'input', 'output', 'cache', 'cost']
  const widths = [
    WIDTHS.count,
    WIDTHS.count,
    WIDTHS.count,
    WIDTHS.tokens,
    WIDTHS.tokens,
    WIDTHS.tokens,
    WIDTHS.cost
  ]
  const heading = `  ${'route'.padEnd(WIDTHS.route)} ${titles.map((title, column) => title.padStart(widths[column] ?? 0)).join(' ')}`
  const sinceLine = styleText(
    'dim',
    `  Since ${new Date(since).toLocaleString()}; counted in memory, reset on restart.`
  )
  if (totals.length === 0) return [sinceLine, '  No requests yet.'].slice(0, height)
  const rows = totals.map(
    (route) =>
      `  ${routeLabel(route).padEnd(WIDTHS.route)} ${countCells(route)}${failureClasses(route)}`
  )
  const total = styleText('bold', `  ${'total'.padEnd(WIDTHS.route)} ${countCells(sum(totals))}`)
  return [sinceLine, styleText('dim', heading), ...rows, total].slice(0, height)
}
