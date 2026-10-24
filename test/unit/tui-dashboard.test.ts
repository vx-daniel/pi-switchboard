import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import type { ErrorStats, ModelStats, StatsStore, TimelineBucket } from '@proxy/stats/store'
import {
  createDashboardSource,
  createTodayCostSource,
  type DashboardData,
  dashboardRows,
  openStatsView,
  windowRange
} from '@proxy/tui/dashboard'
import { activeTab, installConsoleTheme, paint } from '@proxy/tui/theme'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

/** Milliseconds in a minute. */
const MINUTE = 60_000
/** No errors in the window. */
const NO_ERRORS: ErrorStats = { failures: [], rejected: [] }

/**
 * Builds a served model's numbers, zero except for the given fields.
 *
 * @param fields - the model and any numbers
 * @returns the numbers
 */
function modelStats(fields: Partial<ModelStats> & Pick<ModelStats, 'model'>): ModelStats {
  return {
    requests: 0,
    failed: 0,
    left: 0,
    averageMs: undefined,
    slowestMs: 0,
    averageFirstEventMs: undefined,
    attempts: 0,
    fallbacks: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheTokens: 0,
    costUsd: 0,
    ...fields
  }
}

/**
 * Builds a timeline from each bucket's requests, none failed or rejected.
 *
 * @param requests - each bucket's requests, oldest first
 * @returns the buckets
 */
function timelineOf(requests: readonly number[]): TimelineBucket[] {
  return requests.map((requestCount, bucketIndex) => ({
    minute: bucketIndex,
    requests: requestCount,
    failed: 0,
    rejected: 0
  }))
}

/**
 * Builds a snapshot of today, from the given parts.
 *
 * @param parts - the timeline, models and errors, each empty when not given
 * @returns the snapshot
 */
function snapshot(parts: Partial<DashboardData>): DashboardData {
  return {
    window: 'today',
    range: { fromMinute: 0, toMinute: 60 },
    bucketMinutes: 1,
    timeline: [],
    models: [],
    aliases: [],
    errors: NO_ERRORS,
    ...parts
  }
}

/**
 * Renders a snapshot and strips the colors.
 *
 * @param data - the snapshot
 * @param size - the space available
 * @param size.height - rows
 * @param size.width - columns
 * @returns the plain rows
 */
function plainRows(data: DashboardData, size: { height: number; width: number }): string[] {
  return dashboardRows(data, size).map((row) => stripTerminalSequences(row))
}

/**
 * Reads the tiles off the plain rows: each row's cells between the rules, trimmed.
 *
 * @param rows - the plain rows
 * @returns the labels, the numbers and the captions, or `undefined` when no tile shows
 */
function tilesOf(rows: readonly string[]): string[][] | undefined {
  const labels = rows.findIndex((row) => row.includes('REQUESTS'))
  if (labels === -1) return undefined
  return rows.slice(labels, labels + 3).map((row) => row.split('│').map((cell) => cell.trim()))
}

/**
 * Counts the rows of timeline bars: the TIMELINE panel's rows besides its borders, its peak line
 * and its axis.
 *
 * @param rows - the plain rows
 * @returns the bar rows
 */
function chartHeight(rows: readonly string[]): number {
  const top = rows.findIndex((row) => row.startsWith('╭─ TIMELINE'))
  const bottom = rows.findIndex((row, rowIndex) => rowIndex > top && row.startsWith('╰'))
  return bottom - top - 3
}

describe('windowRange', () => {
  // Catches "today" counted as the last 24 hours, or from midnight UTC instead of local midnight.
  test('today starts at local midnight and ends after the current minute', () => {
    const now = new Date(2026, 4, 10, 15, 30, 20).getTime()
    const { range } = windowRange('today', now, 60)
    expect(range.fromMinute * MINUTE).toBe(new Date(2026, 4, 10).getTime())
    expect(range.toMinute).toBe(Math.floor(now / MINUTE) + 1)
  })

  // Catches buckets too small for the chart (bars past its edge) or needlessly coarse.
  test.each([
    ['today', 60],
    ['week', 100],
    ['all', 37]
  ] as const)('%s fits its timeline in %i columns', (window, columns) => {
    const { range, bucketMinutes } = windowRange(window, Date.UTC(2026, 4, 10, 12), columns)
    const span = range.toMinute - range.fromMinute
    expect(bucketMinutes * columns).toBeGreaterThanOrEqual(span)
    expect((bucketMinutes - 1) * columns).toBeLessThan(span)
  })

  // Catches the week and all windows mixed up, or the retention not matching the recorder's 30 days.
  test('week covers 7 days and all 30', () => {
    const now = Date.UTC(2026, 4, 10, 12)
    const span = (window: 'week' | 'all'): number => {
      const { range } = windowRange(window, now, 80)
      return range.toMinute - range.fromMinute
    }
    expect(span('week')).toBe(7 * 1440)
    expect(span('all')).toBe(30 * 1440)
  })
})

