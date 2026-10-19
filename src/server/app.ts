/**
 * Hono application assembly: global middleware, proxy auth and routes.
 *
 * @packageDocumentation
 */

import { swaggerUI } from '@hono/swagger-ui'
import type { ServerConfig } from '@proxy/config/env'
import { proxyLogger } from '@proxy/logging'
import type { RemoteImageFetchOptions } from '@proxy/openai/remote-image-fetch'
import { createHealthRoutes } from '@proxy/server/health'
import {
  bodySizeLimitMiddleware,
  disconnectMiddleware,
  proxyAuthMiddleware,
  requestIdMiddleware
} from '@proxy/server/middleware'
import { DOCS_PATH, OPENAPI_OPTIONS, OPENAPI_PATH, SWAGGER_UI_VERSION } from '@proxy/server/openapi'
import { createRoutes, type ExposureConfigReader, fileConfigReader } from '@proxy/server/routes'
import type { ProxyEnv } from '@proxy/server/types'
import { Hono } from 'hono'
import { openAPIRouteHandler } from 'hono-openapi'

/** Logger for server lifecycle events. */
const lifecycleLogger = proxyLogger('server')

/**
 * Builds the proxy's Hono app: request ID, disconnect and body size middleware on every path,
 * the OpenAPI document (and the docs UI when on), proxy auth on `/v1/*` and the
 * `/healthz/<check>` detail endpoints, then the health and OpenAI routes.
 *
 * @remarks
 * Three paths skip proxy auth: `GET /healthz`, so liveness probes need no token, and the OpenAPI
 * document and docs page, which name routes and schemas but no model, provider or credential
 * (#129). They are registered before the auth middleware, so they answer before it runs.
 *
 * @param config - the server config: proxy auth mode, body size limit, upstream timeout, remote
 *   images, docs UI
 * @param configReader - where the model exposure config comes from; `undefined` reads the config
 *   file and pi's settings on each request ({@link fileConfigReader})
 * @param remoteImageFetch - how remote images are fetched when `remoteImagesEnabled` is on;
 *   `undefined` is the strict production policy. Only tests pass another, to reach a local server
 * @returns the assembled app, ready to serve
 */
export function createApp(
  config: ServerConfig,
  configReader?: ExposureConfigReader,
  remoteImageFetch?: RemoteImageFetchOptions
): Hono<ProxyEnv> {
  const app = new Hono<ProxyEnv>()

  // Global middleware
  app.use('*', requestIdMiddleware())
  app.use('*', disconnectMiddleware())
  app.use('*', bodySizeLimitMiddleware(config))

  // The OpenAPI document and the docs UI, open like `/healthz`: registered before proxy auth.
  // The document is built from the routes once, on its first request.
  app.get(OPENAPI_PATH, openAPIRouteHandler(app, OPENAPI_OPTIONS))
  if (config.docsUiEnabled) {
    app.get(DOCS_PATH, swaggerUI({ url: OPENAPI_PATH, version: SWAGGER_UI_VERSION }))
  }

  app.use('/v1/*', proxyAuthMiddleware(config))
  // `/healthz` itself stays open for liveness probes; its detail endpoints name providers and
  // models. Not `/healthz/*`: Hono's wildcard also matches the bare `/healthz`.
  app.use('/healthz/:check{.+}', proxyAuthMiddleware(config))

  // Routes
  app.route('/', createHealthRoutes(configReader ?? fileConfigReader))
  app.route('/', createRoutes(config, configReader, remoteImageFetch))

  lifecycleLogger.debug(
    'App wired: proxy auth {authMode}, exposure config from {exposureSource}, docs UI {docsUi}',
    {
      authMode: config.proxyAuth.kind,
      exposureSource: configReader === undefined ? 'config file' : 'custom reader',
      docsUi: config.docsUiEnabled ? 'on' : 'off'
    }
  )
  return app
}
