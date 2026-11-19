/**
 * The Requests page's rows (#367): the HTTP requests and the proxy's lifecycle events in one
 * list, newest first, each request with the chat behind it, as the console's Requests view shows
 * them.
 *
 * @remarks
 * Requests and events share one order (`sequence`, from the proxy's one counter), so merging by it
 * keeps them in the order things happened. A chat is matched to its HTTP request by request ID:
 * the one in flight when there is one, otherwise the newest that finished.
 *
 * @packageDocumentation
 */

import type { Chat, HttpRequest, ProxyEvent, Requests } from '@proxy/admin/web/api'

/** One HTTP request's row. */
export interface RequestRow {
  readonly kind: 'request'
  readonly key: string
  readonly at: number
  readonly request: HttpRequest
  /** The chat behind it; `undefined` for a request that was not a chat. */
  readonly chat: Chat | undefined
  /** How long it took, or has taken so far. */
  readonly elapsedMs: number
}

/** One lifecycle event's row. */
export interface EventRow {
  readonly kind: 'event'
  readonly key: string
  readonly at: number
  readonly event: ProxyEvent
}

/** One row of the Requests table. */
export type Row = RequestRow | EventRow

/**
 * Indexes the chats by request ID: the ones in flight first, then the newest that finished.
 *
 * @param requests - the snapshot
 * @returns request ID -> its chat
 */
function chatsById(requests: Requests): ReadonlyMap<string, Chat> {
  const byId = new Map<string, Chat>()
  for (const chat of [...requests.active, ...requests.finished]) {
    if (!byId.has(chat.requestId)) byId.set(chat.requestId, chat)
  }
  return byId
}

/**
 * Builds the table's rows from a snapshot.
 *
 * @param requests - the snapshot
 * @param now - the time now, for requests still in flight
 * @returns the rows, newest first
 */
export function requestRows(requests: Requests, now: number): Row[] {
  const chats = chatsById(requests)
  const requestRowsByOrder = requests.requests.map(
    (request): RequestRow & { readonly sequence: number } => ({
      kind: 'request',
      key: `request-${String(request.sequence)}`,
      sequence: request.sequence,
      at: request.startedAt,
      request,
      chat: chats.get(request.requestId),
      elapsedMs: (request.endedAt ?? now) - request.startedAt
    })
  )
  const eventRows = requests.events.map((event): EventRow & { readonly sequence: number } => ({
    kind: 'event',
    key: `event-${String(event.sequence)}`,
    sequence: event.sequence,
    at: event.at,
    event
  }))
  return [...requestRowsByOrder, ...eventRows].toSorted(
    (left, right) => right.sequence - left.sequence
  )
}
