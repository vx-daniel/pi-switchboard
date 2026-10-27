/**
 * The host/origin guard (#188): refuses the requests a web page in the user's browser could send,
 * when `hostOriginGuard` is on. Off by default; with proxy auth on, a page cannot know the token
 * anyway, so the guard matters for a proxy run without one.
 *
 * @remarks
 * Two checks, before proxy auth, on every path:
 *
 * - **Host.** DNS rebinding points a name the attacker controls at this machine, so the page's
 *   requests reach the proxy as same-origin, with `Host: <that name>`. Such a name is a public DNS
 *   name, and every public name has a dot. A `Host` passes when it is an IP address, a name with no
 *   dot (`localhost`, a Docker service name such as `proxy`), or `host.docker.internal` (how a
 *   container reaches a proxy on its host); anything else is 403 `invalid_host`. The rule holds on
 *   every bind, `0.0.0.0` included, where the proxy cannot know which names reach it.
 * - **Origin.** A browser sends `Origin` on every cross-origin request that can change something,
 *   no-cors `fetch` and form posts included; curl, the SDKs and docker-agent send none. A request
 *   with no `Origin`, or the proxy's own (`http://<Host>` or `https://<Host>`, as the `/docs` page
 *   sends), passes; any other, `null` included, is 403 `invalid_origin`.
 *
 * Neither protects a proxy reachable on a network: a client there sends no `Origin` and can use
 * an IP address. Only proxy auth does.
 *
 * @packageDocumentation
 */

import { proxyLogger } from '@proxy/logging'
import { invalidHost, invalidOrigin } from '@proxy/server/errors'
import { HTTP_FORBIDDEN } from '@proxy/server/http-status'
import type { ProxyEnv } from '@proxy/server/types'
import type { MiddlewareHandler } from 'hono'

/** Logger for the guard's refusals. */
const guardLogger = proxyLogger('server', 'http')

/** The one dotted name a `Host` may be: Docker Desktop's name for the host, from a container. */
const DOCKER_HOST_NAME = 'host.docker.internal'
/** An IPv4 address as the URL parser writes it (it turns `2130706433` into `127.0.0.1`). */
const IPV4_ADDRESS = /^\d{1,3}(?:\.\d{1,3}){3}$/
/** The longest `Host` or `Origin` value a log line quotes: it is text the client chose. */
const MAX_LOGGED_VALUE_LENGTH = 128
/**
 * Distinct refused values logged at warning; after these, refusals go to debug, so a scanner
 * cannot flood the log or grow the set without end.
 */
const MAX_WARNED_VALUES = 100

/**
 * Reads the host name of a `Host` header value, without its port.
 *
 * @param host - the header value, such as `127.0.0.1:4141` or `[::1]:4141`
 * @returns the name, lower-cased (an IPv6 address keeps its brackets), or `undefined` when the
 *   value is not a host
 */
function hostNameOf(host: string): string | undefined {
  try {
    return new URL(`http://${host}`).hostname
  } catch {
    return undefined
  }
}

/**
 * Says whether a `Host` header value names this proxy in a way no DNS-rebinding page can.
 *
 * @param host - the header value
 * @returns whether the name is an IP address, has no dot, or is `host.docker.internal`
 */
function isGuardedHostAllowed(host: string): boolean {
  const name = hostNameOf(host)
  if (name === undefined || name === '') return false
  return (
    name.startsWith('[') ||
    IPV4_ADDRESS.test(name) ||
    !name.includes('.') ||
    name === DOCKER_HOST_NAME
  )
}

/**
 * Says whether an `Origin` header value is the proxy's own, given the request's `Host`.
 *
 * @param origin - the `Origin` header value
 * @param host - the `Host` header value, or `undefined` when there is none
 * @returns whether the origin is `http://<Host>` or `https://<Host>`
 */
function isOwnOrigin(origin: string, host: string | undefined): boolean {
  if (host === undefined) return false
  const lower = origin.toLowerCase()
  const ownHost = host.toLowerCase()
  return lower === `http://${ownHost}` || lower === `https://${ownHost}`
}

/**
 * Creates the logger of refusals: a warning for each value the first time it is refused, debug
 * after that or once {@link MAX_WARNED_VALUES} values have been warned about.
 *
 * @returns a function that logs one refusal
 */
function refusalLogger(): (
  check: 'Host' | 'Origin',
  value: string,
  request: { readonly method: string; readonly path: string }
) => void {
  const warned = new Set<string>()
  return (check, value, request) => {
    const shown = value.slice(0, MAX_LOGGED_VALUE_LENGTH)
    const key = `${check} ${shown}`
    const properties = { method: request.method, path: request.path, check, value: shown }
    const message = 'Refused {method} {path}: the host/origin guard does not accept {check} {value}'
    if (warned.has(key) || warned.size >= MAX_WARNED_VALUES) {
      guardLogger.debug(message, properties)
      return
    }
    warned.add(key)
    guardLogger.warn(message, properties)
  }
}

/**
 * Creates the host/origin guard middleware; see the module's remarks for what it refuses.
 *
 * @returns the middleware: a 403 `invalid_host` or `invalid_origin`, or the next handler
 */
export function hostOriginGuardMiddleware(): MiddlewareHandler<ProxyEnv> {
  const logRefusal = refusalLogger()
  return async (context, next) => {
    const request = { method: context.req.method, path: context.req.path }
    // No Host at all is an HTTP/1.0 client, never a browser.
    const host = context.req.header('host')
    if (host !== undefined && !isGuardedHostAllowed(host)) {
      logRefusal('Host', host, request)
      return context.json(invalidHost(), HTTP_FORBIDDEN)
    }
    const origin = context.req.header('origin')
    if (origin !== undefined && !isOwnOrigin(origin, host)) {
      logRefusal('Origin', origin, request)
      return context.json(invalidOrigin(), HTTP_FORBIDDEN)
    }
    await next()
    return undefined
  }
}
