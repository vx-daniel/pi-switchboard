/**
 * The signed-in admin UI's layout (#367), as the console's screen: the status strip and its
 * alerts, the tabs (Doctor's with the count of its errors and warnings), the page beside the
 * sidebar, and a footer of the keys. The keys work as the console's: `1`–`6` pick a page, `s`
 * hides or shows the sidebar, and `t`, `w` and `a` pick the window the Stats and Doctor pages
 * share.
 *
 * @packageDocumentation
 */

import { type Session, signOut, type StatsWindow } from '@proxy/admin/web/api'
import { AccountsPage } from '@proxy/admin/web/pages/accounts'
import { DoctorPage } from '@proxy/admin/web/pages/doctor'
import { LoginsPage } from '@proxy/admin/web/pages/logins'
import { ModelsPage } from '@proxy/admin/web/pages/models'
import { RequestsPage } from '@proxy/admin/web/pages/requests'
import { StatsPage } from '@proxy/admin/web/pages/stats'
import {
  useAccounts,
  useDoctor,
  useFollowedRequests,
  useNow,
  useStatus
} from '@proxy/admin/web/queries'
import { PAGES, type PageId, type PageView, useCurrentPage } from '@proxy/admin/web/router'
import { Sidebar } from '@proxy/admin/web/sidebar'
import { StatusAlerts, StatusStrip } from '@proxy/admin/web/status-strip'
import { type ReactElement, useCallback, useEffect, useState } from 'react'

/** Each page's component. */
const PAGE_VIEWS: Readonly<Record<PageId, (view: PageView) => ReactElement>> = {
  requests: RequestsPage,
  accounts: AccountsPage,
  models: ModelsPage,
  stats: StatsPage,
  doctor: DoctorPage,
  logins: LoginsPage
}

/** The window keys, as the console's. */
const WINDOW_KEYS: readonly { readonly key: string; readonly statsWindow: StatsWindow }[] = [
  { key: 't', statsWindow: 'today' },
  { key: 'w', statsWindow: 'week' },
  { key: 'a', statsWindow: 'all' }
]

/**
 * Follows the console's keys, unless one is typed into a field or pressed with a modifier.
 *
 * @param keys - what the keys do
 * @param keys.toggleSidebar - `s`
 * @param keys.pickWindow - `t`, `w` and `a`
 */
function useConsoleKeys(keys: {
  readonly toggleSidebar: () => void
  readonly pickWindow: (statsWindow: StatsWindow) => void
}): void {
  const { toggleSidebar, pickWindow } = keys
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const typing =
        event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement
      if (typing || event.altKey || event.ctrlKey || event.metaKey) return
      const page = PAGES[Number(event.key) - 1]
      if (page !== undefined) window.location.hash = `#/${page.id}`
      else if (event.key === 's') toggleSidebar()
      else {
        const picked = WINDOW_KEYS.find((windowKey) => windowKey.key === event.key)
        if (picked !== undefined) pickWindow(picked.statsWindow)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [toggleSidebar, pickWindow])
}

/**
 * The tabs, Doctor's with the count of its errors and warnings, in the color of the worst.
 *
 * @param tabs - the page shown, and the window the Doctor reads
 * @param tabs.current - the page shown
 * @param tabs.statsWindow - the window
 * @returns the tab list
 */
function Tabs(tabs: { readonly current: PageId; readonly statsWindow: StatsWindow }): ReactElement {
  const doctor = useDoctor(tabs.statsWindow)
  const findings = doctor.data === undefined ? [] : [...doctor.data.general, ...doctor.data.cache]
  const errors = findings.filter((finding) => finding.severity === 'error').length
  const count = errors + findings.filter((finding) => finding.severity === 'warning').length
  return (
    <nav role="tablist" className="tabs tabs-border bg-base-100 px-4">
      {PAGES.map((page, position) => (
        <a
          key={page.id}
          role="tab"
          href={`#/${page.id}`}
          className={`tab gap-2 ${page.id === tabs.current ? 'tab-active' : ''}`}
          aria-selected={page.id === tabs.current}
        >
          <span className="text-base-content/40">{position + 1}</span>
          {page.title}
          {page.id === 'doctor' && count > 0 ? (
            <span className={`badge badge-xs ${errors > 0 ? 'badge-error' : 'badge-warning'}`}>
              {count}
            </span>
          ) : null}
        </a>
      ))}
    </nav>
  )
}

/**
 * The signed-in operator's screen.
 *
 * @param shell - who is signed in
 * @param shell.session - their login and role
 * @returns the screen
 */
export function Shell(shell: { readonly session: Session }): ReactElement {
  const current = useCurrentPage()
  const [sidebarShown, setSidebarShown] = useState(true)
  const [statsWindow, setStatsWindow] = useState<StatsWindow>('today')
  const toggleSidebar = useCallback(() => {
    setSidebarShown((shown) => !shown)
  }, [])
  useConsoleKeys({ toggleSidebar, pickWindow: setStatsWindow })
  const status = useStatus()
  const requests = useFollowedRequests()
  const accounts = useAccounts()
  const now = useNow()
  const View = PAGE_VIEWS[current]
  return (
    <div className="flex min-h-screen flex-col bg-base-200">
      <header className="flex flex-col gap-2 bg-base-100 px-4 py-2">
        <div className="flex items-center gap-3">
          <div className="flex-1">
            {status.data === undefined ? null : <StatusStrip status={status.data} />}
          </div>
          <span className="text-sm">{shell.session.login}</span>
          <span className="badge badge-ghost badge-sm">{shell.session.role}</span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              void signOut()
            }}
          >
            Sign out
          </button>
        </div>
        {status.data === undefined ? null : <StatusAlerts status={status.data} />}
      </header>
      <Tabs current={current} statsWindow={statsWindow} />
      <div
        className={`grid flex-1 grid-cols-1 gap-4 p-4 ${sidebarShown ? 'lg:grid-cols-[minmax(0,1fr)_22rem]' : ''}`}
      >
        <main className="min-w-0">
          <View statsWindow={statsWindow} onPickWindow={setStatsWindow} />
        </main>
        {sidebarShown ? (
          <Sidebar
            accounts={accounts.data}
            requests={requests.data}
            status={status.data}
            now={now}
          />
        ) : null}
      </div>
      <footer className="flex flex-wrap gap-x-4 bg-base-100 px-4 py-1 text-xs text-base-content/60">
        <span>
          <kbd className="kbd kbd-xs">1</kbd>–<kbd className="kbd kbd-xs">6</kbd> page
        </span>
        <span>
          <kbd className="kbd kbd-xs">s</kbd> sidebar
        </span>
        <span>
          <kbd className="kbd kbd-xs">t</kbd> <kbd className="kbd kbd-xs">w</kbd>{' '}
          <kbd className="kbd kbd-xs">a</kbd> window (Stats, Doctor): {statsWindow}
        </span>
      </footer>
    </div>
  )
}
