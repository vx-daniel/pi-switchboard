/**
 * The admin UI (#367): the sign-in screen, or the signed-in operator's pages behind tabs.
 *
 * @packageDocumentation
 */

import {
  NotSignedInError,
  readApi,
  type Session,
  SessionSchema,
  signOut
} from '@proxy/admin/web/api'
import { Failure, Loading } from '@proxy/admin/web/loaded'
import { AccountsPage } from '@proxy/admin/web/pages/accounts'
import { DoctorPage } from '@proxy/admin/web/pages/doctor'
import { LoginsPage } from '@proxy/admin/web/pages/logins'
import { ModelsPage } from '@proxy/admin/web/pages/models'
import { RequestsPage } from '@proxy/admin/web/pages/requests'
import { StatsPage } from '@proxy/admin/web/pages/stats'
import { PAGES, type PageId, useCurrentPage } from '@proxy/admin/web/router'
import { useQuery } from '@tanstack/react-query'
import type { ReactElement } from 'react'

/** Each page's component. */
const PAGE_VIEWS: Readonly<Record<PageId, () => ReactElement>> = {
  requests: RequestsPage,
  accounts: AccountsPage,
  models: ModelsPage,
  stats: StatsPage,
  doctor: DoctorPage,
  logins: LoginsPage
}

/**
 * The screen of someone not signed in.
 *
 * @returns the sign-in card
 */
function SignIn(): ReactElement {
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="card card-border w-full max-w-sm bg-base-100">
        <div className="card-body items-center text-center">
          <h1 className="card-title">pi-switchboard</h1>
          <p className="text-base-content/60">Sign in with the GitHub account this proxy lists.</p>
          <div className="card-actions">
            <a className="btn btn-primary" href="/admin/auth/sign-in">
              Sign in with GitHub
            </a>
          </div>
        </div>
      </div>
    </main>
  )
}

/**
 * The signed-in operator's pages.
 *
 * @param shell - who is signed in
 * @param shell.session - their login and role
 * @returns the page layout
 */
function Shell(shell: { readonly session: Session }): ReactElement {
  const current = useCurrentPage()
  const View = PAGE_VIEWS[current]
  return (
    <div className="min-h-screen bg-base-200">
      <header className="navbar bg-base-100 px-4">
        <div className="navbar-start">
          <span className="text-lg font-semibold">pi-switchboard</span>
        </div>
        <div className="navbar-end gap-2">
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
      </header>
      <nav role="tablist" className="tabs tabs-border bg-base-100 px-4">
        {PAGES.map((page) => (
          <a
            key={page.id}
            role="tab"
            href={`#/${page.id}`}
            className={`tab ${page.id === current ? 'tab-active' : ''}`}
            aria-selected={page.id === current}
          >
            {page.title}
          </a>
        ))}
      </nav>
      <main className="p-4">
        <View />
      </main>
    </div>
  )
}

/**
 * The admin UI.
 *
 * @returns the sign-in screen, or the pages
 */
export function App(): ReactElement {
  const session = useQuery({
    queryKey: ['session'],
    queryFn: () => readApi('/session', SessionSchema),
    retry: false
  })
  if (session.isPending) return <Loading />
  if (session.isError) {
    return session.error instanceof NotSignedInError ? (
      <SignIn />
    ) : (
      <Failure error={session.error} />
    )
  }
  return <Shell session={session.data} />
}
