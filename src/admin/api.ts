/**
 * The admin UI's API (#367, phase 1): who is signed in, and the read-only pages' data, under
 * `/admin/api/` on the admin listener. Every route needs a session, either role; none writes.
 *
 * @remarks
 * A request without a valid session cookie is answered `401` before any route runs, so an unknown
 * path tells nobody signed out what exists. The Requests page follows `/admin/api/requests/stream`,
 * a server-sent event stream of the same snapshot `/admin/api/requests` answers, sent at most
 * twice a second while the requests change, with a comment every 15 seconds to keep proxies from
 * closing it.
 *
 * @packageDocumentation
 */

import {
  accountsSnapshot,
  type AdminServerFacts,
  doctorSnapshot,
  modelsSnapshot,
  requestsSnapshot
} from '@proxy/admin/reads'
import type { AdminRole } from '@proxy/admin/roles'
import { statusSnapshot } from '@proxy/admin/status'
import { proxyLogger } from '@proxy/logging'
import { onActiveRequestsChange } from '@proxy/server/active-requests'
import { onConsoleEventsChange } from '@proxy/server/console-events'
import { onHttpRequestsChange } from '@proxy/server/http-requests'
import {
  HTTP_BAD_REQUEST,
  HTTP_OK,
  HTTP_SERVICE_UNAVAILABLE,
  HTTP_UNAUTHORIZED
} from '@proxy/server/http-status'
import { createUsageAnswer } from '@proxy/server/usage'
import { isStatsWindow, type StatsWindow } from '@proxy/stats/windows'
import { errorMessage } from '@proxy/utils/guards'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'

/** Logger for the admin UI's reads. */
const adminLogger = proxyLogger('admin')

/** How often a changed snapshot is sent at most, in milliseconds. */
const STREAM_FLUSH_MS = 500
/** How often an idle stream sends a comment, in milliseconds. */
const STREAM_HEARTBEAT_MS = 15_000

/** A signed-in operator. */
export interface AdminSession {
  readonly login: string
  readonly id: number
  readonly role: AdminRole
}

/** What the API reads with. */
export interface AdminApiDeps {
  /**
   * Opens the session a request's cookies carry.
   *
   * @param cookieHeader - the request's `Cookie` header, or `undefined` when it sent none
   * @returns the operator, or `undefined` when there is no valid session
   */
  readonly sessionOf: (cookieHeader: string | undefined) => AdminSession | undefined
  /** The API listener's settings, for the doctor and the stats. */
  readonly server: AdminServerFacts
  /** The time, in milliseconds since the epoch. */
  readonly now: () => number
}

/** The API's Hono env: the session the middleware found. */
interface AdminApiEnv {
  readonly Variables: { readonly session: AdminSession }
}

/** The answer to a request without a session. */
const NOT_SIGNED_IN = {
  error: { code: 'not_signed_in', message: 'Sign in at /admin/auth/sign-in' }
} as const

/** The answer to a `window` that is no window. */
const BAD_WINDOW = {
  error: { code: 'invalid_window', message: '`window` must be `today`, `week` or `all`' }
} as const

/**
 * Reads the `window` query value: `today` when absent, `undefined` when it is no window.
 *
 * @param value - the query value
 * @returns the window, or `undefined` when it is not one
 */
function windowOf(value: string | undefined): StatsWindow | undefined {
  const asked = value ?? 'today'
  return isStatsWindow(asked) ? asked : undefined
}

/**
 * Adds the requests routes: the snapshot, and the stream that sends it again on each change.
 *
 * @param api - the API app
 */
function addRequests(api: Hono<AdminApiEnv>): void {
  api.get('/requests', (context) => context.json(requestsSnapshot()))
  api.get('/requests/stream', (context) =>
    streamSSE(context, async (stream) => {
      let changed = true
      const mark = (): void => {
        changed = true
      }
      const unsubscribe = [
        onHttpRequestsChange(mark),
        onActiveRequestsChange(mark),
        onConsoleEventsChange(mark)
      ]
      let close = (): void => undefined
      // The executor form: `Promise.withResolvers` is past this project's TypeScript lib.
      const closed = new Promise<void>((resolve) => {
        close = resolve
      })
      const flush = setInterval(() => {
        if (!changed) return
        changed = false
        stream
          .writeSSE({ event: 'requests', data: JSON.stringify(requestsSnapshot()) })
          .catch(close)
      }, STREAM_FLUSH_MS)
      const heartbeat = setInterval(() => {
        stream.write(': heartbeat\n\n').catch(close)
      }, STREAM_HEARTBEAT_MS)
      stream.onAbort(close)
      await closed
      clearInterval(flush)
      clearInterval(heartbeat)
      for (const stop of unsubscribe) stop()
    })
  )
}

/**
 * Adds the page routes: accounts, models, stats and the doctor.
 *
 * @param api - the API app
 * @param deps - what the API reads with
 */
function addPages(api: Hono<AdminApiEnv>, deps: AdminApiDeps): void {
  const usage = createUsageAnswer(deps.server.statsEnabled)

  api.get('/accounts', async (context) => context.json(await accountsSnapshot(deps.now())))

  api.get('/models', async (context) => {
    const models = await modelsSnapshot()
    return 'unavailable' in models
      ? context.json(
          { error: { code: 'exposure_invalid', message: models.unavailable } },
          HTTP_SERVICE_UNAVAILABLE
        )
      : context.json(models)
  })

  api.get('/stats', (context) => {
    const answer = usage(context.req.query('window'), deps.now())
    return context.json(answer.body, answer.status)
  })

  api.get('/status', async (context) => {
    const now = deps.now()
    const today = usage('today', now)
    const cost =
      today.status === HTTP_OK
        ? today.body.models.reduce((total, model) => total + model.cost_usd, 0)
        : null
    return context.json(await statusSnapshot(deps.server, cost, now))
  })

  api.get('/doctor', async (context) => {
    const window = windowOf(context.req.query('window'))
    if (window === undefined) return context.json(BAD_WINDOW, HTTP_BAD_REQUEST)
    return context.json(await doctorSnapshot(deps.server, window, deps.now()))
  })
}

/**
 * Creates the API, to mount at `/admin/api`.
 *
 * @param deps - what it reads with
 * @returns the API app
 */
export function createAdminApi(deps: AdminApiDeps): Hono<AdminApiEnv> {
  const api = new Hono<AdminApiEnv>()
  api.use('*', async (context, next) => {
    const session = deps.sessionOf(context.req.header('cookie'))
    if (session === undefined) return context.json(NOT_SIGNED_IN, HTTP_UNAUTHORIZED)
    context.set('session', session)
    await next()
    return undefined
  })
  api.onError((error, context) => {
    adminLogger.error('Admin read {path} failed: {error}', {
      path: context.req.path,
      error: errorMessage(error)
    })
    return context.json(
      { error: { code: 'read_failed', message: 'The proxy could not read this; see its log' } },
      HTTP_SERVICE_UNAVAILABLE
    )
  })
  api.get('/session', (context) => {
    const { login, role } = context.get('session')
    return context.json({ login, role })
  })
  addRequests(api)
  addPages(api, deps)
  return api
}
