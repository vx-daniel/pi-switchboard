/**
 * A local image server for the remote image tests, and the fetch options that let the proxy reach
 * it. The strict production policy refuses 127.0.0.1, so a test that must fetch passes
 * {@link LOOPBACK_IMAGE_FETCH}; a test of the policy itself passes nothing and is refused.
 *
 * @packageDocumentation
 */

import { once } from 'node:events'
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http'

import {
  classifyAddress,
  type RemoteImageFetchOptions,
  STRICT_REMOTE_IMAGE_FETCH
} from '@proxy/openai/remote-image-fetch'

import { listenOnLoopback } from './local-server'

/** A tiny PNG body (the PNG signature), base64. */
export const PNG_BASE64 = 'iVBORw0KGgo='

/** HTTP 200. */
const HTTP_OK = 200
/** HTTP 404, for a path with no reply. */
const HTTP_NOT_FOUND = 404

/** One request the image server received. */
export interface ImageServerRequest {
  /** The request's path and query. */
  readonly path: string
  readonly headers: IncomingHttpHeaders
}

/** Answers one request; it may write slowly, stop partway, or never answer. */
export type ImageReply = (response: ServerResponse) => void

/** A running image server, from {@link startImageServer}. */
export interface ImageServer {
  /** `http://127.0.0.1:<port>`. */
  readonly origin: string
  /** Every request received, in order. */
  readonly requests: readonly ImageServerRequest[]
  /** Drops open connections and stops the server. */
  close(): Promise<void>
}

/**
 * Answers with {@link PNG_BASE64} as `image/png`.
 *
 * @param response - the response to write
 */
export function pngReply(response: ServerResponse): void {
  response.writeHead(HTTP_OK, { 'content-type': 'image/png' })
  response.end(Buffer.from(PNG_BASE64, 'base64'))
}

/**
 * Starts an image server on a free loopback port.
 *
 * @param replies - the reply for each path; any other path gets a 404
 * @returns the running server
 */
export async function startImageServer(replies: Record<string, ImageReply>): Promise<ImageServer> {
  const requests: ImageServerRequest[] = []
  const server = createServer((request, response) => {
    const path = request.url ?? '/'
    requests.push({ path, headers: request.headers })
    const reply = replies[path]
    if (reply === undefined) {
      response.writeHead(HTTP_NOT_FOUND).end()
      return
    }
    reply(response)
  })
  const origin = await listenOnLoopback(server)
  return {
    origin,
    requests,
    async close() {
      server.closeAllConnections()
      server.close()
      await once(server, 'close')
    }
  }
}

/**
 * The production fetch options, except that 127.0.0.1 counts as public, so the proxy can reach
 * {@link startImageServer}. Every other address keeps its real class.
 */
export const LOOPBACK_IMAGE_FETCH: RemoteImageFetchOptions = {
  ...STRICT_REMOTE_IMAGE_FETCH,
  classifyAddress: (address) => (address === '127.0.0.1' ? 'public' : classifyAddress(address))
}
