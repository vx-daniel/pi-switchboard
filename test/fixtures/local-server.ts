/**
 * Start a test server on a free loopback port: the mock provider, the recorder, and a port that is
 * then released.
 */

import { once } from 'node:events'
import type { Server } from 'node:http'

/** Listen on a free port on 127.0.0.1, and return the server's origin (`http://127.0.0.1:<port>`). */
export async function listenOnLoopback(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test server not on TCP')
  return `http://127.0.0.1:${String(address.port)}`
}
