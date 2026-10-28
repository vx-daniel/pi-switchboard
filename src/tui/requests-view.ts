/**
 * The console's Requests table: every HTTP request the proxy answered or is answering
 * (`http-requests.ts`), newest at the bottom, each with when it came, its status, method and
 * path, and for a chat request the model it named and the one that served it, how long it took
 * and how long to its first event.
 *
 * @remarks
 * A chat request's model and timings come from the chat requests (`active-requests.ts`), joined by
 * the request ID: a stream's HTTP answer is ready at its headers, while the chat request ends when
 * the stream closes, so its duration and state are the chat request's. The columns on the right
 * drop on a narrow view: the ID first, then the first event, then the duration; the models go when
 * they would be narrower than {@link MODEL_LEAST_COLUMNS}.
 *
 * The view follows new requests, or is pinned to a row (by its place in the order) while new ones
 * arrive, as the raw log is pinned to a line. Lifecycle events (`console-events.ts`, #266) share
 * that order and show among the requests as quiet divider rows; a request in flight shows a
 * spinner that moves on with the console's one-second redraw.
 *
 * @packageDocumentation
 */

import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import type { ActiveRequest, FinishedRequest } from '@proxy/server/active-requests'
import type { ConsoleEvent, ConsoleEventLevel } from '@proxy/server/console-events'
import type { HttpRequest } from '@proxy/server/http-requests'
import { REQUEST_ID_PREFIX } from '@proxy/server/request-id'
import { gauge, latency } from '@proxy/tui/panel'
import { timeOfDay } from '@proxy/tui/screen'
import { type ConsoleColor, paint, strong } from '@proxy/tui/theme'

/** Columns between two cells. */
const GAP = '  '
/** The fixed cells' widths: the time, the status badge, the method and the path. */
const COLUMNS = { time: 8, status: 6, method: 6, path: 24 } as const
/** The narrowest the models cell is shown at; narrower, the path takes its room. */
const MODEL_LEAST_COLUMNS = 14
/** The duration cell: a gauge, a space and the time. */
const DURATION = { gauge: 10, text: 8 } as const
/** The duration cell's width. */
const DURATION_COLUMNS = DURATION.gauge + 1 + DURATION.text
/** The first-event cell's width: `1st 12.3s`. */
const FIRST_EVENT_COLUMNS = 9
/** The ID cell's width: `#` and the first characters of the ID's random part. */
const ID_COLUMNS = 7
/** The narrowest view each right-hand cell shows at. */
const SHOWN_FROM = { duration: 84, firstEvent: 104, id: 120 } as const
/** A duration that fills the gauge, in milliseconds. */
const GAUGE_FULL_MS = 6000
/** A duration from which the gauge is yellow, in milliseconds. */
const SLOW_MS = 4000
/** The status classes' first statuses. */
const STATUS_CLASS = { redirect: 300, client: 400, server: 500 } as const

/** `undefined` follows new requests; `{ last }` shows the requests up to the one in place `last`. */
export type RequestsViewport = { readonly last: number } | undefined

/** A chat request, in flight or finished, as the chat requests keep it. */
export type ChatRequest = ActiveRequest | FinishedRequest

/**
 * Indexes the chat requests by request ID, for the table to join its rows to.
 *
 * @param active - the chat requests in flight
 * @param finished - the finished chat requests kept
 * @returns each by its request ID
 */
export function chatsById(
  active: readonly ActiveRequest[],
  finished: readonly FinishedRequest[]
): ReadonlyMap<string, ChatRequest> {
  const chats = new Map<string, ChatRequest>()
  for (const chat of [...finished, ...active]) chats.set(chat.requestId, chat)
  return chats
}

/** The cells a row shows, from left to right. */
interface Layout {
  readonly path: number
  /** The models cell's width; 0 when it isn't shown. */
  readonly model: number
  readonly duration: boolean
  readonly firstEvent: boolean
  readonly id: boolean
}

/**
 * Works out which cells fit a width: the right-hand ones by {@link SHOWN_FROM}, the models in the
 * rest when that is at least {@link MODEL_LEAST_COLUMNS}, the path widened into it otherwise.
 *
 * @param width - the view's columns
 * @returns the layout
 */
