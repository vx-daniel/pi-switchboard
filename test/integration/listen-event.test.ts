/**
 * The listening event (#266): starting the server records where it listens and how many models
 * it serves, for the console's Requests table, as its first lifecycle row.
 */

import { consoleEvents } from '@proxy/server/console-events'
import { openServer } from '@proxy/server/startup'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'
import { freePort } from '../fixtures/local-server'
import { testConfig } from '../helpers'

let agentDir: FixtureAgentDir

beforeAll(async () => {
  agentDir = await loadFixtureAgentDir()
})

afterAll(() => {
  vi.unstubAllEnvs()
  agentDir.remove()
})

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
