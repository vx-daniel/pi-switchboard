/**
 * The Requests page (#367): the proxy's requests and lifecycle events, newest first, kept current
 * by the shell's `/admin/api/requests/stream` (`useFollowedRequests`).
 *
 * @packageDocumentation
 */

import type { Requests } from '@proxy/admin/web/api'
import { DataTable } from '@proxy/admin/web/data-table'
import { clock, duration } from '@proxy/admin/web/format'
import { Loaded } from '@proxy/admin/web/loaded'
import { useRequests } from '@proxy/admin/web/queries'
import { type EventRow, type RequestRow, requestRows } from '@proxy/admin/web/request-rows'
import type { ReactElement } from 'react'

/** The first status that is not a success. */
const FIRST_FAILURE_STATUS = 400
/** How each event level is colored; written out whole, so Tailwind finds each class. */
const EVENT_TONE = {
  info: 'text-base-content/60',
  warning: 'text-warning',
  error: 'text-error'
} as const
/** How each chat outcome is colored. */
const OUTCOME_BADGE = {
  ok: 'badge-success',
  failed: 'badge-error',
  left: 'badge-warning',
  rejected: 'badge-warning'
} as const

/**
 * Shows one HTTP request.
 *
 * @param line - the row
 * @param line.row - the request and the chat behind it
 * @returns the table row
 */
function RequestLine(line: { readonly row: RequestRow }): ReactElement {
  const { request, chat, elapsedMs } = line.row
  const failed = request.status !== undefined && request.status >= FIRST_FAILURE_STATUS
  return (
    <tr>
      <td className="font-mono text-xs">{clock(line.row.at)}</td>
      <td className="font-mono text-xs">
        {request.method} {request.path}
      </td>
      <td>
        {request.status === undefined ? (
          <span className="loading loading-dots loading-xs" aria-label="In flight" />
        ) : (
          <span className={`badge badge-sm ${failed ? 'badge-error' : 'badge-ghost'}`}>
            {request.status}
          </span>
        )}
      </td>
      <td className="text-xs">{duration(elapsedMs)}</td>
      <td className="text-xs">
        {chat === undefined ? null : (
          <span className="flex flex-wrap items-center gap-1">
            {chat.alias === null ? null : (
              <span className="badge badge-sm badge-outline">{chat.alias}</span>
            )}
            <span className="font-mono">{chat.model}</span>
            {chat.attempt > 1 ? (
              <span className="text-base-content/60">attempt {chat.attempt}</span>
            ) : null}
            {chat.outcome === undefined ? null : (
              <span className={`badge badge-sm ${OUTCOME_BADGE[chat.outcome]}`}>
                {chat.outcome}
              </span>
            )}
          </span>
        )}
      </td>
    </tr>
  )
}

/**
 * Shows one lifecycle event.
 *
 * @param line - the row
 * @param line.row - the event
 * @returns the table row
 */
function EventLine(line: { readonly row: EventRow }): ReactElement {
  const { event } = line.row
  const tone = EVENT_TONE[event.level]
  return (
    <tr>
      <td className="font-mono text-xs">{clock(event.at)}</td>
      <td colSpan={4} className={`text-xs italic ${tone}`}>
        {event.text}
      </td>
    </tr>
  )
}

/**
 * Shows the requests table.
 *
 * @param table - the snapshot
 * @param table.requests - the requests, chats and events
 * @returns the table
 */
function RequestsTable(table: { readonly requests: Requests }): ReactElement {
  const rows = requestRows(table.requests, Date.now())
  if (rows.length === 0) return <p className="p-4 text-base-content/60">No requests yet.</p>
  return (
    <DataTable headings={['Time', 'Request', 'Status', 'Took', 'Model']}>
      {rows.map((row) =>
        row.kind === 'request' ? (
          <RequestLine key={row.key} row={row} />
        ) : (
          <EventLine key={row.key} row={row} />
        )
      )}
    </DataTable>
  )
}

/**
 * The Requests page.
 *
 * @returns the page
 */
export function RequestsPage(): ReactElement {
  const query = useRequests()
  return <Loaded query={query}>{(requests) => <RequestsTable requests={requests} />}</Loaded>
}
