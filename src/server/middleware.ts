/**
 * Hono middleware: request IDs and request logging, client disconnect detection, proxy auth, body
 * size limits.
 *
 * @packageDocumentation
 */

import { createHash, timingSafeEqual } from 'node:crypto'

import { withContext } from '@logtape/logtape'
import type { ServerConfig } from '@proxy/config/env'
import { proxyLogger } from '@proxy/logging'
import { recordRejectedRequest } from '@proxy/server/active-requests'
import { authenticationError, invalidRequest } from '@proxy/server/errors'
import {
  HTTP_BAD_REQUEST,
  HTTP_MULTIPLE_CHOICES,
  HTTP_PAYLOAD_TOO_LARGE,
  HTTP_UNAUTHORIZED
} from '@proxy/server/http-status'
import type { ProxyAuthSwitch } from '@proxy/server/proxy-auth'
import { generateRequestId } from '@proxy/server/request-id'
import type { ProxyEnv } from '@proxy/server/types'
import type { MiddlewareHandler } from 'hono'

/** Logger for request and response lines. */
const httpLogger = proxyLogger('server', 'http')
/** Logger for proxy auth decisions. */
const authLogger = proxyLogger('server', 'auth')

/**
 * An `Authorization` header with a bearer token: the scheme in any case, then one or more spaces
 * (RFC 7235 §2.1: `credentials = auth-scheme [ 1*SP ... ]`, and the scheme is case-insensitive),
 * then the token, captured as sent.
 */
const BEARER = /^bearer +(\S.*)$/i
/** The liveness path; it and the paths below it are logged as polling. */
const HEALTH_PATH = '/healthz'
/** The per-request upstream key header. */
const UPSTREAM_API_KEY_HEADER = 'X-Switchboard-Upstream-Api-Key'
/** Its name before the rename to pi-switchboard (#65); rejected, not read. */
const OLD_UPSTREAM_API_KEY_HEADER = 'X-Pi-Upstream-Api-Key'

/**
 * Creates the middleware that sets the request's IDs and upstream API key, and logs the request
 * and its response.
 *
 * @remarks
 * Sets `requestId` (new), `clientRequestId` (`X-Client-Request-Id`) and `upstreamApiKey`
 * (`X-Switchboard-Upstream-Api-Key`), and echoes `X-Request-Id` and `X-Client-Request-Id` on the
 * response.
 * Everything downstream runs inside `withContext({ requestId, clientRequestId })`, so every log
 * line a request causes carries its IDs without passing them around.
 *
 * @returns the middleware
 */