function layoutFor(width: number): Layout {
  const duration = width >= SHOWN_FROM.duration
  const firstEvent = width >= SHOWN_FROM.firstEvent
  const id = width >= SHOWN_FROM.id
  // The time, the status and the method, each with the gap after it.
  const fixed =
    COLUMNS.time + GAP.length + (COLUMNS.status + GAP.length) + (COLUMNS.method + GAP.length)
  const right =
    (duration ? DURATION_COLUMNS + GAP.length : 0) +
    (firstEvent ? FIRST_EVENT_COLUMNS + GAP.length : 0) +
    (id ? ID_COLUMNS + GAP.length : 0)
  const model = width - fixed - COLUMNS.path - GAP.length - right
  if (model >= MODEL_LEAST_COLUMNS) return { path: COLUMNS.path, model, duration, firstEvent, id }
  return { path: Math.max(1, width - fixed - right), model: 0, duration, firstEvent, id }
}

/**
 * Checks whether a chat request has finished.
 *
 * @param chat - the chat request
 * @returns whether it has, with how and when
 */
function isFinished(chat: ChatRequest): chat is FinishedRequest {
  return 'endedAt' in chat
}

/**
 * Picks a status's color: green for a success, yellow for a client error, red for a server error.
 *
 * @param status - the status
 * @returns the color
 */
function statusColor(status: number): ConsoleColor {
  if (status >= STATUS_CLASS.server) return 'error'
  if (status >= STATUS_CLASS.client) return 'warning'
  if (status >= STATUS_CLASS.redirect) return 'accent'
  return 'success'
}

/** The in-flight mark's frames, one per second as the console redraws (#266). */
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const
/** Milliseconds each spinner frame shows: the console redraws every second. */
const SPINNER_FRAME_MS = 1000

/**
 * Renders the status badge, or while the request is in flight a spinner that moves on with the
 * console's one-second redraw.
 *
 * @param request - the request
 * @param now - the time now, which picks the spinner's frame
 * @returns the cell
 */
function statusCell(request: HttpRequest, now: number): string {
  if (request.status === undefined) {
    const frame = SPINNER[Math.floor(now / SPINNER_FRAME_MS) % SPINNER.length] ?? SPINNER[0]
    return strong(paint('warning', `  ${frame}  `))
  }
  return strong(paint(statusColor(request.status), ` ${String(request.status)} `))
}

/**
 * Renders the models a chat request named and was served by: `coding → anthropic/claude-opus-5`
 * for an alias, the model alone when it named one, and a dash for any other request.
 *
 * @param chat - the chat request, if the request is one
 * @returns the cell
 */
function modelCell(chat: ChatRequest | undefined): string {
  if (chat === undefined || chat.model === '') return paint('border', '—')
  if (chat.alias === null) return paint('accent', chat.model)
  return `${chat.alias}${paint('dim', '  →  ')}${paint('accent', chat.model)}`
}

/**
 * Finds when a request ended: its answer, or for a chat request, the chat request's end, which
 * for a stream is when the stream closed.
 *
 * @param request - the request
 * @param chat - its chat request, if it is one
 * @returns when it ended, or `undefined` while it is in flight
 */
function endedAt(request: HttpRequest, chat: ChatRequest | undefined): number | undefined {
  if (request.endedAt === undefined || chat === undefined) return request.endedAt
  return isFinished(chat) ? chat.endedAt : undefined
}

/**
 * Picks a finished request's gauge color: red when its chat request failed, yellow when it was
 * slow, blue otherwise.
 *
 * @param took - how long it took, in milliseconds
 * @param chat - its chat request, if it is one
 * @returns the color
 */
function durationColor(took: number, chat: ChatRequest | undefined): ConsoleColor {
  if (chat !== undefined && isFinished(chat) && chat.outcome === 'failed') return 'error'
  return took >= SLOW_MS ? 'warning' : 'accent'
}

/**
 * Renders how long a request took, as a gauge and the time; while it is in flight, whether it is
 * waiting for its first event or streaming, and how long it has run.
 *
 * @param request - the request
 * @param chat - its chat request, if it is one
 * @param now - the time now
 * @returns the cell
 */
function durationCell(request: HttpRequest, chat: ChatRequest | undefined, now: number): string {
  const ended = endedAt(request, chat)
  if (ended === undefined) {
    const state = chat?.firstEventAt === undefined ? 'waiting…' : 'streaming…'
    const elapsed = latency(now - request.startedAt).padStart(DURATION.text)
    return paint('warning', `${state.padEnd(DURATION.gauge)} ${elapsed}`)
  }
  const took = ended - request.startedAt
  const time = latency(took).padStart(DURATION.text)
  return `${gauge(took / GAUGE_FULL_MS, DURATION.gauge, durationColor(took, chat))} ${time}`
}

