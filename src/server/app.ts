/**
 * Hono application assembly: global middleware, proxy auth and routes.
 *
 * @packageDocumentation
 */

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
import { createRoutes, type ExposureConfigReader, fileConfigReader } from '@proxy/server/routes'
import type { ProxyEnv } from '@proxy/server/types'
import { Hono } from 'hono'

/** Logger for server lifecycle events. */
const lifecycleLogger = proxyLogger('server')

/**
 * Builds the proxy's Hono app: request ID, disconnect and body size middleware on every path,
 * proxy auth on `/v1/*` and the `/healthz/<check>` detail endpoints, then the health and OpenAI
 * routes.
 *
 * @remarks
 * Only `GET /healthz` skips proxy auth, so liveness probes need no token.
 *
 * @param config - the server config: proxy auth mode, body size limit, upstream timeout, remote
 *   images
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
  app.use('/v1/*', proxyAuthMiddleware(config))
  // `/healthz` itself stays open for liveness probes; its detail endpoints name providers and
  // models. Not `/healthz/*`: Hono's wildcard also matches the bare `/healthz`.
  app.use('/healthz/:check{.+}', proxyAuthMiddleware(config))

  // Routes
  app.route('/', createHealthRoutes(configReader ?? fileConfigReader))
  app.route('/', createRoutes(config, configReader, remoteImageFetch))

  lifecycleLogger.debug('App wired: proxy auth {authMode}, exposure config from {exposureSource}', {
    authMode: config.proxyAuth.kind,
    exposureSource: configReader === undefined ? 'config file' : 'custom reader'
  })
  return app
}
