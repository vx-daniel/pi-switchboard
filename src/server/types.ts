/**
 * Hono environment type for the proxy: the typed context variables `c.get()` and `c.set()` use.
 *
 * @remarks
 * `requestIdMiddleware` sets `requestId`, `clientRequestId` and `upstreamApiKey`;
 * `disconnectMiddleware` sets `abortController` (both in `server/middleware.ts`).
 */

export interface ProxyEnv {
  Variables: {
    requestId: string
    clientRequestId: string | undefined
    abortController: AbortController
    /** Per-request upstream API key override via the X-Switchboard-Upstream-Api-Key header. */
    upstreamApiKey: string | undefined
  }
}