/**
 * Renders how long a chat request waited for its first event, or a dash.
 *
 * @param request - the request
 * @param chat - its chat request, if it is one
 * @returns the cell
 */
function firstEventCell(request: HttpRequest, chat: ChatRequest | undefined): string {
  if (chat?.firstEventAt === undefined) return `${paint('dim', '1st ')}${paint('border', '—')}`
  return `${paint('dim', '1st ')}${latency(chat.firstEventAt - request.startedAt)}`
}

/**
 * Renders the start of a request's ID, enough to find its lines in the raw log.
 *
 * @param requestId - the ID
 * @returns the cell
 */
function idCell(requestId: string): string {
  const random = requestId.startsWith(REQUEST_ID_PREFIX)
    ? requestId.slice(REQUEST_ID_PREFIX.length)
    : requestId
  return paint('dim', `#${random.slice(0, ID_COLUMNS - 1)}`)
}

/**
 * Joins cells into a row, each cut or padded to its width.
 *
 * @param cells - each cell's text and width
 * @returns the row
 */
function joinCells(cells: readonly (readonly [text: string, width: number])[]): string {
  return cells.map(([text, width]) => truncateToWidth(text, width, '…', true)).join(GAP)
}

/**
 * Renders one request's row.
 *
 * @param request - the request
 * @param chat - its chat request, if it is one
 * @param layout - the cells that fit
 * @param now - the time now
 * @returns the row
 */
function requestRow(
  request: HttpRequest,
  chat: ChatRequest | undefined,
  layout: Layout,
  now: number
): string {
  const cells: (readonly [string, number])[] = [
    [paint('dim', timeOfDay(request.startedAt)), COLUMNS.time],
    [statusCell(request, now), COLUMNS.status],
    [strong(request.method), COLUMNS.method],
    [request.path, layout.path]
  ]
  if (layout.model > 0) cells.push([modelCell(chat), layout.model])
  if (layout.duration) cells.push([durationCell(request, chat, now), DURATION_COLUMNS])
  if (layout.firstEvent) cells.push([firstEventCell(request, chat), FIRST_EVENT_COLUMNS])
  if (layout.id) cells.push([idCell(request.requestId), ID_COLUMNS])
  return joinCells(cells)
}

/** Each event level's mark and color: info quiet, a warning or an error in its color. */
const EVENT_STYLE: Readonly<
  Record<ConsoleEventLevel, { readonly mark: string; readonly color: ConsoleColor }>
> = {
  info: { mark: '◇', color: 'dim' },
  warning: { mark: '◆', color: 'warning' },
  error: { mark: '◆', color: 'error' }
}

/**
 * Renders a lifecycle event as a divider among the requests (#266): its time, its mark and what
 * happened, then a dotted rule to the row's end.
 *
 * @param event - the event
 * @param width - the row's columns
 * @returns the row
 */
function eventRow(event: ConsoleEvent, width: number): string {
  const { mark, color } = EVENT_STYLE[event.level]
  const text = `${mark} ${event.text} `
  const rule = '┄'.repeat(Math.max(0, width - COLUMNS.time - GAP.length - visibleWidth(text)))
  return `${paint('dim', timeOfDay(event.at))}${GAP}${paint(color, `${text}${rule}`)}`
}

/** A row of the table: an HTTP request, or a lifecycle event among them. */
export type TableEntry = HttpRequest | ConsoleEvent

/**
 * Checks whether a row is a lifecycle event.
 *
 * @param entry - the row
 * @returns whether it is an event
 */
function isEvent(entry: TableEntry): entry is ConsoleEvent {
  return entry.kind === 'event'
}

/**
 * Merges the requests and the events into the table's rows, in the order they share.
 *
 * @param requests - the HTTP requests
 * @param events - the lifecycle events
 * @returns the rows, oldest first
 */
export function tableEntries(
  requests: readonly HttpRequest[],
  events: readonly ConsoleEvent[]
): TableEntry[] {
  return [...requests, ...events].toSorted((left, right) => left.sequence - right.sequence)
}

/**
 * Renders the heading row: each cell's name over it.
 *
 * @param layout - the cells that fit
 * @returns the row
 */