describe('createDashboardSource', () => {
  /**
   * Builds a store that counts its timeline queries and returns nothing.
   *
   * @returns the store and its query count
   */
  function countingStore(): {
    store: Pick<StatsStore, 'timeline' | 'models' | 'aliases' | 'errors'>
    reads: () => number
  } {
    let count = 0
    return {
      store: {
        timeline: () => {
          count += 1
          return []
        },
        models: () => [],
        aliases: () => [],
        errors: () => NO_ERRORS
      },
      reads: () => count
    }
  }

  // Catches the dashboard querying the file on every redraw (each request redraws the console),
  // or never reading it again.
  test('reuses a snapshot for 5 seconds, then reads again', () => {
    const { store, reads } = countingStore()
    let now = Date.UTC(2026, 4, 10, 12)
    const read = createDashboardSource(store, () => now)
    read('today', 50)
    now += 4999
    read('today', 50)
    expect(reads()).toBe(1)
    now += 1
    read('today', 50)
    expect(reads()).toBe(2)
  })

  // Catches a window or resize switch showing the old window's snapshot for up to 5 seconds.
  test('reads at once for another window or chart width', () => {
    const { store, reads } = countingStore()
    const read = createDashboardSource(store, () => Date.UTC(2026, 4, 10, 12))
    expect(read('today', 50).window).toBe('today')
    expect(read('week', 50).window).toBe('week')
    read('week', 60)
    expect(reads()).toBe(3)
  })
})

describe('createTodayCostSource', () => {
  // Catches the strip's cost read over the wrong minutes (not from local midnight), summed over
  // the wrong field, or read from the file on every redraw.
  test('sums the cost since local midnight, read again after 5 seconds', () => {
    let now = new Date(2026, 4, 10, 15, 30).getTime()
    const ranges: { fromMinute: number; toMinute: number }[] = []
    const read = createTodayCostSource(
      {
        models: (range) => {
          ranges.push(range)
          return [
            modelStats({ model: 'a/one', costUsd: 1.25 }),
            modelStats({ model: 'b/two', costUsd: 0.5 })
          ]
        }
      },
      () => now
    )

    expect(read()).toBe(1.75)
    now += 4999
    read()
    expect(ranges).toHaveLength(1)
    expect((ranges[0]?.fromMinute ?? 0) * MINUTE).toBe(new Date(2026, 4, 10).getTime())
    now += 1
    read()
    expect(ranges).toHaveLength(2)
  })
})

