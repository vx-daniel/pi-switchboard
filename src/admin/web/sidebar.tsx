/**
 * The admin UI's sidebar (#367), as the console's: each login's quota windows (QUOTA), the chat
 * requests in flight (IN FLIGHT), the last minute and the latest finished requests (RECENT), and
 * the traffic since the proxy started (SESSION), beside whichever page is shown.
 *
 * @packageDocumentation
 */

import type { Account, Requests, Status } from '@proxy/admin/web/api'
import { compactDuration, duration, percent, tokens } from '@proxy/admin/web/format'
import type { ReactElement, ReactNode } from 'react'

/** A quota share used past this is a warning, as on the Accounts page. */
const HIGH_USE = 0.8
/** The progress bars' scale. */
const PROGRESS_MAX = 100
/** Milliseconds in a minute, for RECENT's last minute. */
const MS_PER_MINUTE = 60_000
/** How many finished requests RECENT lists. */
const RECENT_SHOWN = 5
/** How each chat outcome is colored, as on the Requests page. */
const OUTCOME_TEXT = {
  ok: 'text-success',
  failed: 'text-error',
  left: 'text-warning',
  rejected: 'text-warning'
} as const

/**
 * One panel: its title and its lines.
 *
 * @param panel - the title and the content
 * @param panel.title - the panel's name, as the console capitalizes it
 * @param panel.children - the content
 * @returns the panel
 */
function Panel(panel: { readonly title: string; readonly children: ReactNode }): ReactElement {
  return (
    <section className="rounded-box bg-base-100 p-3">
      <h2 className="mb-2 text-xs font-semibold tracking-wider text-base-content/60">
        {panel.title}
      </h2>
      <div className="flex flex-col gap-2 text-sm">{panel.children}</div>
    </section>
  )
}

/**
 * QUOTA: each login's windows, with what is used and when it resets.
 *
 * @param quota - the logins and the time
 * @param quota.accounts - the logins
 * @param quota.now - the time now
 * @returns the panel
 */
function QuotaPanel(quota: {
  readonly accounts: readonly Account[]
  readonly now: number
}): ReactElement {
  const reporting = quota.accounts.filter((account) => (account.quota?.windows.length ?? 0) > 0)
  return (
    <Panel title="QUOTA">
      {reporting.length === 0 ? (
        <span className="text-base-content/60">No login has reported yet.</span>
      ) : null}
      {reporting.map((account) => (
        <div key={account.provider}>
          <div className="font-mono text-xs">{account.label ?? account.provider}</div>
          {(account.quota?.windows ?? []).map((window) => (
            <div key={window.name} className="flex items-center gap-2 text-xs">
              <span className="w-16 truncate">{window.name}</span>
              <progress
                className={`progress h-1.5 flex-1 ${window.used > HIGH_USE || account.belowReserve !== null ? 'progress-warning' : 'progress-success'}`}
                value={Math.round(window.used * PROGRESS_MAX)}
                max={PROGRESS_MAX}
              />
              <span className="w-10 text-right">{percent(window.used)}</span>
              <span className="w-14 text-right text-base-content/60">
                {window.resetsAt === undefined
                  ? ''
                  : `↻${compactDuration(window.resetsAt - quota.now)}`}
              </span>
            </div>
          ))}
        </div>
      ))}
    </Panel>
  )
}

/**
 * IN FLIGHT and RECENT: the chat requests running, the last minute's count and the latest done.
 *
 * @param chats - the requests and the time
 * @param chats.requests - the snapshot
 * @param chats.now - the time now
 * @returns the two panels
 */
function ChatPanels(chats: { readonly requests: Requests; readonly now: number }): ReactElement {
  const { active, finished } = chats.requests
  const lastMinute = finished.filter(
    (chat) => chat.endedAt !== undefined && chats.now - chat.endedAt < MS_PER_MINUTE
  ).length
  return (
    <>
      <Panel title="IN FLIGHT">
        {active.length === 0 ? (
          <span className="text-base-content/60">Nothing running.</span>
        ) : null}
        {active.map((chat) => (
          <div
            key={`${chat.requestId}-${String(chat.startedAt)}`}
            className="flex justify-between gap-2 text-xs"
          >
            <span className="truncate font-mono">
              {chat.alias === null ? chat.model : `${chat.alias} → ${chat.model}`}
              {chat.attempt > 1 ? ` (attempt ${String(chat.attempt)})` : ''}
            </span>
            <span>{compactDuration(chats.now - chat.startedAt)}</span>
          </div>
        ))}
      </Panel>
      <Panel title="RECENT">
        <span className="text-xs text-base-content/60">{lastMinute} in the last minute</span>
        {finished.slice(0, RECENT_SHOWN).map((chat) => (
          <div
            key={`${chat.requestId}-${String(chat.endedAt ?? 0)}`}
            className="flex justify-between gap-2 text-xs"
          >
            <span className="truncate font-mono">{chat.model}</span>
            <span className={chat.outcome === undefined ? '' : OUTCOME_TEXT[chat.outcome]}>
              {chat.outcome}{' '}
              {chat.endedAt === undefined ? '' : duration(chat.endedAt - chat.startedAt)}
            </span>
          </div>
        ))}
      </Panel>
    </>
  )
}

/**
 * SESSION: the traffic since the proxy started, all routes added up.
 *
 * @param session - the status
 * @param session.status - the proxy's status, with the route totals
 * @returns the panel
 */
function SessionPanel(session: { readonly status: Status }): ReactElement {
  const { totals } = session.status.session
  const sum = (field: (route: (typeof totals)[number]) => number): number =>
    totals.reduce((total, route) => total + field(route), 0)
  return (
    <Panel title="SESSION">
      <div className="grid grid-cols-2 gap-1 text-xs">
        <span>requests</span>
        <span className="text-right">{sum((route) => route.requests)}</span>
        <span>failed</span>
        <span className="text-right">{sum((route) => route.failures)}</span>
        <span>fallbacks</span>
        <span className="text-right">{sum((route) => route.fallbacks)}</span>
        <span>tokens in</span>
        <span className="text-right">
          {tokens(sum((route) => route.inputTokens + route.cacheReadTokens))}
        </span>
        <span>tokens out</span>
        <span className="text-right">{tokens(sum((route) => route.outputTokens))}</span>
      </div>
    </Panel>
  )
}

/**
 * The sidebar: the panels it has data for.
 *
 * @param sidebar - what the panels read
 * @param sidebar.accounts - the logins, once read
 * @param sidebar.requests - the requests, once read
 * @param sidebar.status - the proxy's status, once read
 * @param sidebar.now - the time now
 * @returns the sidebar
 */
export function Sidebar(sidebar: {
  readonly accounts: readonly Account[] | undefined
  readonly requests: Requests | undefined
  readonly status: Status | undefined
  readonly now: number
}): ReactElement {
  return (
    <aside className="flex flex-col gap-3" aria-label="Sidebar">
      {sidebar.accounts === undefined ? null : (
        <QuotaPanel accounts={sidebar.accounts} now={sidebar.now} />
      )}
      {sidebar.requests === undefined ? null : (
        <ChatPanels requests={sidebar.requests} now={sidebar.now} />
      )}
      {sidebar.status === undefined ? null : <SessionPanel status={sidebar.status} />}
    </aside>
  )
}
