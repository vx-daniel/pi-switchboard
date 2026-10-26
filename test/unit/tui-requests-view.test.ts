/**
 * The console's Requests table (`src/tui/requests-view.ts`): its columns at each width, the chat
 * requests joined to their rows, and scrolling that stays put while requests arrive.
 */

import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import type { ActiveRequest, FinishedRequest } from '@proxy/server/active-requests'
import type { ConsoleEvent } from '@proxy/server/console-events'
import type { HttpRequest } from '@proxy/server/http-requests'
import { gauge } from '@proxy/tui/panel'
import {
  type ChatRequest,
  chatsById,
  type RequestsData,
  requestsRows,
  type RequestsViewport,
  scrollRequestsView,
  tableEntries
} from '@proxy/tui/requests-view'
import { installConsoleTheme } from '@proxy/tui/theme'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

/** When the requests below arrive, in milliseconds since the epoch. */
const START = new Date(2026, 9, 24, 18, 54, 49).getTime()

/**
 * Builds an answered HTTP request.
 *
 * @param sequence - its place in the order; its ID starts with it
 * @param fields - anything to change
 * @returns the request
 */
function http(sequence: number, fields: Partial<HttpRequest> = {}): HttpRequest {
  return {
    sequence,
    // The ID column shows the first six characters after `piproxy-`: here, the place in the order.
    requestId: `piproxy-${String(sequence).padStart(6, '0')}${'a'.repeat(18)}`,
    method: 'GET',
    path: '/v1/models',
    startedAt: START,
    status: 200,
    endedAt: START + 3,
    ...fields
  }
}

/**
 * Builds a chat request in flight for an HTTP request.
 *
 * @param request - the HTTP request
 * @param fields - anything to change
 * @returns the chat request
 */
function chatFor(request: HttpRequest, fields: Partial<ActiveRequest> = {}): ActiveRequest {
  return {
    requestId: request.requestId,
    alias: null,
    model: 'alpha/model-one',
    attempt: 1,
    stream: true,
    startedAt: request.startedAt,
    firstEventAt: undefined,
    ...fields
  }
}

/**
 * Finishes a chat request.
 *
 * @param chat - the chat request
 * @param fields - how and when it ended
 * @returns the finished request
 */
function finishedChat(
  chat: ActiveRequest,
  fields: Partial<FinishedRequest> & Pick<FinishedRequest, 'endedAt'>
): FinishedRequest {
  return { ...chat, outcome: 'ok', status: undefined, ...fields }
}

/**
 * Builds a lifecycle event.
 *
 * @param sequence - its place in the order shared with the requests
 * @param text - what happened
 * @param level - how much it matters
 * @returns the event
 */
function event(
  sequence: number,
  text: string,
  level: ConsoleEvent['level'] = 'info'
): ConsoleEvent {
  return { kind: 'event', sequence, at: START, level, text }
}

/**
 * Renders the table as plain text.
 *
 * @param requests - the HTTP requests, oldest first
 * @param chats - their chat requests
 * @param size - the space available
 * @param size.height - rows
 * @param size.width - columns
 * @param options - where the view is, and the lifecycle events among the requests (none by default)
 * @param options.view - where the view is
 * @param options.events - the lifecycle events
 * @returns the rows, without colour codes or trailing spaces
 */
function plainRows(
  requests: readonly HttpRequest[],
  chats: readonly ChatRequest[],
  size: { height: number; width: number },
  options: { view?: RequestsViewport; events?: readonly ConsoleEvent[] } = {}
): string[] {
  const data: RequestsData = {
    requests,
    events: options.events ?? [],
    chats: new Map(chats.map((chat) => [chat.requestId, chat])),
    now: START + 2500
  }
  return requestsRows(options.view, data, size).map((row) => stripTerminalSequences(row).trimEnd())
}

