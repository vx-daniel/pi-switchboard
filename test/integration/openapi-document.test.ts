/**
 * The proxy's own OpenAPI document (#129): the committed `openapi.json` is what the routes
 * describe, it describes every route the proxy serves, the document is served without proxy auth,
 * and the docs page (`/docs`) only when it is on.
 *
 * `openapi.json` is a file snapshot: after a deliberate contract change, `vp test -u` rewrites it,
 * and the diff shows the change in review.
 */

import { OPENAPI_OPTIONS, SWAGGER_UI_VERSION, UNSUPPORTED_ENDPOINTS } from '@proxy/server/openapi'
import type { ProxyEnv } from '@proxy/server/types'
import { isRecord } from '@proxy/utils/guards'
import { Ajv2020 } from 'ajv/dist/2020'
import type { Hono } from 'hono'
import { generateSpecs } from 'hono-openapi'
import { describe, expect, test } from 'vite-plus/test'

import { isErrorBody, jsonBody, testApp, testConfig } from '../helpers'

const HTTP_OK = 200
const HTTP_UNAUTHORIZED = 401
const HTTP_NOT_FOUND = 404
const PROXY_TOKEN = 'notarealsecret-openapi-token'
/** The route that answers `/v1/models/` (no ID) with a 404; not an operation of its own. */
const MODEL_DETAIL_WITHOUT_ID = '/v1/models/'

/** An app with proxy auth on, to check what skips it. */
const authApp = testApp({ ...testConfig(), proxyAuth: { kind: 'token', token: PROXY_TOKEN } })

/**
 * Lists the routes an app serves, as `<METHOD> <OpenAPI path>`: Hono's `:name{…}` becomes
 * `{name}`, a trailing `/*` becomes `/{path}`, and an unsupported endpoint (`ALL`) is `GET` and
 * `POST`, as the document gives it. Middleware (`app.use`) is left out.
 *
 * @param app - the app
 * @returns the routes, sorted, each once (a described route is registered twice: the
 *   description, then the handler)
 */
function servedRoutes(app: Hono<ProxyEnv>): string[] {
  const unsupported: readonly string[] = UNSUPPORTED_ENDPOINTS
  const routes = app.routes
    .filter((route) => route.path !== MODEL_DETAIL_WITHOUT_ID)
    .filter((route) => route.method !== 'ALL' || unsupported.includes(route.path))
    .flatMap((route) => {
      const path = route.path.replace(/:(\w+)\{[^}]*\}/g, '{$1}').replace(/\/\*$/, '/{path}')
      const methods = route.method === 'ALL' ? ['GET', 'POST'] : [route.method]
      return methods.map((method) => `${method} ${path}`)
    })
  return [...new Set(routes)].toSorted()
}

/**
 * Lists the operations a document describes, as `<METHOD> <path>`.
 *
 * @param document - the OpenAPI document
 * @returns the operations, sorted
 */
function documentedRoutes(document: {
  readonly paths: Readonly<Record<string, object>>
}): string[] {
  return Object.entries(document.paths)
    .flatMap(([path, item]) =>
      Object.keys(item)
        .filter((key) => key !== 'parameters')
        .map((method) => `${method.toUpperCase()} ${path}`)
    )
    .toSorted()
}

/**
 * Collects every JSON Schema in a document: the components' schemas, and each `schema` under a
 * path (parameters, request and response bodies).
 *
 * @param node - the document, or a part of it
 * @param found - where the schemas go; written to
 * @returns `found`
 */
function schemasIn(node: unknown, found: unknown[] = []): unknown[] {
  if (Array.isArray(node)) {
    for (const element of node) schemasIn(element, found)
    return found
  }
  if (!isRecord(node)) return found
  for (const [field, child] of Object.entries(node)) {
    if (field === 'schema') found.push(child)
    else schemasIn(child, found)
  }
  return found
}

/**
 * Lists the operations that sit behind proxy auth (no `security: []`) but don't document a 401.
 *
 * @param document - the OpenAPI document
 * @returns `<METHOD> <path>` for each
 */
