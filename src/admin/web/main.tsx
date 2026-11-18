/**
 * The admin UI's entry (#367): mounts the app into `index.html`'s root.
 *
 * @packageDocumentation
 */

import { NotSignedInError } from '@proxy/admin/web/api'
import { App } from '@proxy/admin/web/app'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

/** How many times a failed read is retried, unless the session ended. */
const RETRIES = 2

/** The pages' reads: a missing session is final, anything else is retried twice. */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failures, error) => !(error instanceof NotSignedInError) && failures < RETRIES
    }
  }
})

/** Where `index.html` mounts the app. */
const root = document.querySelector('#root')
if (root === null) throw new Error('index.html has no #root')
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>
)