describe('dashboardRows', () => {
  // Catches the layout running past the screen (rows below the footer or past the sidebar), or a
  // row narrower than the view: the alt screen cuts a wide row without a word, so this is the only
  // check. 109 and 110 are each side of the six tiles.
  test.each([
    [12, 40],
    [24, 80],
    [30, 109],
    [30, 110],
    [45, 140],
    [45, 161]
  ])('fits %i rows by %i columns', (height, width) => {
    const data = snapshot({
      timeline: timelineOf(Array.from({ length: width }, (_, index) => index % 7)),
      models: Array.from({ length: 9 }, (_, index) =>
        modelStats({
          model: `provider/model-${String(index)}-with-a-long-name`,
          requests: 9 - index
        })
      ),
      // With the ALIASES panel too, so both tables have to share a short screen.
      aliases: Array.from({ length: 5 }, (_, aliasIndex) => ({
        ...modelStats({ model: '', requests: 5 - aliasIndex }),
        alias: `route-${String(aliasIndex)}`
      })),
      errors: { failures: [{ failureClass: 'rate_limit', count: 4 }], rejected: [] }
    })
    const rows = dashboardRows(data, { height, width })
    expect(rows.length).toBeLessThanOrEqual(height)
    for (const row of rows) expect(visibleWidth(row)).toBe(width)
  })

  // Catches the tiles summing the wrong fields, averaging per model instead of per request, or a
  // rate per hour taken over the wrong minutes.
  test('the tiles sum the models and weight the averages by requests', () => {
    const data = snapshot({
      models: [
        modelStats({
          model: 'a/one',
          requests: 8,
          failed: 2,
          averageMs: 1000,
          slowestMs: 4000,
          averageFirstEventMs: 500,
          inputTokens: 1500,
          outputTokens: 300,
          costUsd: 1.5
        }),
        modelStats({ model: 'b/two', requests: 2, averageMs: 2000, costUsd: 0.25 })
      ],
      errors: { failures: [], rejected: [{ status: 404, count: 3 }] }
    })

    expect(tilesOf(plainRows(data, { height: 40, width: 120 }))).toStrictEqual([
      ['REQUESTS', 'FAILED', 'AVG TIME', '1ST EVENT', 'TOKENS OUT', 'COST'],
      ['10', '2', '1.2s', '500ms', '300', '$1.75'],
      ['10.0 per hour', '3 rejected', 'slowest 4.0s', 'average wait', '1.5K in', '$0.175 each']
    ])
  })

  // Catches the six tiles kept on a view too narrow for them, or the wrong four kept.
  test('under 110 columns, four tiles: requests, failures, average time and cost', () => {
    const data = snapshot({ models: [modelStats({ model: 'a/one', requests: 4, costUsd: 2 })] })

    expect(tilesOf(plainRows(data, { height: 40, width: 109 }))?.[0]).toStrictEqual([
      'REQUESTS',
      'FAILED',
      'AVG TIME',
      'COST'
    ])
  })

  // Catches the tiles kept on a short screen at the timeline's cost (the mock's own bug: below 27
  // rows its tiles took the chart's rows), or dropped while there is room for them.
  test.each([
    ['without', 0, 17],
    ['with', 2, 21]
  ] as const)(
    '%s the ALIASES panel, the tiles go before the timeline drops under 3 rows',
    (_panel, aliasCount, height) => {
      const data = snapshot({
        timeline: timelineOf([1, 2, 3]),
        models: [modelStats({ model: 'a/one', requests: 6 })],
        aliases: Array.from({ length: aliasCount }, (_, aliasIndex) => ({
          ...modelStats({ model: '', requests: 3 }),
          alias: `route-${String(aliasIndex)}`
        }))
      })

      const fits = plainRows(data, { height, width: 80 })
      const short = plainRows(data, { height: height - 1, width: 80 })

      expect(tilesOf(fits)).toBeDefined()
      expect(chartHeight(fits)).toBe(3)
      expect(fits).toHaveLength(height)
      expect(fits.at(-1)).toContain('no failed or rejected requests')
      expect(tilesOf(short)).toBeUndefined()
      expect(chartHeight(short)).toBeGreaterThanOrEqual(3)
      expect(short.at(-1)).toContain('no failed or rejected requests')
    }
  )

  // Catches the bar size lost when it moved off the window line.
  test('the timeline names the minutes per bar in its border', () => {
    const rows = plainRows(snapshot({ bucketMinutes: 22 }), { height: 30, width: 80 })

    expect(rows.some((row) => row.startsWith('╭─ TIMELINE 22 min per bar ─'))).toBe(true)
  })

  // Catches a failed attempt that fell back (served in the end) hidden behind the check, or the
  // rejections by status lost from the line.
  test('the errors line counts the failed and rejected requests, then says what they were', () => {
    const fellBack = snapshot({
      errors: { failures: [{ failureClass: 'rate_limit', count: 4 }], rejected: [] }
    })
    const rejected = snapshot({
      models: [modelStats({ model: 'a/one', requests: 3, failed: 1 })],
      errors: {
        failures: [
          { failureClass: 'rate_limit', count: 2 },
          { failureClass: 'timeout', count: 1 }
        ],
        rejected: [{ status: 404, count: 3 }]
      }
    })
    const size = { height: 30, width: 120 }

    expect(plainRows(fellBack, size).at(-1)?.trimEnd()).toBe(
      ' ✗ 0 failed · 0 rejected — failed attempts rate_limit 4'
    )
    expect(plainRows(rejected, size).at(-1)?.trimEnd()).toBe(
      ' ✗ 1 failed · 3 rejected — failed attempts rate_limit 2, timeout 1 · rejected 404 ×3'
    )
  })

  // Catches bars scaled to the screen instead of the busiest bucket, a quiet bucket with a single
  // request drawn as nothing at all, or the newest bar left short of the `now` label.
  test('the busiest bucket fills the chart, any request shows, and the bars end at now', () => {
    const rows = plainRows(snapshot({ timeline: timelineOf([1000, 0, 1]) }), {
      height: 30,
      width: 60
    })
    const peak = rows.findIndex((row) => row.includes('peak 1K per bar'))
    const bottom = rows.findIndex((row, rowIndex) => rowIndex > peak && row.startsWith('╰'))
    // The bars sit between the peak line and the axis line, which is just above the bottom
    // border; the newest ends just before ` │`.
    const bars = rows.slice(peak + 1, bottom - 1).map((row) => row.slice(-5, -2))
    expect(bars.length).toBeGreaterThanOrEqual(3)
    expect(bars.slice(0, -1).every((bar) => bar === '█  ')).toBe(true)
    expect(bars.at(-1)).toBe('█ ▁')
  })

  // Catches a number column narrower than its widest value, which pushes the cost off the row.
  test('a model row keeps its cost whole at the widest token counts', () => {
    const data = snapshot({
      models: [
        modelStats({
          model: 'p/busy',
          requests: 999,
          inputTokens: 999_900,
          outputTokens: 999_900,
          costUsd: 1234.56
        })
      ]
    })
    const row = plainRows(data, { height: 40, width: 100 }).find((line) => line.includes('p/busy'))
    expect(row).toContain('999.9K/999.9K $1234.56 │')
  })

  describe('with colors on', () => {
    /** Where pi keeps its global theme, which installing the console theme replaces. */
    const piThemeKey = Symbol.for('@earendil-works/pi-coding-agent:theme')
    /** pi's global theme before a test, put back after it: other test files share the process. */
    const before: unknown = Reflect.get(globalThis, piThemeKey)

    afterEach(() => {
      vi.unstubAllEnvs()
      installConsoleTheme('1')
      Reflect.set(globalThis, piThemeKey, before)
    })

    // Catches the current window unmarked among the pills, or another one marked with it.
    test('the current window is the amber pill', () => {
      vi.stubEnv('NO_COLOR', '')
      installConsoleTheme()
      const [pills] = dashboardRows(snapshot({ window: 'week' }), { height: 30, width: 80 })

      expect(pills).toContain(activeTab(' w  week '))
      expect(pills).not.toContain(activeTab(' t  today '))
      expect(stripTerminalSequences(pills ?? '')).toContain('a  all 30 days')
    })

    // Catches one failure turning a whole bar red: at a normal failure rate nearly every busy bar
    // has one, and the chart would read as all failing.
    test('a failure marks the foot of its bar, not the whole bar', () => {
      vi.stubEnv('NO_COLOR', '')
      installConsoleTheme()
      const timeline = [{ minute: 0, requests: 100, failed: 1, rejected: 0 }]
      const rows = dashboardRows(snapshot({ timeline }), { height: 30, width: 60 })
      const plain = rows.map((row) => stripTerminalSequences(row))
      const peak = plain.findIndex((row) => row.includes('peak 100 per bar'))
      const bottom = plain.findIndex((row, rowIndex) => rowIndex > peak && row.startsWith('╰'))
      const bars = rows.slice(peak + 1, bottom - 1)
      expect(bars[0]).toContain(paint('accent', '█'))
      expect(bars.at(-1)).toContain(paint('error', '█'))
      expect(bars.filter((row) => row.includes(paint('error', '█')))).toHaveLength(1)
    })
  })

  // Catches a long model list pushing the ERRORS panel off the screen.
  test('more models than fit are summed up and the errors stay on screen', () => {
    const data = snapshot({
      models: Array.from({ length: 10 }, (_, index) =>
        modelStats({ model: `p/model-${String(index)}`, requests: 10 - index })
      ),
      errors: { failures: [{ failureClass: 'timeout', count: 1 }], rejected: [] }
    })
    const rows = plainRows(data, { height: 24, width: 100 })
    expect(rows).toHaveLength(24)
    expect(rows.some((row) => row.includes('more'))).toBe(true)
    expect(rows.at(-1)).toContain('failed attempts timeout 1')
  })

  // Catches the ALIASES panel hidden when routes were used (the per-alias cost is the point), or
  // shown for direct requests only, where it would repeat the totals.
  test('the ALIASES panel shows when a request named an alias, with direct requests labelled', () => {
    const coding = { ...modelStats({ model: '', requests: 3, fallbacks: 1 }), alias: 'coding' }
    const direct = { ...modelStats({ model: '', requests: 2 }), alias: '' }
    const size = { height: 40, width: 120 }

    const withAlias = plainRows(snapshot({ aliases: [coding, direct] }), size)
    const directOnly = plainRows(snapshot({ aliases: [direct] }), size)

    expect(withAlias.some((row) => row.includes('ALIASES'))).toBe(true)
    expect(withAlias.some((row) => /coding\s+3\s+0\s+1 /.test(row))).toBe(true)
    expect(withAlias.some((row) => /direct\s+2 /.test(row))).toBe(true)
    expect(directOnly.some((row) => row.includes('ALIASES'))).toBe(false)
  })

  // Catches an empty window rendering a blank table the operator can't tell from a broken one, or
  // a tile dividing by its zero requests.
  test('a window without requests says so, with no NaN in the tiles', () => {
    const rows = plainRows(snapshot({ range: { fromMinute: 60, toMinute: 60 } }), {
      height: 30,
      width: 120
    })
    const text = rows.join('\n')

    expect(text).toContain('No requests in this window.')
    expect(text).not.toMatch(/NaN|Infinity/)
    expect(tilesOf(rows)?.[1]).toStrictEqual(['0', '0', '-', '-', '0', '$0.00'])
    expect(rows.at(-1)).toContain('✓ no failed or rejected requests in this window')
  })
})