function authedWithout401(document: unknown): string[] {
  const paths = isRecord(document) && isRecord(document['paths']) ? document['paths'] : {}
  return Object.entries(paths).flatMap(([path, item]) =>
    Object.entries(isRecord(item) ? item : {})
      .filter(([method]) => method !== 'parameters')
      .filter(([, operation]) => {
        if (!isRecord(operation)) return false
        const open = Array.isArray(operation['security']) && operation['security'].length === 0
        const responses = isRecord(operation['responses']) ? operation['responses'] : {}
        return !open && !('401' in responses)
      })
      .map(([method]) => `${method.toUpperCase()} ${path}`)
  )
}

describe('the OpenAPI document', () => {
  // Catches a route, field, status or description changed without the committed document: the
  // contract would move with nothing in the diff to review.
  test('the routes produce the committed openapi.json', async () => {
    const document = await generateSpecs(testApp(), OPENAPI_OPTIONS)

    await expect(`${JSON.stringify(document, null, 2)}\n`).toMatchFileSnapshot('../../openapi.json')
  })

  // Catches a schema that is not valid JSON Schema 2020-12, such as `prefixItems: []` from
  // `z.tuple([])`: schema-driven tools (Schemathesis, client generators) refuse the routes that
  // use it, as they refused chat completions and the Responses API (#207).
  test('holds only valid JSON Schema', async () => {
    const document = await generateSpecs(testApp(), OPENAPI_OPTIONS)
    const ajv = new Ajv2020({ strict: false, validateFormats: false, logger: false })
    const invalid = schemasIn(JSON.parse(JSON.stringify(document))).filter(
      (schema) => isRecord(schema) && ajv.validateSchema(schema) !== true
    )

    expect(invalid).toEqual([])
  })

  // Catches a route behind proxy auth whose 401 is not documented, so a client generated from
  // the document doesn't expect it (the unsupported endpoints, #207).
  test('documents the 401 of every route behind proxy auth', async () => {
    const document = await generateSpecs(testApp(), OPENAPI_OPTIONS)

    expect(authedWithout401(JSON.parse(JSON.stringify(document)))).toEqual([])
  })

  // Catches a route added without a description (hono-openapi leaves it out silently), or one
  // documented that the proxy does not serve.
  test('describes every route the proxy serves, and only those', async () => {
    const app = testApp()

    expect(documentedRoutes(await generateSpecs(app, OPENAPI_OPTIONS))).toEqual(servedRoutes(app))
  })

  // Catches the document changing with the config: the committed one is made with the docs page
  // off, and a server with it on must serve the same document.
  test('is the same with the docs page on or off', async () => {
    const docsOn = testApp({ ...testConfig(), docsUiEnabled: true })

    expect(await generateSpecs(docsOn, OPENAPI_OPTIONS)).toEqual(
      await generateSpecs(testApp(), OPENAPI_OPTIONS)
    )
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
  // Catches the page served by default (it loads scripts from a CDN, so it is opt-in), or the
  // off answer in Hono's plain text rather than OpenAI's error shape.
  test('answers an OpenAI-style 404 unless docsUi is on', async () => {
    const response = await testApp().request('/docs')

    expect(response.status).toBe(HTTP_NOT_FOUND)
    expect(isErrorBody(await jsonBody(response))).toBe(true)
  })

  // Catches the page behind proxy auth (a browser cannot send the token to open it), pointed at
  // another document, or loading an unpinned Swagger UI.
  test('when on, is served without proxy auth, for the document, with the pinned Swagger UI', async () => {
    const app = testApp({
      ...testConfig(),
      docsUiEnabled: true,
      proxyAuth: { kind: 'token', token: PROXY_TOKEN }
    })

    const response = await app.request('/docs')
    const html = await response.text()

    expect(response.status).toBe(HTTP_OK)
    expect(html).toContain("url: '/v1/switchboard/openapi.json'")
    expect(html).toContain(`swagger-ui-dist@${SWAGGER_UI_VERSION}/swagger-ui-bundle.js`)
  })
})
