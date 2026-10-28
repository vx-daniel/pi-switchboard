/**
 * Hono application assembly: global middleware, proxy auth and routes.
 *
 * @packageDocumentation
 */

import { swaggerUI } from '@hono/swagger-ui'
import type { ServerConfig } from '@proxy/config/env'
import { proxyLogger } from '@proxy/logging'
import type { RemoteImageFetchOptions } from '@proxy/openai/remote-image-fetch'
import { internalError, invalidRequest } from '@proxy/server/errors'
import { createHealthRoutes } from '@proxy/server/health'
import { hostOriginGuardMiddleware } from '@proxy/server/host-origin-guard'
import { requestLogMiddleware } from '@proxy/server/http-requests'
import { HTTP_INTERNAL_SERVER_ERROR, HTTP_NOT_FOUND } from '@proxy/server/http-status'
import {
  bodySizeLimitMiddleware,
  disconnectMiddleware,
  proxyAuthMiddleware,
  rejectedChatMiddleware,
  requestIdMiddleware,
  upstreamKeyHeaderMiddleware
} from '@proxy/server/middleware'
import {
  DOCS_PATH,
  docsPageDescription,
  OPENAPI_OPTIONS,
  OPENAPI_PATH,
  openAPIDocumentDescription,
  SWAGGER_UI_VERSION
} from '@proxy/server/openapi'
import { createProxyAuthSwitch, type ProxyAuthSwitch } from '@proxy/server/proxy-auth'
import { createRoutes, type ExposureConfigReader, fileConfigReader } from '@proxy/server/routes'
import type { ProxyEnv } from '@proxy/server/types'
import { errorCode, errorMessage } from '@proxy/utils/guards'
import { Hono } from 'hono'
import { describeRoute, openAPIRouteHandler } from 'hono-openapi'
import { HTTPException } from 'hono/http-exception'

/** Logger for server lifecycle events. */
const lifecycleLogger = proxyLogger('server')
/** Logger for requests no route matches. */
const httpLogger = proxyLogger('server', 'http')

/**
 * Builds the proxy's Hono app: request ID, disconnect and body size middleware on every path,
 * the OpenAPI document and the docs page, proxy auth on `/v1/*` and the `/healthz/<check>` detail
 * endpoints, then the health and OpenAI routes, and an OpenAI-style 404 for anything else.
 *
 * @remarks
 * Three paths skip proxy auth: `GET /healthz`, so liveness probes need no token, and the OpenAPI
 * document and docs page (`/docs`), which name routes and schemas but no model, provider or
 * credential (#129). The document is registered before the auth middleware, so it answers before
 * that runs; `/docs` is outside `/v1`. The docs route is always registered, so the document is
 * the same whatever the config; with `docsUi` off it answers 404.
 *
 * @param config - the server config: proxy auth mode, the host/origin guard, body size limit,
 *   upstream timeout, remote images, docs UI
 * @param configReader - where the model exposure config comes from; `undefined` reads the config
 *   file and pi's settings on each request ({@link fileConfigReader})
 * @param remoteImageFetch - how remote images are fetched when `remoteImagesEnabled` is on;
 *   `undefined` is the strict production policy. Only tests pass another, to reach a local server
 * @param proxyAuth - the proxy auth the app applies, read on every request; by default one made
 *   from `config.proxyAuth`. The console passes its own, to change auth without a restart
 * @returns the assembled app, ready to serve
 */
