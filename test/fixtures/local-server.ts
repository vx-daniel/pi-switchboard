/**
 * Starts a test server on a free loopback port (the mock provider, the recorder, and a port that
 * is then released), and reads the request bodies those servers get.
 *
 * @packageDocumentation
 */

import { once } from 'node:events'
import type { IncomingMessage, Server } from 'node:http'
import { zstdDecompressSync } from 'node:zlib'

/**
 * Hands a request's whole body to `onBody` once it has all arrived.
 *
 * @param incoming - the request being received
 * @param onBody - called once with the body's bytes, as sent
 */
export function onRequestBody(incoming: IncomingMessage, onBody: (body: Buffer) => void): void {
  const parts: Buffer[] = []
  incoming.on('data', (part: Buffer) => {
    parts.push(part)
  })
  incoming.on('end', () => {
    onBody(Buffer.concat(parts))
  })
}

/**
 * Returns a request body as text.
 *
 * @remarks
 * pi's Codex adapter zstd-compresses its bodies, as the Codex backend accepts. A body that does not
 * decompress stays as sent: it is then not JSON, which the mock answers with a 400 instead of
 * throwing inside the request handler.
 *
 * @param raw - the body bytes as received
 * @param contentEncoding - the request's `content-encoding` header; only `zstd` is decoded
 * @returns the decompressed text, or the raw bytes as text when not zstd or not decompressible
 */
export function decodeBody(raw: Buffer, contentEncoding: string | undefined): string {
  if (contentEncoding !== 'zstd') return raw.toString()
  try {
    return zstdDecompressSync(raw).toString()
  } catch {
    return raw.toString()
  }
}

/**
 * Listens on a free port on 127.0.0.1 and waits until the server is listening.
 *
 * @param server - the server to start; it must not be listening yet
 * @returns the server's origin, `http://127.0.0.1:<port>`
 * @throws Error when the server's address is not a TCP address
 */
export async function listenOnLoopback(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test server not on TCP')
  return `http://127.0.0.1:${String(address.port)}`
}