describe('requestsRows', () => {
  /** A request of each kind: a model list, a refused one, a stream relaying, one in flight. */
  const mixed = (): { requests: HttpRequest[]; chats: ChatRequest[] } => {
    const streaming = http(2, { method: 'POST', path: '/v1/chat/completions', endedAt: START + 40 })
    const waiting = http(3, {
      method: 'POST',
      path: '/v1/chat/completions',
      status: undefined,
      endedAt: undefined
    })
    return {
      requests: [http(0), http(1, { status: 401 }), streaming, waiting],
      chats: [chatFor(streaming, { alias: 'coding', firstEventAt: START + 900 }), chatFor(waiting)]
    }
  }

  // Catches a row wider or narrower than the view at any width, which the alt screen cuts
  // without a word: the columns drop at 84, 104 and 120.
  test.each([40, 64, 83, 84, 103, 104, 119, 120, 160])(
    'every row is exactly %i columns',
    (width) => {
      const { requests, chats } = mixed()
      const data = {
        requests,
        events: [event(10, 'Listening on http://127.0.0.1:4141 with 58 models', 'warning')],
        chats: new Map(chats.map((chat) => [chat.requestId, chat])),
        now: START
      }
      for (const row of requestsRows(undefined, data, { height: 10, width })) {
        expect(visibleWidth(row)).toBe(width)
      }
    }
  )

  // Catches the right-hand columns kept on a view too narrow for them, or dropped in the wrong
  // order: the ID first, then the first event, then the duration.
  test.each([
    [83, []],
    [84, ['duration']],
    [104, ['duration', '1st event']],
    [120, ['duration', '1st event', 'id']]
  ] as const)('at %i columns the heading shows %j on the right', (width, shown) => {
    const [heading = ''] = plainRows([http(0)], [], { height: 5, width })

    for (const column of ['duration', '1st event', 'id']) {
      expect(new RegExp(`\\b${column}\\b`, 'u').test(heading)).toBe(shown.includes(column as never))
    }
  })

  // Catches a stream's row showing its headers' time as its duration, the alias or the model that
  // served it missing, or a request that is not a chat claiming a model.
  test('a chat request shows what it named, what served it, and its stream’s whole duration', () => {
    const request = http(0, { method: 'POST', path: '/v1/chat/completions', endedAt: START + 40 })
    const chat = finishedChat(
      chatFor(request, { alias: 'coding', model: 'alpha/model-one', firstEventAt: START + 900 }),
      { endedAt: START + 5000 }
    )

    const [, row = '', models = ''] = plainRows([request, http(1)], [chat], {
      height: 5,
      width: 160
    })

    expect(row).toMatch(
      /^18:54:49 {3}200 {4}POST {4}\/v1\/chat\/completions +coding {2}→ {2}alpha\/model-one +[▏▎▍▌▋▊▉█]+░* +5\.0s {2}1st 900ms {2}#000000$/u
    )
    expect(models).toMatch(/\/v1\/models +— /u)
  })

  // Catches a request in flight shown as answered, or a stream still relaying shown as done
  // because its headers went out.
  test('a request in flight says whether it waits or streams, and for how long', () => {
    const { requests, chats } = mixed()

    const rows = plainRows(requests, chats, { height: 6, width: 120 })

    expect(rows[3]).toMatch(/ 200 .*coding .*streaming… +2\.5s {2}1st 900ms/u)
    expect(rows[4]).toMatch(/ {2}[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] {2}.*alpha\/model-one +waiting… +2\.5s {2}1st —/u)
  })

  // Catches the in-flight mark frozen: it moves on with the console's one-second redraw.
  test('a request in flight shows a spinner that moves on each second', () => {
    const waiting = http(0, { status: undefined, endedAt: undefined })
    const at = (now: number): string =>
      stripTerminalSequences(
        requestsRows(
          undefined,
          { requests: [waiting], events: [], chats: new Map(), now },
          { height: 3, width: 80 }
        )[1] ?? ''
      )

    expect(at(START)).not.toBe(at(START + 1000))
    expect(at(START)).toBe(at(START + 999 - (START % 1000)))
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

    // Catches a stream that failed after its 200 went out drawn as a success: its status can't
    // say so, so the gauge must.
    test('a chat request that failed draws its gauge red, a slow one yellow', () => {
      vi.stubEnv('NO_COLOR', '')
      installConsoleTheme()
      const failedRequest = http(0, { method: 'POST', endedAt: START + 40 })
      const slowRequest = http(1, { method: 'POST', endedAt: START + 40 })
      const chats = new Map<string, ChatRequest>([
        [
          failedRequest.requestId,
          finishedChat(chatFor(failedRequest), { endedAt: START + 1000, outcome: 'failed' })
        ],
        [slowRequest.requestId, finishedChat(chatFor(slowRequest), { endedAt: START + 5000 })]
      ])
      const [, failed = '', slow = ''] = requestsRows(
        undefined,
        { requests: [failedRequest, slowRequest], events: [], chats, now: START },
        { height: 5, width: 120 }
      )

      // 1 s and 5 s of the gauge's 6 s, ten cells wide.
      expect(failed).toContain(gauge(1000 / 6000, 10, 'error'))
      expect(slow).toContain(gauge(5000 / 6000, 10, 'warning'))
    })
  })

  // Catches an empty table that looks broken.
  test('says so before the first request', () => {
    expect(plainRows([], [], { height: 5, width: 80 })[1]).toBe('No requests yet.')
  })

  // Catches lifecycle events lost, out of order with the requests, drawn like a request, or
  // without the time they happened (#266).
  test('shows lifecycle events among the requests, in their order, as divider rows', () => {
    const rows = plainRows(
      [http(1), http(3)],
      [],
      { height: 6, width: 80 },
      {
        events: [
          event(0, 'Listening on http://127.0.0.1:4141 with 58 models'),
          event(2, 'Stats are off: could not open /tmp/stats.sqlite', 'warning')
        ]
      }
    )

    expect(rows[1]).toMatch(
      /^18:54:49 {2}◇ Listening on http:\/\/127\.0\.0\.1:4141 with 58 models ┄+$/u
    )
    expect(rows[2]).toMatch(/^18:54:49 +200 +GET +\/v1\/models/u)
    expect(rows[3]).toMatch(
      /^18:54:49 {2}◆ Stats are off: could not open \/tmp\/stats\.sqlite ┄+$/u
    )
    expect(rows[4]).toMatch(/ 200 /u)
  })

  // Catches the events hidden until the first request, when they say what the proxy is doing.
  test('shows the events before the first request, then says no request came yet', () => {
    const rows = plainRows(
      [],
      [],
      { height: 5, width: 80 },
      {
        events: [event(0, 'Listening on http://127.0.0.1:4141 with 58 models')]
      }
    )

    expect(rows[1]).toContain('◇ Listening on')
    expect(rows[2]).toBe('No requests yet.')
  })
})