describe('openStatsView', () => {
  // Catches `--no-stats` leaving the Stats view empty, or showing totals without saying why.
  test('with stats off, it shows the totals since the proxy started and says why', () => {
    const view = openStatsView(false)
    const [note] = view.rows('today', { height: 10, width: 100 })
    view.close()
    expect(stripTerminalSequences(note ?? '')).toContain('Stats are off (--no-stats)')
    expect(view.todayCostUsd()).toBeUndefined()
    expect(view.frameNote()).toBe('')
  })

  // Catches a stats file that can't be opened (a newer proxy's schema, a read-only directory)
  // failing the console's start or leaving the view empty.
  test('a file that can not be opened shows the totals and says why', () => {
    const view = openStatsView(true, () => {
      throw new Error('The stats file is schema version 2, newer than this proxy’s')
    })
    const [note] = view.rows('today', { height: 10, width: 120 })
    view.close()
    expect(stripTerminalSequences(note ?? '')).toContain('The stats file could not be opened')
    expect(view.todayCostUsd()).toBeUndefined()
    expect(view.frameNote()).toBe('')
  })

  // Catches the strip's cost or the frame's note missing while the stats file reads fine.
  test('an open file gives the strip today’s cost and the frame its note', () => {
    const view = openStatsView(true, () => ({
      timeline: () => [],
      models: () => [modelStats({ model: 'a/one', costUsd: 0.42 })],
      aliases: () => [],
      errors: () => NO_ERRORS,
      close: () => undefined
    }))
    const cost = view.todayCostUsd()
    const note = view.frameNote()
    view.close()
    expect(cost).toBe(0.42)
    expect(note).toBe('stats kept 30 days')
  })

  // Catches the strip's cost read on every redraw after the file failed (each try can wait out
  // the busy timeout on the thread that serves requests), or the dashboard trying the file again
  // once the strip's read failed.
  test('a failed cost read gives no cost and stops the dashboard reading too', () => {
    let reads = 0
    const view = openStatsView(true, () => ({
      timeline: () => {
        reads += 1
        return []
      },
      models: () => {
        reads += 1
        throw new Error('database is locked')
      },
      aliases: () => [],
      errors: () => NO_ERRORS,
      close: () => undefined
    }))

    expect(view.todayCostUsd()).toBeUndefined()
    expect(view.todayCostUsd()).toBeUndefined()
    const [note] = view.rows('today', { height: 10, width: 100 })
    view.close()
    expect(stripTerminalSequences(note ?? '')).toContain('The stats file could not be read')
    expect(reads).toBe(1)
  })

  // Catches a read that fails after the file opened (a locked or damaged file) escaping the
  // console's render, or being tried again on every redraw.
  test('a failed read shows the totals and says why, without reading again', () => {
    let reads = 0
    const view = openStatsView(true, () => ({
      timeline: () => {
        reads += 1
        throw new Error('database disk image is malformed')
      },
      models: () => [],
      aliases: () => [],
      errors: () => NO_ERRORS,
      close: () => undefined
    }))
    const size = { height: 10, width: 100 }
    for (const window of ['today', 'week'] as const) {
      const [note] = view.rows(window, size)
      expect(stripTerminalSequences(note ?? '')).toContain('The stats file could not be read')
    }
    expect(view.todayCostUsd()).toBeUndefined()
    // The frame no longer says how long the file keeps its history: the view shows totals (#261
    // review).
    expect(view.frameNote()).toBe('')
    view.close()
    expect(reads).toBe(1)
  })
})
