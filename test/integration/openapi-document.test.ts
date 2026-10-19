/**
 * The proxy's own OpenAPI document (#129): the committed `openapi.json` is what the routes
 * describe, the document is served without proxy auth, and the docs page only when it is on.
 *
 * `openapi.json` is a file snapshot: after a deliberate contract change, `vp test -u` rewrites it,
 * and the diff shows the change in review.
 */

import { OPENAPI_OPTIONS, SWAGGER_UI_VERSION } from '@proxy/server/openapi'
import { generateSpecs } from 'hono-openapi'
import { describe, expect, test } from 'vite-plus/test'

import { jsonBody, testApp, testConfig } from '../helpers'

const HTTP_OK = 200
const HTTP_UNAUTHORIZED = 401
const HTTP_NOT_FOUND = 404
const PROXY_TOKEN = 'notarealsecret-openapi-token'

/** An app with proxy auth on, to check what skips it. */
const authApp = testApp({ ...testConfig(), proxyAuth: { kind: 'token', token: PROXY_TOKEN } })

describe('the OpenAPI document', () => {
  // Catches a route, field, status or description changed without the committed document: the
  // contract would move with nothing in the diff to review.
  test('the routes produce the committed openapi.json', async () => {
    const document = await generateSpecs(testApp(), OPENAPI_OPTIONS)

    await expect(`${JSON.stringify(document, null, 2)}\n`).toMatchFileSnapshot('../../openapi.json')
  })

  // Catches the document routes drifting from the routes the proxy serves: a stable route left
  // undocumented, or a health or unsupported-endpoint route documented as if it worked.
  test('documents the stable routes and the switchboard models route, and nothing else', async () => {
    const document = await generateSpecs(testApp(), OPENAPI_OPTIONS)

    expect(
      Object.entries(document.paths).flatMap(([path, item]) =>
        Object.keys(item).map((method) => `${method.toUpperCase()} ${path}`)
      )
    ).toEqual([
      'GET /v1/models',
      'GET /v1/switchboard/models',
      'GET /v1/models/{model}',
      'POST /v1/chat/completions'
    ])
  })

  // Catches the document mounted behind proxy auth, which a client needs before it has a token,
  // or served as something other than the document the routes produce.
  test('is served at /v1/switchboard/openapi.json without proxy auth', async () => {
    const response = await authApp.request('/v1/switchboard/openapi.json')

    expect(response.status).toBe(HTTP_OK)
    expect(await jsonBody(response)).toEqual(
      JSON.parse(JSON.stringify(await generateSpecs(testApp(), OPENAPI_OPTIONS)))
    )
  })

  // Catches opening the document route opening the rest: the routes it describes still need the
  // token.
  test('leaves the described routes behind proxy auth', async () => {
    const response = await authApp.request('/v1/switchboard/models')

    expect(response.status).toBe(HTTP_UNAUTHORIZED)
  })
})

describe('the docs page', () => {
  // Catches the page served by default: it loads scripts from a CDN, so it is opt-in.
  test('is not served unless docsUi is on', async () => {
    const response = await testApp().request('/v1/switchboard/docs')

    expect(response.status).toBe(HTTP_NOT_FOUND)
  })

  // Catches the page behind proxy auth (a browser cannot send the token to open it), pointed at
  // another document, or loading an unpinned Swagger UI.
  test('when on, is served without proxy auth, for the document, with the pinned Swagger UI', async () => {
    const app = testApp({
      ...testConfig(),
      docsUiEnabled: true,
      proxyAuth: { kind: 'token', token: PROXY_TOKEN }
    })

    const response = await app.request('/v1/switchboard/docs')
    const html = await response.text()

    expect(response.status).toBe(HTTP_OK)
    expect(html).toContain("url: '/v1/switchboard/openapi.json'")
    expect(html).toContain(`swagger-ui-dist@${SWAGGER_UI_VERSION}/swagger-ui-bundle.js`)
  })
})
