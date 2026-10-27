import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import type { RouteTotals } from '@proxy/server/route-totals'
import { statsRows } from '@proxy/tui/stats-view'
import { describe, expect, test } from 'vite-plus/test'

/** A wide terminal, where nothing is cut. */
const WIDE = { height: 20, width: 160 }

/**
 * Builds one route's totals, zero except for the given fields.
 *
 * @param fields - the route and any non-zero counts
 * @returns the totals
 */
function route(fields: Partial<RouteTotals> & Pick<RouteTotals, 'alias' | 'model'>): RouteTotals {
  return {
    provider: fields.model.split('/')[0] ?? '',
    requests: 0,
    failures: 0,
    failuresByClass: {},
    fallbacks: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    ...fields
  }
}

/**
 * Renders the Stats view as plain text.
 *
 * @param totals - the routes
 * @param size - the space available
 * @param size.height - rows
 * @param size.width - columns
 * @returns the rows, without colour codes or trailing spaces
 */
function rendered(totals: readonly RouteTotals[], size = WIDE): string[] {
  return statsRows(totals, 0, size).map((row) => stripTerminalSequences(row).trimEnd())
}

describe('the console Stats view', () => {
  // Catches an empty view that reads as broken instead of saying nothing was counted yet.
  test('says so when no request was counted', () => {
    expect(rendered([]).slice(1)).toEqual(['  No requests yet.'])
  })

  // Catches a route shown without its alias (the operator could not tell a chain's model from a
  // direct request), a total that does not add up, cache reads and writes swapped or summed, or a
  // hit rate that leaves the writes out of the prompt (15%, not 600 / 3,000 = 20%).
  test('labels each route and adds up the total', () => {
    const rows = rendered([
      route({ alias: null, model: 'mock/ok', requests: 1, inputTokens: 1200, costUsd: 0.0081 }),
      route({
        alias: 'coding',
        model: 'mock/ok',
        requests: 2,
        inputTokens: 2400,
        cacheReadTokens: 600,
        cacheWriteTokens: 1000,
        costUsd: 0.0162
      })
    ])

    expect(rows[2]).toMatch(/^ {2}mock\/ok +1 +0 +\$0\.0081 +0 +0% +1,200 +0 +0 +0$/)
    expect(rows[3]).toMatch(
      /^ {2}coding → mock\/ok +2 +0 +\$0\.0162 +0 +15% +2,400 +0 +600 +1,000$/
    )
    expect(rows[4]).toMatch(/^ {2}total +3 +0 +\$0\.0243 +0 +12% +3,600 +0 +600 +1,000$/)
  })

  // Catches failure classes that reorder between redraws as failures arrive.
  test('lists failure classes in name order', () => {
    const rows = rendered([
      route({
        alias: 'coding',
        model: 'mock/limited',
        requests: 3,
        failures: 3,
        failuresByClass: { timeout: 1, rate_limit: 2 }
      })
    ])

    expect(rows[2]).toMatch(/ {2}rate_limit 2, timeout 1$/)
  })

  // Catches a narrow terminal cutting off the cost: the route column narrows, cost comes before
  // the token counts, and a long route name is shortened rather than pushing the numbers out.
  test('keeps the cost visible at 80 columns', () => {
    const rows = rendered(
      [
        route({
          alias: 'a-very-long-alias-name',
          model: 'provider/a-very-long-model-id',
          costUsd: 1.5
        })
      ],
      { height: 20, width: 80 }
    )
    const row = rows[2] ?? ''

    expect(row.slice(0, 80)).toContain('$1.5000')
    // Shortened from the front: the served model is what tells an alias's rows apart.
    expect(row).toMatch(/^ {2}…\S*long-model-id /)
    expect(visibleWidth(rows[1]?.slice(0, 80) ?? '')).toBeLessThanOrEqual(80)
  })

  // Catches rows drawn past the screen's height, and the total cut first on a short screen
  // (second #196 review): the route rows give way, and the last one says how many are hidden.
  test('keeps the total on a short screen', () => {
    const many = Array.from({ length: 10 }, (_, index) =>
      route({ alias: null, model: `mock/model-${String(index)}`, requests: 1 })
    )

    const rows = rendered(many, { height: 6, width: 160 })

    expect(rows).toHaveLength(6)
    expect(rows.slice(2)).toEqual([
      expect.stringMatching(/^ {2}mock\/model-0 /),
      expect.stringMatching(/^ {2}mock\/model-1 /),
      '  … 8 more',
      expect.stringMatching(/^ {2}total +10 /)
    ])
  })

  // Catches columns misaligned by a label measured in UTF-16 units instead of terminal columns:
  // a wide character takes two columns (second #196 review).
  test('aligns the numbers after a label with wide characters', () => {
    const rows = rendered(
      [
        route({ alias: '中文别名中文别名中文别名', model: 'mock/ok', requests: 7 }),
        route({ alias: null, model: 'mock/ok', requests: 7 })
      ],
      { height: 20, width: 80 }
    )
    const countEnd = (row: string): number => visibleWidth(row.slice(0, row.indexOf('7') + 1))

    expect(rows[2]).toContain('…')
    expect(countEnd(rows[2] ?? '')).toBe(countEnd(rows[3] ?? ''))
  })
})
