/**
 * A request no route matches, or one the proxy fails on, gets OpenAI's error shape, not Hono's
 * plain text (#133, constitution principle I). A 404 names the method and path as OpenAI's own
 * "Invalid URL" error does; a failure inside the proxy answers 500 with fixed text.
 */

import { createApp } from '@proxy/server/app'
import { describe, expect, test } from 'vite-plus/test'

import { isErrorBody, jsonBody, testApp, testConfig } from '../helpers'

const HTTP_UNAUTHORIZED = 401
const HTTP_NOT_FOUND = 404
const PROXY_TOKEN = 'notarealsecret-unknown-routes-token'
const HTTP_INTERNAL_SERVER_ERROR = 500
/** What the failing exposure reader throws: it must reach the log, never the client. */
const THROWN_DETAIL = 'cannot read /home/someone/.pi/agent/proxy-config.json'

describe('a request no route matches', () => {
  // Catches the plain-text fallback: a client parsing the body as JSON fails on it, and an
  // OpenAI SDK reports a parse error instead of the 404.
  test.each([
    ['GET', '/v1/responses'],
    ['POST', '/v1/responses'],
    ['GET', '/v1/pi/models'],
    ['GET', '/v1/chat/completion'],
    ['GET', '/v1/chat/completions'],
    ['DELETE', '/v1/models'],
    ['GET', '/nope'],
    ['GET', '/healthz/nope']
  ])('%s %s answers 404 with an OpenAI error naming it', async (method, path) => {
    const response = await testApp().request(path, { method })
    const body = await jsonBody(response)

    expect(response.status).toBe(HTTP_NOT_FOUND)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(isErrorBody(body) ? body.error : undefined).toEqual({
      message: `Invalid URL (${method} ${path})`,
      type: 'invalid_request_error',
      param: null,
      code: null
    })
  })

  // Catches the fallback answering before proxy auth: an unauthenticated caller could map which
  // /v1 paths exist.
  test('under /v1 with proxy auth on, needs the token first', async () => {
    const app = testApp({ ...testConfig(), proxyAuth: { kind: 'token', token: PROXY_TOKEN } })

    const without = await app.request('/v1/responses')
    const withToken = await app.request('/v1/responses', {
      headers: { Authorization: `Bearer ${PROXY_TOKEN}` }
    })

    expect([without.status, withToken.status]).toEqual([HTTP_UNAUTHORIZED, HTTP_NOT_FOUND])
  })
})

describe('a failure inside the proxy', () => {
  // Catches Hono's plain-text `500 Internal Server Error` (which an OpenAI SDK reports as a parse
  // error) and a handler that echoes the thrown message, which can quote a path or a config value.
  test.each([
    ['GET', '/v1/models'],
    ['POST', '/v1/chat/completions']
  ])('%s %s answers 500 with a fixed OpenAI error', async (method, path) => {
    const app = createApp(testConfig(), () => {
      throw new Error(THROWN_DETAIL)
    })

    const response = await app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(method === 'POST'
        ? {
            body: JSON.stringify({
              model: 'any/model',
              messages: [{ role: 'user', content: 'hi' }]
            })
          }
        : {})
    })
    const body = await jsonBody(response)

    expect(response.status).toBe(HTTP_INTERNAL_SERVER_ERROR)
    expect(isErrorBody(body) ? body.error : undefined).toEqual({
      message: 'Internal proxy error; see the proxy log',
      type: 'server_error',
      param: null,
      code: 'internal_error'
    })
    expect(JSON.stringify(body)).not.toContain(THROWN_DETAIL)
  })
})