describe('scrolling the Requests table', () => {
  const requests = Array.from({ length: 10 }, (_, position) => http(position))
  const shownIds = (rows: readonly string[]): string[] => rows.slice(1).map((row) => row.slice(-3))

  // Catches a table that doesn't follow new requests, or one pinned by its distance from the
  // bottom, which slides as requests arrive.
  test('follows the newest, and stays on the same requests once scrolled up', () => {
    const size = { height: 4, width: 160 }
    const pinned = scrollRequestsView(undefined, requests, 2)
    const more = [...requests, http(10), http(11)]

    expect(shownIds(plainRows(requests, [], size))).toEqual(['007', '008', '009'])
    expect(shownIds(plainRows(requests, [], size, { view: pinned }))).toEqual(['005', '006', '007'])
    expect(shownIds(plainRows(more, [], size, { view: pinned }))).toEqual(['005', '006', '007'])
  })

  // Catches scrolling down never reaching the newest again, or scrolling up past the oldest.
  test('follows again on reaching the newest, and stops at the oldest', () => {
    const up = scrollRequestsView(undefined, requests, 3)

    expect(scrollRequestsView(up, requests, -3)).toBeUndefined()
    expect(scrollRequestsView(up, requests, 100)).toEqual({ last: 0 })
  })

  // Catches events skipped by scrolling, or a view pinned to an event sliding as rows arrive.
  test('scrolls over the events as rows, and stays pinned to one', () => {
    const spaced = requests.map((request) => ({ ...request, sequence: request.sequence * 10 }))
    const restarting = [event(45, 'Restarting on 127.0.0.1:4142')]
    const pinned = scrollRequestsView(undefined, tableEntries(spaced, restarting), 5)
    const more = [...spaced, http(100), http(110)]

    expect(pinned).toEqual({ last: 45 })
    const shown = plainRows(
      more,
      [],
      { height: 4, width: 160 },
      { view: pinned, events: restarting }
    )
    expect(shown[3]).toContain('◇ Restarting on 127.0.0.1:4142')
    expect(shown[2]).toMatch(/#000004$/u)
  })

  // Catches a pinned view jumping to the top, or failing, when its request was dropped from the
  // bounded list.
  test('a view pinned to a dropped request stays on the one before it', () => {
    const withGap = requests.filter((request) => request.sequence !== 6)
    const shown = plainRows(withGap, [], { height: 4, width: 160 }, { view: { last: 6 } })

    expect(shownIds(shown)).toEqual(['003', '004', '005'])
  })
})

describe('chatsById', () => {
  // Catches a finished chat request missing from the join, or one in flight hidden by an older
  // finished one.
  test('indexes the finished and the in-flight chat requests by request ID', () => {
    const running = chatFor(http(1))
    const done = finishedChat(chatFor(http(2)), { endedAt: START })

    const chats = chatsById([running], [done])

    expect(chats.get(running.requestId)).toBe(running)
    expect(chats.get(done.requestId)).toBe(done)
  })
})
