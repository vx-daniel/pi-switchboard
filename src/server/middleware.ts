/**
 * Hono middleware: request IDs and request logging, client disconnect detection, proxy auth, body
 * size limits.
 *
 * @packageDocumentation
 */

import { withContext } from '@logtape/logtape'
import type { ServerConfig } from '@proxy/config/env'
import { proxyLogger } from '@proxy/logging'
import { authenticationError, invalidRequest } from '@proxy/server/errors'
import {
  HTTP_MULTIPLE_CHOICES,
  HTTP_PAYLOAD_TOO_LARGE,
  HTTP_UNAUTHORIZED
} from '@proxy/server/http-status'
import { generateRequestId } from '@proxy/server/request-id'
import type { ProxyEnv } from '@proxy/server/types'
import type { MiddlewareHandler } from 'hono'

/** Logger for request and response lines. */
const httpLogger = proxyLogger('server', 'http')
/** Logger for proxy auth decisions. */
const authLogger = proxyLogger('server', 'auth')

/** The scheme prefix of an `Authorization` header that carries a bearer token. */
const BEARER_PREFIX = 'Bearer '
/** The liveness path; it and the paths below it are logged as polling. */
const HEALTH_PATH = '/healthz'

/**
 * Creates the middleware that sets the request's IDs and upstream API key, and logs the request
 * and its response.
 *
 * @remarks
 * Sets `requestId` (new), `clientRequestId` (`X-Client-Request-Id`) and `upstreamApiKey`
 * (`X-Pi-Upstream-Api-Key`), and echoes `X-Request-Id` and `X-Client-Request-Id` on the response.
 * Everything downstream runs inside `withContext({ requestId, clientRequestId })`, so every log
 * line a request causes carries its IDs without passing them around.
 *
 * @returns the middleware
 */
export function requestIdMiddleware(): MiddlewareHandler<ProxyEnv> {
  return async (context, next) => {
    const requestId = generateRequestId()
    const clientRequestId = context.req.header('x-client-request-id')
    const upstreamApiKey = context.req.header('x-pi-upstream-api-key')
    const start = performance.now()

    context.set('requestId', requestId)
    context.set('clientRequestId', clientRequestId)
    context.set('upstreamApiKey', upstreamApiKey)

    // Set response headers
    context.header('x-request-id', requestId)
    if (clientRequestId !== undefined) {
      context.header('x-client-request-id', clientRequestId)
    }

    const { method, path } = context.req
    // Health endpoints are what container healthchecks and monitors poll, often every few seconds:
    // their lines go to debug, except an answer that is not 2xx, which stays at info. At info, a
    // failed check therefore shows only its "answered" line: the request line was decided before
    // the status was known, and the answer line carries the same method, path and request id.
    const polling = path === HEALTH_PATH || path.startsWith(`${HEALTH_PATH}/`)
    await withContext({ requestId, clientRequestId }, async () => {
      const received = {
        method,
        path,
        requestId,
        hasUpstreamApiKey: upstreamApiKey !== undefined
      }
      if (polling) httpLogger.debug('{method} {path} received ({requestId})', received)
      else httpLogger.info('{method} {path} received ({requestId})', received)
      await next()
      const status = context.res.status
      const answered = {
        method,
        path,
        status,
        durationMs: Math.round(performance.now() - start),
        requestId
      }
      const message = '{method} {path} answered {status} in {durationMs} ms ({requestId})'
      if (polling && status < HTTP_MULTIPLE_CHOICES) httpLogger.debug(message, answered)
      else httpLogger.info(message, answered)
    })
  }
}

/**
 * The 401 message a request gets while `authToken` in proxy-config.json is not a string (#82).
 * Fixed: it never contains the value.
 */
export const MISCONFIGURED_AUTH_MESSAGE =
  'Proxy auth is misconfigured: authToken in proxy-config.json is not a string. Fix it, or set a token with --auth-token or PI_PROXY_AUTH_TOKEN.'

/**
 * Creates the proxy auth middleware for `config.proxyAuth`.
 *
 * @remarks
 * `off` lets everything through; `invalid` refuses everything with 401
 * {@link MISCONFIGURED_AUTH_MESSAGE} (#82); `token` needs `Authorization: Bearer <token>` and
 * answers 401 for a missing header or a wrong token.
 *
 * @param config - the server config; only `proxyAuth` is read, once, when the middleware is made
 * @returns the middleware
 */
