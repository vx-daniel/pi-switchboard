import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import type { Cooldown } from '@proxy/pi/cooldowns'
import type { ActiveRequest, FinishedRequest } from '@proxy/server/active-requests'
import type { RouteTotals } from '@proxy/server/route-totals'
import { compactDuration } from '@proxy/tui/panel'
import {
  besideSidebar,
  type SidebarAccount,
  type SidebarInput,
  sidebarRows,
  sidebarWidth
} from '@proxy/tui/sidebar'
import { describe, expect, test } from 'vite-plus/test'

/** The clock every snapshot is rendered at. */
const NOW = 1_800_000_000_000
/** A sidebar width the panels fit in with room. */
const WIDTH = 40
/** Tall enough for every panel with the blank rows between them. */
const TALL = 60

/**
 * Builds a snapshot: an idle proxy with nothing counted, overridden by the given fields.
 *
 * @param fields - the fields to set
 * @returns the snapshot
 */
function snapshot(fields: Partial<SidebarInput> = {}): SidebarInput {
  return {
    now: NOW,
    accounts: [],
    cooldowns: [],
    active: [],
    finished: [],
    totals: [],
    ...fields
  }
}

/**
 * Builds a request in flight, started `ageMs` before {@link NOW}.
 *
 * @param fields - the fields to set
 * @param ageMs - how long it has run
 * @returns the request
 */
function request(fields: Partial<ActiveRequest>, ageMs = 12_000): ActiveRequest {
  return {
    requestId: 'req-1',
    alias: null,
    model: 'alpha/model',
    attempt: 1,
    stream: true,
    firstEventAt: undefined,
    startedAt: NOW - ageMs,
    ...fields
  }
}

/**
 * Builds a finished request that ended `endedAgoMs` before {@link NOW}, after `tookMs`.
 *
 * @param fields - the fields to set
 * @param timing - how long ago it ended and how long it took
 * @param timing.endedAgoMs - how long before {@link NOW} it ended
 * @param timing.tookMs - how long it ran
 * @returns the request
 */
function done(
  fields: Partial<FinishedRequest>,
  timing: { endedAgoMs: number; tookMs: number } = { endedAgoMs: 1000, tookMs: 2300 }
): FinishedRequest {
  const endedAt = NOW - timing.endedAgoMs
  return {
    ...request({}),
    startedAt: endedAt - timing.tookMs,
    endedAt,
    outcome: 'ok',
    status: undefined,
    ...fields
  }
}

/**
 * Renders the sidebar as plain text.
 *
 * @param input - the snapshot
 * @param size - the space available
 * @param size.height - rows
 * @param size.width - columns
 * @returns the rows, without colour codes or trailing spaces
 */
function rendered(input: SidebarInput, size = { height: TALL, width: WIDTH }): string[] {
  return sidebarRows(input, size).map((row) => stripTerminalSequences(row).trimEnd())
}

/**
 * Returns the content lines of one panel.
 *
 * @param rows - the rendered rows
 * @param title - the start of the panel's title
 * @returns the lines between its borders, without the side borders
 */
function panelLines(rows: readonly string[], title: string): string[] {
  const start = rows.findIndex((row) => row.startsWith(`╭─ ${title}`))
  const end = rows.findIndex((row, index) => index > start && row.startsWith('╰'))
  return rows.slice(start + 1, end).map((row) => row.slice(2, -1).trimEnd())
}

/**
 * Returns the panels' titles, in order: the first word after each top border.
 *
 * @param rows - the rendered rows
 * @returns the titles
 */
function titles(rows: readonly string[]): string[] {
  return rows
    .filter((row) => row.startsWith('╭─ '))
    .map((row) => row.replace(/^╭─ /, '').replace(/ [─·\d].*$/, ''))
}

/**
 * Builds a login with a quota window per share used.
 *
 * @param provider - the provider
 * @param shares - each window's share used, from 0 to 1
 * @returns the login
 */