export function requestIdMiddleware(): MiddlewareHandler<ProxyEnv> {
  return async (context, next) => {
    const requestId = generateRequestId()
    const clientRequestId = context.req.header('x-client-request-id')
    const upstreamApiKey = context.req.header(UPSTREAM_API_KEY_HEADER)
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
 * Creates the middleware that rejects the upstream key header by its old name (#65).
 *
 * @remarks
 * Ignoring it would send the request with pi's stored credential instead of the key the client
 * meant (principle I: rejected, not ignored). The header's value is never logged or echoed.
 *
 * @returns the middleware: a 400 naming the new header, or the next handler
 */
export function renamedHeaderMiddleware(): MiddlewareHandler<ProxyEnv> {
  return async (context, next) => {
    if (context.req.header(OLD_UPSTREAM_API_KEY_HEADER) === undefined) return next()
    httpLogger.warn('Rejected a request with the old {header} header', {
      header: OLD_UPSTREAM_API_KEY_HEADER
    })
    return context.json(
      invalidRequest(
        `The ${OLD_UPSTREAM_API_KEY_HEADER} header is not read any more: send the key as ${UPSTREAM_API_KEY_HEADER}`
      ),
      HTTP_BAD_REQUEST
    )
  }
}

/**
 * Hashes a token for {@link matchesToken}.
 *
 * @param token - the token
 * @returns its SHA-256 digest
 */
function tokenDigest(token: string): Buffer {
  return createHash('sha256').update(token).digest()
}

/**
 * Compares a token from a request with the proxy's in constant time (#128 item 1).
 *
 * @remarks
 * `!==` returns at the first character that differs, so its time tells how much of the token
 * matched. Comparing SHA-256 digests with `timingSafeEqual` takes the same time for any token,
 * and the digests' equal length hides the token's length too.
 *
 * @param token - the token the request sent
 * @param expected - the digest of the proxy's token
 * @returns whether they are the same token
 */
function matchesToken(token: string, expected: Buffer): boolean {
  return timingSafeEqual(tokenDigest(token), expected)
}

/**
 * Creates the proxy auth middleware, which applies the switch's auth to each request.
 *
 * @remarks
 * `off` lets everything through; `token` needs `Authorization: Bearer <token>` and answers 401 for
 * a missing header or a wrong token. The scheme is matched in any case, with one or more spaces
 * before the token, as RFC 7235 §2.1 allows; the token itself is matched exactly (#128 item 2).
 * The switch is read on every request, so a change from the console applies to the next one.
 * Auth that cannot be applied never gets here: the proxy refuses to start
 * (`UnusableProxyAuthError`).
 *
 * @param proxyAuth - the server's proxy auth switch
 * @returns the middleware
 */
export function proxyAuthMiddleware(proxyAuth: ProxyAuthSwitch): MiddlewareHandler<ProxyEnv> {
  // Hashed once per token: every request compares against the same digest until it changes.
  let hashed: { readonly token: string; readonly digest: Buffer } | undefined
  return async (context, next) => {
    const applied = proxyAuth.current()
    if (applied.kind === 'off') {
      await next()
      return undefined
    }
    if (hashed?.token !== applied.token) {
      hashed = { token: applied.token, digest: tokenDigest(applied.token) }
    }
    const expected = hashed.digest

    const authHeader = context.req.header('authorization')
    if (authHeader === undefined) {
      authLogger.warn('Rejected {method} {path}: missing Authorization header', {
        method: context.req.method,
        path: context.req.path
      })
      return context.json(authenticationError('Missing Authorization header'), HTTP_UNAUTHORIZED)
    }

    const token = BEARER.exec(authHeader)?.[1]

    if (token === undefined || !matchesToken(token, expected)) {
      // Never the header or token value: only whether it was a Bearer header with a token
      // (`bearerScheme` is false for `Bearer` with nothing after it, or no space before the token).
      authLogger.warn('Rejected {method} {path}: invalid proxy auth token', {
        method: context.req.method,
        path: context.req.path,
        bearerScheme: token !== undefined
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
 * Creates the middleware that records a chat request the proxy answers without calling a model
 * as rejected, for the console (#214).
 *
 * @remarks
 * Mounted on `POST /v1/chat/completions` ahead of the body size limit and proxy auth, so it sees
 * their answers too. The chat route marks a request that reaches the dispatch (`chatDispatched`),
 * which `active-requests.ts` follows from there; any other answer is recorded with its status and
 * the model the request named, if the route read that far (`chatModel`). Nothing else from the
 * request is kept.
 *
 * @returns the middleware
 */
export function rejectedChatMiddleware(): MiddlewareHandler<ProxyEnv> {
  return async (context, next) => {
    const startedAt = Date.now()
    await next()
    if (context.req.method !== 'POST' || context.get('chatDispatched') === true) return undefined
    recordRejectedRequest({
      requestId: context.get('requestId'),
      model: context.get('chatModel'),
      status: context.res.status,
      startedAt
    })
    return undefined
  }
}

/** A JSON media type: `application/json`, or a `+json` one such as `application/merge-patch+json`. */
const JSON_MEDIA_TYPE = /^application\/([a-z-.]+\+)?json/i

/**
 * Creates the middleware that has a route read its body as JSON whatever the `Content-Type`.
 *
 * @remarks
 * hono-openapi's `validator('json')` parses only a body sent as JSON and validates `{}`
 * otherwise, so `curl -d '{…}'` (sent as form-urlencoded) would fail as "messages: required".
 * The proxy has always parsed the body as JSON regardless of its declared type, so this sets the
 * request's `Content-Type` to `application/json` when it is anything else. A body that is not
 * JSON still fails, as invalid JSON.
 *
 * The rewrite is deliberate and local: only the chat route mounts this, after the request line is
 * logged and auth has run, and nothing after it reads the declared type. Both `app.request` (the
 * tests) and `@hono/node-server` (production) give a Request whose headers can be set.
 *
 * @returns the middleware
 */
export function jsonBodyMiddleware(): MiddlewareHandler<ProxyEnv> {
  return async (context, next) => {
    if (!JSON_MEDIA_TYPE.test(context.req.header('content-type') ?? '')) {
      context.req.raw.headers.set('content-type', 'application/json')
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
