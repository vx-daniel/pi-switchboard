/**
 * The listening event (#266): starting the server records where it listens and how many models
 * it serves, for the console's Requests table, as its first lifecycle row.
 */

import { once } from 'node:events'
import { createServer } from 'node:net'

import { consoleEvents } from '@proxy/server/console-events'
import { openServer } from '@proxy/server/startup'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'
import { testConfig } from '../helpers'

let agentDir: FixtureAgentDir

beforeAll(async () => {
  agentDir = await loadFixtureAgentDir()
})

afterAll(() => {
  vi.unstubAllEnvs()
  agentDir.remove()
})

/**
 * Finds a port free on loopback now.
 *
 * @returns the port
 */
async function freePort(): Promise<number> {
  const probe = createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const address = probe.address()
  probe.close()
  await once(probe, 'close')
  if (address === null || typeof address === 'string') throw new Error('probe not on TCP')
  return address.port
}

describe('openServer', () => {
  // Catches the server starting without the console's Requests table saying where it listens.
  test('records where it listens and how many models it serves', async () => {
    const port = await freePort()
    const server = await openServer({ ...testConfig(), host: '127.0.0.1', port })

    expect(consoleEvents().at(-1)).toMatchObject({
      level: 'info',
      text: expect.stringMatching(
        new RegExp(`^Listening on http://127\\.0\\.0\\.1:${String(port)} with \\d+ models$`, 'u')
      )
    })
    server.close()
  })
})