export function proxyAuthMiddleware(config: ServerConfig): MiddlewareHandler<ProxyEnv> {
  const proxyAuth = config.proxyAuth
  return async (context, next) => {
    if (proxyAuth.kind === 'off') {
      await next()
      return undefined
    }

    if (proxyAuth.kind === 'invalid') {
      // Fail closed: the operator asked for a token the proxy cannot read. Never let it through.
      authLogger.warn('Rejected {method} {path}: proxy auth is misconfigured', {
        method: context.req.method,
        path: context.req.path
      })
      return context.json(authenticationError(MISCONFIGURED_AUTH_MESSAGE), HTTP_UNAUTHORIZED)
    }

    const authHeader = context.req.header('authorization')
    if (authHeader === undefined) {
      authLogger.warn('Rejected {method} {path}: missing Authorization header', {
        method: context.req.method,
        path: context.req.path
      })
      return context.json(authenticationError('Missing Authorization header'), HTTP_UNAUTHORIZED)
    }

    const isBearer = authHeader.startsWith(BEARER_PREFIX)
    const token = isBearer ? authHeader.slice(BEARER_PREFIX.length) : undefined

    if (token !== proxyAuth.token) {
      // Never the header or token value: only whether the scheme was right.
      authLogger.warn('Rejected {method} {path}: invalid proxy auth token', {
        method: context.req.method,
        path: context.req.path,
        bearerScheme: isBearer
      })
      return context.json(
        authenticationError('Invalid proxy authentication token'),
        HTTP_UNAUTHORIZED
      )
    }

    authLogger.debug('Proxy auth accepted for {method} {path}', {
      method: context.req.method,
      path: context.req.path
    })
    await next()
    return undefined
  }
}

/**
 * Creates the middleware that turns a client disconnect into an abort.
 *
 * @remarks
 * Sets `abortController`, which aborts (and logs the disconnect) when the request's own signal
 * does. The chat route passes its signal to pi, so the upstream call is cancelled, and reads it to
 * tell a client that left from an upstream failure.
 *
 * @returns the middleware
 */
export function disconnectMiddleware(): MiddlewareHandler<ProxyEnv> {
  return async (context, next) => {
    const controller = new AbortController()
    context.set('abortController', controller)

    const reqSignal = context.req.raw.signal
    const onAbort = (): void => {
      // An abort listener runs outside the request's async context, so the IDs are passed here.
      httpLogger.info('Client disconnected from {method} {path} ({requestId})', {
        method: context.req.method,
        path: context.req.path,
        requestId: context.get('requestId'),
        clientRequestId: context.get('clientRequestId')
      })
      controller.abort()
    }
    if (reqSignal.aborted) {
      onAbort()
    } else {
      reqSignal.addEventListener('abort', onAbort, { once: true })
    }

    await next()
  }
}

/**
 * Creates the middleware that rejects an oversized request body with 413.
 *
 * @remarks
 * Only POST, PUT and PATCH requests are checked, and only by their `Content-Length` header: a
 * request without one is let through.
 *
 * @param config - the server config; `maxBodySize` is the limit in bytes
 * @returns the middleware
 */
export function bodySizeLimitMiddleware(config: ServerConfig): MiddlewareHandler<ProxyEnv> {
  return async (context, next) => {
    const method = context.req.method
    if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH') {
      await next()
      return undefined
    }

    const contentLength = context.req.header('content-length')
    if (contentLength !== undefined) {
      const length = Number.parseInt(contentLength, 10)
      if (Number.isFinite(length) && length > config.maxBodySize) {
        httpLogger.warn(
          'Rejected {method} {path}: body of {contentLength} bytes exceeds limit of {maxBodySize}',
          { method, path: context.req.path, contentLength: length, maxBodySize: config.maxBodySize }
        )
        return context.json(
          invalidRequest(
            `Request body too large. Maximum size: ${String(config.maxBodySize)} bytes`
          ),
          HTTP_PAYLOAD_TOO_LARGE
        )
      }
    }

    await next()
    return undefined
  }
}
