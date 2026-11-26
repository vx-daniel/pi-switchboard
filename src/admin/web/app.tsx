/**
 * The admin UI (#367): the sign-in screen, or the signed-in operator's screen
 * (`src/admin/web/shell.tsx`).
 *
 * @packageDocumentation
 */

import { NotSignedInError, readApi, SessionSchema } from '@proxy/admin/web/api'
import { Failure, Loading } from '@proxy/admin/web/loaded'
import { Shell } from '@proxy/admin/web/shell'
import { useQuery } from '@tanstack/react-query'
import type { ReactElement } from 'react'

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