function login(provider: string, shares: readonly number[]): SidebarAccount {
  return {
    provider,
    type: 'oauth',
    label: undefined,
    models: 3,
    quota: {
      provider,
      observedAt: NOW,
      status: undefined,
      plan: undefined,
      windows: shares.map((used, index) => ({
        name: `w${String(index)}`,
        used,
        resetsAt: undefined,
        windowMinutes: undefined,
        status: undefined
      }))
    },
    belowReserve: false
  }
}

describe('the console sidebar', () => {
  // Catches a sidebar squeezing the log view on a narrow terminal, or growing without bound on a
  // wide one.
  test('shows only on a wide terminal, at a share of it within bounds', () => {
    expect(sidebarWidth(99)).toBeUndefined()
    expect(sidebarWidth(100)).toBe(34)
    expect(sidebarWidth(140)).toBe(42)
    expect(sidebarWidth(300)).toBe(48)
  })

  // Catches a row wider or narrower than the sidebar (a long model name, a wide character, a
  // colour code counted as width, a long label), which shifts the right border or wraps the screen.
  test('renders every row exactly as wide as the sidebar', () => {
    const rows = sidebarRows(
      snapshot({
        accounts: [
          {
            provider: 'a-provider-with-a-very-long-name-indeed',
            type: 'oauth',
            label: 'a label that is also far too long for the panel',
            models: 12,
            quota: {
              provider: 'a-provider-with-a-very-long-name-indeed',
              observedAt: NOW,
              status: undefined,
              plan: undefined,
              windows: [
                {
                  name: '5h',
                  used: 0.42,
                  resetsAt: NOW + 4_800_000,
                  windowMinutes: 300,
                  status: undefined
                }
              ]
            },
            belowReserve: false
          }
        ],
        active: [request({ model: 'provider/模型-with-a-name-far-too-long-for-the-panel' })],
        finished: [done({ model: 'provider/模型-with-a-name-far-too-long-for-the-panel' })]
      }),
      { height: TALL, width: WIDTH }
    )

    for (const row of rows) expect(visibleWidth(row)).toBe(WIDTH)
  })

  // Catches the panels running past the screen: on a short terminal the blank rows between panels
  // go first, then the bottom is cut.
  test('fits the height: drops the gaps between panels first, then cuts the bottom', () => {
    const full = rendered(snapshot())
    const gaps = full.filter((row) => row === '').length

    expect(gaps).toBe(3)
    expect(rendered(snapshot(), { height: full.length - 1, width: WIDTH })).toEqual(
      full.filter((row) => row !== '')
    )
    expect(rendered(snapshot(), { height: 5, width: WIDTH })).toHaveLength(5)
  })

  // Catches a short screen losing RECENT's last-minute line (what is happening now) to keep
  // SESSION (totals since start) or RECENT's own list of single requests.
  test('on a short screen drops SESSION, then RECENT’s list, before RECENT’s summary', () => {
    const finished = Array.from({ length: 5 }, (_, index) =>
      done({ requestId: `req-${String(index)}`, model: `alpha/model-${String(index)}` })
    )
    const input = snapshot({ finished })
    const tight = rendered(input).filter((row) => row !== '')
    const session = tight.findIndex((row) => row.startsWith('╭─ SESSION'))
    // Two list rows too few for everything but SESSION.
    const rows = rendered(input, { height: session - 2, width: WIDTH })

    expect(rows.some((row) => row.startsWith('╭─ SESSION'))).toBe(false)
    expect(panelLines(rows, 'RECENT').map((line) => line.replaceAll(/ {2,}/g, ' '))).toEqual([
      'last min 5 avg 2.3s',
      '✓ alpha/model-0 2.3s',
      '✓ alpha/model-1 2.3s',
      '✓ alpha/model-2 2.3s'
    ])
    expect(rows.at(-1)?.startsWith('╰')).toBe(true)
  })

  // Catches a healthy proxy losing its usual layout: QUOTA before IN FLIGHT, every quota window
  // shown, and a plain RECENT title.
  test('keeps the usual order and every quota window while the proxy is healthy', () => {
    const rows = rendered(
      snapshot({ accounts: [login('anthropic', [0.2, 0.4])], finished: [done({})] })
    )

    expect(titles(rows)).toEqual(['QUOTA', 'IN FLIGHT', 'RECENT', 'SESSION'])
    expect(panelLines(rows, 'QUOTA')).toHaveLength(3)
    expect(rows.some((row) => row.startsWith('╭─ RECENT ─'))).toBe(true)
  })

  // Catches a stress trigger that doesn't reorder: a login below its reserve with nothing failed,
  // or only rejected requests (a client with a wrong model or token), where the title must name
  // the rejections since nothing failed.
  test.each([
    {
      trigger: 'a login below its reserve',
      fields: { accounts: [{ ...login('low', [0.95]), belowReserve: true }] },
      title: 'RECENT'
    },
    {
      trigger: 'rejected requests only',
      fields: {
        finished: [
          done({ model: '', attempt: 0, outcome: 'rejected', status: 401 }),
          done({ model: '', attempt: 0, outcome: 'rejected', status: 401 })
        ]
      },
      title: 'RECENT · 2 rejected'
    }
  ])('under stress from $trigger, puts IN FLIGHT and RECENT first', ({ fields, title }) => {
    const rows = rendered(snapshot(fields))

    expect(titles(rows).slice(0, 2)).toEqual(['IN FLIGHT', 'RECENT'])
    expect(rows.some((row) => row.startsWith(`╭─ ${title} ─`))).toBe(true)
  })

  // Catches a screen too short even for IN FLIGHT and RECENT's summary overflowing instead of
  // being cut to its height.
  test('cuts to the height when even the kept panels do not fit', () => {
    const input = snapshot({ finished: [done({ outcome: 'failed' })] })

    for (const height of [0, 1, 4, 9]) {
      expect(rendered(input, { height, width: WIDTH })).toHaveLength(height)
    }
  })

  // Catches the stressed case burying what is happening now: on a short screen with many logins,
  // a cooldown and failures, IN FLIGHT and RECENT's summary must come before QUOTA and stay
  // visible, the failure count must show in RECENT's title, and quiet logins take one row.
  test('under stress puts IN FLIGHT and RECENT first and collapses quiet logins', () => {
    const cooldown: Cooldown = {
      scope: 'provider',
      provider: 'cooling',
      model: undefined,
      reason: 'rate_limit',
      since: NOW,
      until: NOW + 90_000,
      source: 'response',
      streak: 1
    }
    const accounts = [
      ...['one', 'two', 'three', 'four'].map((provider) => login(provider, [0.1, 0.2])),
      login('cooling', [0.3, 0.95])
    ]
    const input = snapshot({
      accounts,
      cooldowns: [cooldown],
      active: [request({ requestId: 'a' }), request({ requestId: 'b' })],
      finished: [
        done({ outcome: 'failed' }),
        done({ outcome: 'failed' }),
        ...Array.from({ length: 4 }, () => done({}))
      ]
    })
    const rows = rendered(input, { height: 30, width: WIDTH })

    expect(titles(rows).slice(0, 2)).toEqual(['IN FLIGHT', 'RECENT'])
    expect(panelLines(rows, 'IN FLIGHT')).toHaveLength(4)
    expect(rows.some((row) => row.startsWith('╭─ RECENT · 2 failed'))).toBe(true)
    expect(
      panelLines(rows, 'RECENT')
        .slice(0, 2)
        .map((line) => line.replaceAll(/ {2,}/g, ' '))
    ).toEqual(['last min 6 avg 2.3s', ' 2 failed'])
    // Rendered in full, the quiet logins take a row each; the cooling one keeps its detail.
    const full = panelLines(rendered(input), 'QUOTA')
    expect(full.filter((line) => /^● (one|two|three|four) /.test(line))).toHaveLength(4)
    expect(full).toHaveLength(4 + 1 + 2 + 1)
  })

  // Catches a quota shown under the wrong provider or without its reset, a provider below its
  // reserve not marked, a cooldown listed under a provider it does not belong to, a label lost,
  // or a login that reports no quota shown as if it had one.
  test('lists each login with its label, quota windows, reserve and cooldowns', () => {
    const lines = panelLines(
      rendered(
        snapshot({
          accounts: [
            {
              provider: 'anthropic',
              type: 'oauth',
              label: 'work-primary',
              models: 9,
              quota: {
                provider: 'anthropic',
                observedAt: NOW,
                status: 'allowed',
                plan: undefined,
                windows: [
                  {
                    name: '5h',
                    used: 0.5,
                    resetsAt: NOW + 4_800_000,
                    windowMinutes: 300,
                    status: undefined
                  },
                  {
                    name: '7d',
                    used: 0.95,
                    resetsAt: undefined,
                    windowMinutes: 10_080,
                    status: undefined
                  }
                ]
              },
              belowReserve: true
            },
            {
              provider: 'groq',
              type: 'api_key',
              label: undefined,
              models: 3,
              quota: undefined,
              belowReserve: false
            }
          ],
          cooldowns: [
            {
              scope: 'model',
              provider: 'groq',
              model: 'groq/llama',
              reason: 'unavailable',
              since: NOW,
              until: NOW + 65_000,
              source: 'backoff',
              streak: 1
            }
          ]
        })
      ),
      'QUOTA 2 logins'
    )

    expect(lines).toEqual([
      expect.stringMatching(/^● anthropic +work-primary$/),
      expect.stringMatching(/^ {2}5h +████░░░░ +50% ↻1h20m$/),
      expect.stringMatching(/^ {2}7d +████████ +95%$/),
      '  below reserve',
      expect.stringMatching(/^● groq +API key · 3$/),
      '  no quota reported',
      expect.stringMatching(/^ {2}⏸ llama +1m05s$/)
    ])
    // The bars start on the same column whether or not a window says when it resets.
    expect(lines[1]?.search(/[█░]/)).toBe(lines[2]?.search(/[█░]/))
  })

  // Catches the requests in flight shown without their route, mode, phase or retry, or a long
  // list pushing the session totals off the screen.
  test('lists requests in flight with their route and age, and sums up the rest', () => {
    const active = [
      request({ alias: 'coding', attempt: 2, firstEventAt: NOW - 60_000 }, 65_000),
      ...Array.from({ length: 7 }, (_, index) =>
        request({ requestId: `req-${String(index)}`, stream: false })
      )
    ]
    const lines = panelLines(rendered(snapshot({ active })), 'IN FLIGHT 8')

    expect(lines.slice(0, 2)).toEqual([
      expect.stringMatching(/^● alpha\/model +1m05s$/),
      '  coding · streaming · try 2'
    ])
    expect(lines.slice(2, 4)).toEqual([
      expect.stringMatching(/^● alpha\/model +12\.0s$/),
      '  direct · waiting'
    ])
    expect(lines).toHaveLength(13)
    expect(lines.at(-1)).toBe('+2 more')
  })

  // Catches the last minute's rate counting older requests or the in-flight ones, a client that
  // left counted as a failure, a stream's first-event time averaged over plain requests (which have
  // none), or the latest requests listed oldest first.
  test('sums up the last minute and lists the latest finished requests', () => {
    const finished = [
      done(
        { model: 'alpha/streamed', firstEventAt: NOW - 3000 },
        { endedAgoMs: 1000, tookMs: 2400 }
      ),
      done({ model: 'alpha/broken', outcome: 'failed' }, { endedAgoMs: 2000, tookMs: 850 }),
      done({ model: 'alpha/gone', outcome: 'left' }, { endedAgoMs: 3000, tookMs: 4000 }),
      done({ model: 'alpha/old', outcome: 'failed' }, { endedAgoMs: 61_000, tookMs: 90_000 })
    ]
    const lines = panelLines(rendered(snapshot({ finished })), 'RECENT')

    expect(lines.map((line) => line.replaceAll(/ {2,}/g, ' '))).toEqual([
      'last min 3 avg 2.4s 1st 400ms',
      ' 1 failed',
      '✓ alpha/streamed 2.4s',
      '✗ alpha/broken 850ms',
      '↩ alpha/gone 4.0s',
      '✗ alpha/old 1m30s'
    ])
  })

  // Catches a request the proxy turned away counted as a failure (it never reached a provider),
  // pulling the averages down with its instant answer, or listed without the status that says why.
  test('counts and lists rejected requests apart from failures', () => {
    const finished = [
      done(
        { model: 'no/such-model', attempt: 0, outcome: 'rejected', status: 404 },
        { endedAgoMs: 500, tookMs: 2 }
      ),
      done(
        { model: '', attempt: 0, outcome: 'rejected', status: 401 },
        { endedAgoMs: 600, tookMs: 1 }
      ),
      done({ model: 'alpha/model' }, { endedAgoMs: 1000, tookMs: 2000 })
    ]
    const lines = panelLines(rendered(snapshot({ finished })), 'RECENT')

    expect(lines.map((line) => line.replaceAll(/ {2,}/g, ' '))).toEqual([
      'last min 3 avg 2.0s',
      ' 2 rejected',
      '⊘ no/such-model 404',
      '⊘ - 401',
      '✓ alpha/model 2.0s'
    ])
  })

  // Catches an empty panel that reads as broken before the first request.
  test('says so when no request has finished, and when nothing is in flight', () => {
    const rows = rendered(snapshot())

    expect(panelLines(rows, 'RECENT')).toEqual(['none yet'])
    expect(panelLines(rows, 'IN FLIGHT 0')).toEqual(['nothing in flight'])
    expect(panelLines(rows, 'QUOTA 0 logins')).toEqual(['No logins · n to log in'])
  })

  // Catches a session panel that does not add up the routes.
  test('adds up the session over every route', () => {
    const route = (fields: Partial<RouteTotals>): RouteTotals => ({
      alias: null,
      provider: 'alpha',
      model: 'alpha/model',
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
    })
    const lines = panelLines(
      rendered(
        snapshot({
          totals: [
            route({ requests: 3, failures: 1, inputTokens: 1500, outputTokens: 400, costUsd: 0.5 }),
            route({
              alias: 'coding',
              requests: 2,
              fallbacks: 1,
              inputTokens: 1_250_000,
              cacheReadTokens: 900,
              costUsd: 0.25
            })
          ]
        })
      ),
      'SESSION'
    )

    expect(lines.map((line) => line.replaceAll(/ {2,}/g, ' '))).toEqual([
      'requests 5',
      'failed · fallbacks 1 · 1',
      'tokens in / out 1.3M / 400',
      'cache 900',
      'cost $0.7500'
    ])
  })

  // Catches a time shown in the wrong unit at a boundary, or a time already past shown negative.
  test.each([
    [-5000, '0s'],
    [59_999, '59s'],
    [60_000, '1m00s'],
    [3_599_000, '59m59s'],
    [3_600_000, '1h00m'],
    [86_400_000, '1d0h']
  ])('formats %d ms as %s', (ms, text) => {
    expect(compactDuration(ms)).toBe(text)
  })

  // Catches the sidebar starting at a different column on each row, because a view row with
  // colour codes or wide characters was padded by its length instead of its width.
  test('starts the sidebar at the same column on every row', () => {
    const rows = besideSidebar(
      ['\u001B[31mred\u001B[0m', '日本語', 'a row far too long for the view'],
      ['│x', '│y'],
      10
    )

    expect(rows.map((row) => stripTerminalSequences(row))).toEqual([
      'red        │x',
      '日本語     │y',
      'a row far  '
    ])
  })
})