export function createApp(
  config: ServerConfig,
  configReader?: ExposureConfigReader,
  remoteImageFetch?: RemoteImageFetchOptions,
  proxyAuth: ProxyAuthSwitch = createProxyAuthSwitch(config.proxyAuth)
): Hono<ProxyEnv> {
  const app = new Hono<ProxyEnv>()

  // Global middleware
  app.use('*', requestIdMiddleware())
  // After the request ID, which it reads; ahead of proxy auth, so a request it turns away is listed.
  app.use('*', requestLogMiddleware())
  app.use('*', disconnectMiddleware())
  // Ahead of the body size limit and proxy auth, so a chat request they turn away is recorded too.
  app.use('/v1/chat/completions', rejectedChatMiddleware())
  app.use('/v1/responses', rejectedChatMiddleware())
  // The host/origin guard (#188), when on: after the request log and the rejected-chat record, so
  // a refusal is listed; ahead of the body and proxy auth, so it never depends on a token being
  // set. Every path, `/healthz` and the docs page included.
  if (config.hostOriginGuardEnabled) app.use('*', hostOriginGuardMiddleware())
  app.use('*', bodySizeLimitMiddleware(config))

  // The OpenAPI document and the docs page, open like `/healthz`: registered before proxy auth.
  // The document is built from the routes once, on its first request.
  app.get(
    OPENAPI_PATH,
    describeRoute(openAPIDocumentDescription),
    openAPIRouteHandler(app, OPENAPI_OPTIONS)
  )
  if (config.docsUiEnabled) {
    app.get(
      DOCS_PATH,
      describeRoute(docsPageDescription),
      swaggerUI({ url: OPENAPI_PATH, version: SWAGGER_UI_VERSION })
    )
  } else {
    // Still registered and described, so the document does not depend on the config.
    app.get(DOCS_PATH, describeRoute(docsPageDescription), (context) =>
      context.json(
        invalidRequest('The docs page is off; turn on docsUi (--docs-ui, PI_SWITCHBOARD_DOCS_UI)'),
        HTTP_NOT_FOUND
      )
    )
  }

  const authMiddleware = proxyAuthMiddleware(proxyAuth)
  app.use('/v1/*', authMiddleware)
  // The upstream key header (old name #65, empty #207), on the routes that read the key, after
  // proxy auth: an unauthenticated caller gets the 401 first, and probes of the open paths are
  // not affected.
  app.use('/v1/chat/completions', upstreamKeyHeaderMiddleware())
  app.use('/v1/responses', upstreamKeyHeaderMiddleware())
  // `/healthz` itself stays open for liveness probes; its detail endpoints name providers and
  // models. Not `/healthz/*`: Hono's wildcard also matches the bare `/healthz`.
  app.use('/healthz/:check{.+}', authMiddleware)

  // Routes
  app.route('/', createHealthRoutes(configReader ?? fileConfigReader))
  app.route('/', createRoutes(config, configReader, remoteImageFetch))

  // Anything no route matches, a known path with another method included: OpenAI's error shape
  // and its "Invalid URL" wording, not Hono's plain text (#133). At debug: the request log line
  // already records the 404, and scanners would flood a warning.
  app.notFound((context) => {
    const { method, path } = context.req
    httpLogger.debug('No route for {method} {path}', { method, path })
    return context.json(invalidRequest(`Invalid URL (${method} ${path})`), HTTP_NOT_FOUND)
  })

  // Anything a handler or middleware throws, in OpenAI's error shape instead of Hono's plain text
  // (and without Hono's `console.error`). Hono's own exceptions carry a client error and a fixed
  // message: `validator('json')` throws "Malformed JSON in request body" (400). Anything else is
  // the proxy's fault, answered 500 with fixed text; the thrown message, which can quote a path or
  // a config value, goes to the log at debug only.
  app.onError((error, context) => {
    const { method, path } = context.req
    if (error instanceof HTTPException && error.status < HTTP_INTERNAL_SERVER_ERROR) {
      httpLogger.warn('Rejected {method} {path}: {reason}', { method, path, reason: error.message })
      return context.json(invalidRequest(error.message), error.status)
    }
    httpLogger.error('{method} {path} failed inside the proxy: {error}', {
      method,
      path,
      error: errorCode(error)
    })
    httpLogger.debug('Internal error detail: {detail}', {
      detail: errorMessage(error)
    })
    return context.json(internalError(), HTTP_INTERNAL_SERVER_ERROR)
  })

  lifecycleLogger.debug(
    'App wired: proxy auth {authMode}, exposure config from {exposureSource}, docs UI {docsUi}',
    {
      authMode: proxyAuth.current().kind,
      exposureSource: configReader === undefined ? 'config file' : 'custom reader',
      docsUi: config.docsUiEnabled ? 'on' : 'off'
    }
  )
  return app
}
