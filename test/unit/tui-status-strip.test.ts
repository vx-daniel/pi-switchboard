/**
 * The console's status strip (`src/tui/status-strip.ts`): what it shows, what it drops first
 * when the terminal is narrow, and how the per-minute counts behind its sparkline are made.
 */

import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { FINISHED_KEPT, type FinishedRequest } from '@proxy/server/active-requests'
import {
  requestsPerMinute,
  SPARKLINE_MINUTES,
  statusStrip,
  type StatusStripInput
} from '@proxy/tui/status-strip'
import { describe, expect, test } from 'vite-plus/test'

/** The clock every snapshot is rendered at: on a minute boundary plus a little. */
const NOW = 1_800_000_000_000 + 5000
const MS_PER_MINUTE = 60_000

/**
 * Builds a snapshot: a quiet proxy, overridden by the given fields.
 *
 * @param fields - the fields to set
 * @returns the snapshot
 */
function snapshot(fields: Partial<StatusStripInput> = {}): StatusStripInput {
  return {
    version: '0.3.0',
    address: '127.0.0.1:4141',
    proxyAuth: 'off',
    exposed: 24,
    available: 58,
    uptimeMs: 1_834_000,
    connections: 1,
    cooldowns: 0,
    modelsJsonError: false,
    perMinute: Array.from({ length: SPARKLINE_MINUTES }, () => 0),
    saturated: false,
    todayCostUsd: undefined,
    ...fields
  }
}

/**
 * Renders the strip as plain text.
 *
 * @param input - the snapshot
 * @param width - the terminal's columns
 * @returns the row without colour codes
 */
function plain(input: StatusStripInput, width: number): string {
  return stripTerminalSequences(statusStrip(input, width))
}

/**
 * Builds a finished request that ended at `time`.
 *
 * @param time - when it ended
 * @returns the request
 */
function finishedAt(time: number): FinishedRequest {
  return {
    requestId: 'r',
    alias: null,
    model: 'alpha/model',
    attempt: 1,
    stream: false,
    firstEventAt: undefined,
    startedAt: time - 1000,
    endedAt: time,
    outcome: 'ok',
    status: undefined
  }
}

