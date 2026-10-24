/**
 * Hono environment type for the proxy: the typed context variables `c.get()` and `c.set()` use.
 *
 * @remarks
 * `requestIdMiddleware` sets `requestId`, `clientRequestId` and `upstreamApiKey`;
 * `disconnectMiddleware` sets `abortController` (both in `server/middleware.ts`). The chat route
 * sets `chatModel` and `chatDispatched`, which `rejectedChatMiddleware` reads.
 */

export interface ProxyEnv {
  Variables: {
    requestId: string
    clientRequestId: string | undefined
    abortController: AbortController
    /** Per-request upstream API key override via the X-Switchboard-Upstream-Api-Key header. */
    upstreamApiKey: string | undefined
    /** The model a chat request named, once its body is validated; unset before that. */
    chatModel?: string
    /** Set when a chat request reaches the dispatch: one answered without it was rejected. */
    chatDispatched?: true
  }
}
