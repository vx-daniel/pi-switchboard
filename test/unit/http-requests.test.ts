import { FINISHED_KEPT, REJECTED_KEPT } from '@proxy/server/active-requests'
import {
  beginHttpRequest,
  endHttpRequest,
  httpRequests,
  onHttpRequestsChange,
  requestLogMiddleware
} from '@proxy/server/http-requests'
import { requestIdMiddleware } from '@proxy/server/middleware'
import type { ProxyEnv } from '@proxy/server/types'
import { Hono } from 'hono'
import { describe, expect, test } from 'vite-plus/test'

/**
 * Builds an app with the request ID and request log middleware, as the proxy registers them, and
 * a few routes: one that answers, one that refuses, one that throws, and the health checks.
 *
 * @returns the app
 */
function loggedApp(): Hono<ProxyEnv> {
  const app = new Hono<ProxyEnv>()
  app.use('*', requestIdMiddleware())
  app.use('*', requestLogMiddleware())
  app.get('/ok', (context) => context.text('ok'))
  app.get('/refused', (context) => context.text('no', 400))
  app.get('/broken', () => {
    throw new Error('the handler failed')
  })
  app.get('/healthz', (context) => context.text('ok'))
  app.get('/healthz/models', (context) => context.text('down', 503))
  return app
}

/**
 * Sends a request to the app and finds what the registry kept for it.
 *
 * @param app - the app
 * @param path - the path to request, with any query
 * @returns the entry kept, or `undefined` when none was
 */
async function sentAndKept(
  app: Hono<ProxyEnv>,
  path: string
): Promise<ReturnType<typeof httpRequests>[number] | undefined> {
  const response = await app.request(path)
  const requestId = response.headers.get('x-request-id')
  return httpRequests().find((request) => request.requestId === requestId)
}

describe('the HTTP requests kept for the console', () => {
  // Catches a route's request missing from the table, or recorded with the wrong status or method.
  test('records each request with its method, path and status', async () => {
    const app = loggedApp()

    expect(await sentAndKept(app, '/ok')).toMatchObject({
      method: 'GET',
      path: '/ok',
      status: 200
    })
    expect(await sentAndKept(app, '/refused')).toMatchObject({ status: 400 })
  })

  // Catches a secret a caller put in the query (`?key=…`) kept in memory and shown on screen.
  test('keeps the path without its query', async () => {
    expect(await sentAndKept(loggedApp(), '/ok?key=sk-not-a-real-key')).toMatchObject({
      path: '/ok'
    })
  })

  // Catches a request whose handler throws left in flight for good.
  test('ends a request whose handler throws, with its error status', async () => {
    const kept = await sentAndKept(loggedApp(), '/broken')

    expect(kept?.status).toBe(500)
    expect(kept?.endedAt).toBeTypeOf('number')
  })

  // Catches a monitor polling `/healthz` every few seconds filling the table, or a failing health
  // check hidden with the polls.
  test('leaves out a health check answered with a 2xx, and keeps a failed one', async () => {
    const app = loggedApp()

    expect(await sentAndKept(app, '/healthz')).toBeUndefined()
    expect(await sentAndKept(app, '/healthz/models')).toMatchObject({ status: 503 })
  })

  // Catches memory that grows with every request a long-running proxy answers, or a flood of
  // unauthenticated requests (anyone who can reach the port) pushing out the ones that did
  // something.
  test('keeps client errors apart, each list up to its own bound, oldest dropped first', () => {
    const served = beginHttpRequest({ requestId: 'kept-served', method: 'POST', path: '/v1/x' })
    endHttpRequest(served, 200)
    for (let requestIndex = 0; requestIndex <= REJECTED_KEPT; requestIndex += 1) {
      const sequence = beginHttpRequest({
        requestId: `flood-${String(requestIndex)}`,
        method: 'POST',
        path: '/v1/x'
      })
      endHttpRequest(sequence, 401)
    }

    const kept = httpRequests()
    const flood = kept.filter((request) => request.requestId.startsWith('flood-'))
    expect(flood).toHaveLength(REJECTED_KEPT)
    expect(flood[0]?.requestId).toBe('flood-1')
    expect(kept.some((request) => request.requestId === 'kept-served')).toBe(true)

    for (let requestIndex = 0; requestIndex <= FINISHED_KEPT; requestIndex += 1) {
      const sequence = beginHttpRequest({
        requestId: `served-${String(requestIndex)}`,
        method: 'GET',
        path: '/v1/models'
      })
      endHttpRequest(sequence, 200)
    }
    const answered = httpRequests().filter((request) => request.status === 200)
    expect(answered).toHaveLength(FINISHED_KEPT)
    expect(answered[0]?.requestId).toBe('served-1')
  })

  // Catches a request in flight missing from the table, or listed after ones that came later.
  test('lists a request in flight in the order it arrived, and tells the listeners', () => {
    let changes = 0
    const unsubscribe = onHttpRequestsChange(() => {
      changes += 1
    })
    const first = beginHttpRequest({ requestId: 'slow', method: 'POST', path: '/v1/x' }, 1000)
    const second = beginHttpRequest({ requestId: 'fast', method: 'GET', path: '/v1/y' }, 2000)
    endHttpRequest(second, 200, 2100)

    const ordered = httpRequests().filter(({ requestId }) => ['slow', 'fast'].includes(requestId))
    expect(ordered.map(({ requestId, status }) => [requestId, status])).toEqual([
      ['slow', undefined],
      ['fast', 200]
    ])
    endHttpRequest(first, 200, 3000)
    unsubscribe()
    expect(changes).toBe(4)
  })
})
