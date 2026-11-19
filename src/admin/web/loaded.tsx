/**
 * What every admin page shows while its data loads or when the read fails, so each page renders
 * only its data.
 *
 * @packageDocumentation
 */

import { NotSignedInError } from '@proxy/admin/web/api'
import type { UseQueryResult } from '@tanstack/react-query'
import type { ReactElement, ReactNode } from 'react'

/**
 * Shows that a page is loading.
 *
 * @returns the spinner
 */
export function Loading(): ReactElement {
  return (
    <div className="flex justify-center p-8">
      <span className="loading loading-spinner loading-lg" aria-label="Loading" />
    </div>
  )
}

/**
 * Shows why a read failed; for an ended session, the way to sign in again.
 *
 * @param failure - the failure
 * @param failure.error - the error the read threw
 * @returns the alert
 */
export function Failure(failure: { readonly error: Error }): ReactElement {
  if (failure.error instanceof NotSignedInError) {
    return (
      <div role="alert" className="alert alert-warning">
        <span>Your session has ended.</span>
        <a className="btn btn-sm" href="/admin/auth/sign-in">
          Sign in again
        </a>
      </div>
    )
  }
  return (
    <div role="alert" className="alert alert-error">
      <span>{failure.error.message}</span>
    </div>
  )
}

/**
 * Shows a read's data once it has loaded, or why it has not.
 *
 * @typeParam T - the data's type
 * @param view - the read and what to show of its data
 * @param view.query - the read
 * @param view.children - renders the data
 * @returns the page's content
 */
export function Loaded<T>(view: {
  readonly query: UseQueryResult<T>
  readonly children: (data: T) => ReactNode
}): ReactElement {
  const { query } = view
  if (query.isPending) return <Loading />
  if (query.isError) return <Failure error={query.error} />
  return <>{view.children(query.data)}</>
}