describe('statusStrip', () => {
  // Catches a row wider or narrower than the terminal at any size, which shifts everything below
  // it or wraps the screen.
  test.each([60, 80, 100, 120, 160])('is exactly as wide as a %d-column terminal', (width) => {
    expect(visibleWidth(statusStrip(snapshot(), width))).toBe(width)
    expect(visibleWidth(statusStrip(snapshot({ modelsJsonError: true }), width))).toBe(width)
    expect(visibleWidth(statusStrip(snapshot({ todayCostUsd: 1234.567 }), width))).toBe(width)
  })

  // Catches the strip losing its order of the details, or a wide terminal not showing them all.
  test('shows everything on a wide terminal, the traffic on the right', () => {
    const row = plain(snapshot({ perMinute: [...Array.from({ length: 29 }, () => 0), 3] }), 200)

    expect(row.replaceAll(/ {2,}/g, ' ')).toBe(
      ' ◆ pi-switchboard 0.3.0 ● SERVING 127.0.0.1:4141 · auth off · 24/58 models exposed · up 30m34s · 1 conn · 0 cooldowns last 30 min ▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁█ · 0.6 req/min '
    )
  })

  // Catches a narrow terminal dropping the address or the auth (what the proxy is and whether it
  // is open) before the counts, the counts going in the wrong order (the cooldowns after the
  // connections after the uptime), or the sparkline kept over the rate.
  test.each([60, 80, 100, 120, 160])(
    'at %d columns keeps the address and the auth, and drops from the ends',
    (width) => {
      const row = plain(snapshot(), width)

      // `later` is shown only while `earlier` is: the details drop from the end.
      const keptInOrder = (later: string, earlier: string): boolean =>
        !row.includes(later) || row.includes(earlier)

      expect(row).toContain('127.0.0.1:4141 · auth off')
      expect(keptInOrder('cooldowns', ' conn')).toBe(true)
      expect(keptInOrder(' conn', 'up 30m34s')).toBe(true)
      expect(keptInOrder('up 30m34s', 'models exposed')).toBe(true)
      expect(keptInOrder('last 30 min', 'req/min')).toBe(true)
    }
  )

  // Catches the traffic shown while a count was dropped for it: the left details go first, down
  // to the address and the auth, then the right group from its start.
  test('drops the counts before the traffic, and the sparkline before the rate', () => {
    expect(plain(snapshot(), 100)).toMatch(/auth off +0\.0 req\/min $/)
    expect(plain(snapshot(), 60)).not.toContain('req/min')
  })

  // Catches today's cost missing while the stats are read, shown when they aren't (a `$0.00` that
  // isn't true), or dropped before the sparkline and the rate: it is the right group's headline.
  test('shows today’s cost last on the right, only while the stats are read, and drops it last', () => {
    const withCost = snapshot({ todayCostUsd: 1.234 })

    expect(plain(withCost, 200)).toMatch(/ · 0\.0 req\/min · \$1\.23 today $/)
    expect(plain(snapshot(), 200)).not.toContain('today')
    expect(plain(withCost, 100)).toMatch(/auth off +0\.0 req\/min · \$1\.23 today $/)
    expect(plain(withCost, 80)).toMatch(/auth off +\$1\.23 today $/)
  })

  // Catches an error dropped for a count or for the version on a narrow terminal: it is what the
  // operator must see.
  test('never drops an exposure or models.json error', () => {
    const one = plain(snapshot({ modelsJsonError: true }), 80)
    expect(one).toContain('auth off · models.json error')
    expect(one).not.toContain('0.3.0')
    expect(one).not.toContain('models exposed')

    const both = plain(snapshot({ exposed: 'bad config', modelsJsonError: true }), 110)
    expect(both).toContain('auth off · exposure config error · models.json error')
  })

  // Catches the rate counting the whole half hour instead of the last five minutes, or hiding
  // that the kept requests may miss some.
  test('rates the last five minutes, marked when the kept requests may miss some', () => {
    const perMinute = Array.from({ length: SPARKLINE_MINUTES }, (_, index) =>
      index >= SPARKLINE_MINUTES - 5 ? 2 : 100
    )

    expect(plain(snapshot({ perMinute }), 160)).toContain(' 2.0 req/min')
    expect(plain(snapshot({ perMinute, saturated: true }), 160)).toContain(' 2.0+ req/min')
  })
})

describe('requestsPerMinute', () => {
  // Catches a request counted in the wrong minute, one older than the window counted, or the
  // current minute left out.
  test('counts each finished request in its minute, oldest first', () => {
    const finished = [
      finishedAt(NOW),
      finishedAt(NOW - 1000),
      finishedAt(NOW - MS_PER_MINUTE),
      finishedAt(NOW - (SPARKLINE_MINUTES - 1) * MS_PER_MINUTE),
      finishedAt(NOW - SPARKLINE_MINUTES * MS_PER_MINUTE)
    ]
    const { perMinute, saturated } = requestsPerMinute(finished, NOW)

    expect(perMinute).toHaveLength(SPARKLINE_MINUTES)
    expect(perMinute.at(-1)).toBe(2)
    expect(perMinute.at(-2)).toBe(1)
    expect(perMinute[0]).toBe(1)
    expect(perMinute.reduce((requests, minuteCount) => requests + minuteCount, 0)).toBe(4)
    expect(saturated).toBe(false)
  })

  // Catches a full list of kept requests read as a complete half hour.
  test('says when the kept requests may miss some', () => {
    const finished = Array.from({ length: FINISHED_KEPT }, () => finishedAt(NOW))

    expect(requestsPerMinute(finished, NOW).saturated).toBe(true)
  })
})