function headingRow(layout: Layout): string {
  const cells: (readonly [string, number])[] = [
    ['time', COLUMNS.time],
    ['status', COLUMNS.status],
    ['method', COLUMNS.method],
    ['path', layout.path]
  ]
  if (layout.model > 0) cells.push(['requested  →  served by', layout.model])
  if (layout.duration) cells.push(['duration', DURATION_COLUMNS])
  if (layout.firstEvent) cells.push(['1st event', FIRST_EVENT_COLUMNS])
  if (layout.id) cells.push(['id', ID_COLUMNS])
  return paint('dim', joinCells(cells))
}

/**
 * Finds where a pinned view ends: the last row at or before its place in the order, which may
 * have been dropped since.
 *
 * @param view - the pinned view
 * @param entries - the rows, oldest first
 * @returns the index of the last row shown; 0 when every row before it was dropped
 */
function pinnedIndex(
  view: { readonly last: number },
  entries: readonly { readonly sequence: number }[]
): number {
  return Math.max(
    0,
    entries.findLastIndex((entry) => entry.sequence <= view.last)
  )
}

/**
 * Scrolls the table by some rows, pinning it when it leaves the newest and following again when
 * it reaches it.
 *
 * @param view - where the view is
 * @param entries - the rows, requests and events, oldest first ({@link tableEntries})
 * @param lines - rows to scroll up (positive) or down (negative)
 * @returns where the view is now
 */
export function scrollRequestsView(
  view: RequestsViewport,
  entries: readonly { readonly sequence: number }[],
  lines: number
): RequestsViewport {
  const last = view === undefined ? entries.length - 1 : pinnedIndex(view, entries)
  const target = last - lines
  if (target >= entries.length - 1) return undefined
  const entry = entries[Math.max(0, target)]
  return entry === undefined ? undefined : { last: entry.sequence }
}

/**
 * Says whether the table follows new requests, for the left of the frame's bottom border: `● live`,
 * or `‖ paused · 3 newer below · End to follow` while it is pinned.
 *
 * @param view - where the view is
 * @param entries - the rows, requests and events, oldest first ({@link tableEntries})
 * @returns the text, coloured
 */
export function requestsStatus(
  view: RequestsViewport,
  entries: readonly { readonly sequence: number }[]
): string {
  if (view === undefined) return paint('success', '● live')
  const newer = Math.max(0, entries.length - 1 - pinnedIndex(view, entries))
  return `${paint('warning', '‖ paused')}${paint('dim', ` · ${String(newer)} newer below · End to follow`)}`
}

/** What the Requests table shows. */
export interface RequestsData {
  /** The HTTP requests, oldest first. */
  readonly requests: readonly HttpRequest[]
  /** The lifecycle events, oldest first, shown among the requests in the order they share. */
  readonly events: readonly ConsoleEvent[]
  /** The chat requests, in flight and finished, by request ID. */
  readonly chats: ReadonlyMap<string, ChatRequest>
  /** The time now, for the requests in flight and the spinner. */
  readonly now: number
}

/**
 * Renders the Requests table: a heading, then the rows that fit, requests and lifecycle events in
 * the order they happened, newest at the bottom once they fill the height; with no request yet,
 * a line under the events says so.
 *
 * @param view - where the view is
 * @param data - the requests, the events, the chat requests, and the time now
 * @param size - the space available
 * @param size.height - rows
 * @param size.width - columns
 * @returns at most `height` rows, each exactly `width` columns
 */
export function requestsRows(
  view: RequestsViewport,
  data: RequestsData,
  size: { readonly height: number; readonly width: number }
): string[] {
  const { chats, now } = data
  const layout = layoutFor(size.width)
  const entries = tableEntries(data.requests, data.events)
  const hint = data.requests.length === 0 ? [paint('dim', 'No requests yet.')] : []
  const visible = Math.max(0, size.height - 1 - hint.length)
  const end =
    view === undefined
      ? entries.length
      : Math.max(pinnedIndex(view, entries) + 1, Math.min(visible, entries.length))
  const body = entries
    .slice(Math.max(0, end - visible), end)
    .map((tableEntry) =>
      isEvent(tableEntry)
        ? eventRow(tableEntry, size.width)
        : requestRow(tableEntry, chats.get(tableEntry.requestId), layout, now)
    )
  return [headingRow(layout), ...body, ...hint]
    .slice(0, Math.max(0, size.height))
    .map((row) => truncateToWidth(row, size.width, '…', true))
}
