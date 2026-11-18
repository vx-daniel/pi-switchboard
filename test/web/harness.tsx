/**
 * The admin pages' test harness (#367): a stubbed `fetch` that answers `/admin/api/` from a
 * script, a stand-in `EventSource` a test pushes events through, and the app rendered on a page.
 *
 * @packageDocumentation
 */

import { App } from '@proxy/admin/web/app'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, type RenderResult } from '@testing-library/react'
import { vi } from 'vite-plus/test'

/**
 * An answer: a body to send as JSON with `200`, or `{ status, body }` for another status.
 */
export type Answer = unknown

/** One request the app made. */
export interface Call {
  readonly method: string
  /** The path and query, such as `/admin/api/stats?window=week`. */
  readonly path: string
}

/** The signed-in operator most tests use. */
export const VIEWER = { login: 'alice', role: 'viewer' }

/**
 * Tells a scripted answer with a status from a bare body.
 *
 * @param answer - the answer
 * @returns whether it names its status
 */
function hasStatus(answer: Answer): answer is { readonly status: number; readonly body: unknown } {
  return typeof answer === 'object' && answer !== null && 'status' in answer && 'body' in answer
}

/**
 * Stubs `fetch` with scripted answers, by path under `/admin/api` (`/accounts`, `/stats?window=week`).
 * A path not scripted answers `404`. Sign-out answers `204`.
 *
 * @param answers - path -> its answer
 * @returns every request made, in order
 */
export function stubApi(answers: Readonly<Record<string, Answer>>): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET'
    calls.push({ method, path: input })
    if (input === '/admin/auth/sign-out') return new Response(null, { status: 204 })
    const answer = answers[input.replace(/^\/admin\/api/u, '')]
    if (answer === undefined) {
      return Response.json({ error: { message: 'Not scripted' } }, { status: 404 })
    }
    return hasStatus(answer)
      ? Response.json(answer.body, { status: answer.status })
      : Response.json(answer)
  })
  return calls
}

/** A listener for one kind of stream event. */
type StreamListener = (message: MessageEvent<string>) => void

/** A stand-in for one `EventSource` the page opened. */
export interface FakeSource {
  readonly url: string
  /** Whether the page closed it. */
  readonly closed: boolean
  /**
   * Sends an event to the page, as the proxy would.
   *
   * @param name - the event's name
   * @param data - its data, sent as JSON
   */
  emit(name: string, data: unknown): void
}

/** Every source the page opened since {@link stubEventSource}, oldest first. */
export const openedSources: FakeSource[] = []

/**
 * Opens a stand-in source: what `new EventSource(url)` gives the page once stubbed. A plain
 * function, so `new` returns the object it builds.
 *
 * @param url - the stream's address
 * @returns the source
 */
function FakeEventSource(url: string): FakeSource {
  const listeners = new Map<string, StreamListener[]>()
  const source = {
    url,
    closed: false,
    addEventListener(name: string, listener: StreamListener): void {
      listeners.set(name, [...(listeners.get(name) ?? []), listener])
    },
    removeEventListener(name: string, listener: StreamListener): void {
      listeners.set(
        name,
        (listeners.get(name) ?? []).filter((kept) => kept !== listener)
      )
    },
    close(): void {
      source.closed = true
    },
    emit(name: string, data: unknown): void {
      const message = new MessageEvent<string>(name, { data: JSON.stringify(data) })
      for (const listener of listeners.get(name) ?? []) listener(message)
    }
  }
  openedSources.push(source)
  return source
}

/**
 * Stubs `EventSource` with {@link FakeEventSource}, forgetting the sources of earlier tests.
 */
export function stubEventSource(): void {
  openedSources.length = 0
  vi.stubGlobal('EventSource', FakeEventSource)
}

/**
 * Renders the app on a page.
 *
 * @param hash - the page's hash, such as `#/accounts`; the first page by default
 * @returns what Testing Library rendered
 */
export function renderApp(hash = ''): RenderResult {
  window.location.hash = hash
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  )
}
