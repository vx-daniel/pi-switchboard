/**
 * The library entry points the pi extension imports (`@vx-daniel/pi-switchboard/config`,
 * `/exposure`, `/logging`, `/sync/zed`) load without pi (#165). The extension runs inside pi's own
 * process, where pi provides its packages; a runtime import of pi from these modules loaded this
 * package's installed copy as well, a second pi runtime in pi's process. Every pi package is mocked
 * to throw when it is loaded, so any such import fails the test.
 */

import { describe, expect, test, vi } from 'vite-plus/test'

vi.mock('@earendil-works/pi-ai', () => {
  throw new Error('@earendil-works/pi-ai was loaded')
})
vi.mock('@earendil-works/pi-coding-agent', () => {
  throw new Error('@earendil-works/pi-coding-agent was loaded')
})
vi.mock('@earendil-works/pi-tui', () => {
  throw new Error('@earendil-works/pi-tui was loaded')
})

describe('the entry points the pi extension loads', () => {
  // Catches a runtime import of pi added to code the extension loads (a type-only import is
  // fine), which would load a second copy of pi inside pi's process.
  test.each([
    ['config', () => import('@proxy/config/schema')],
    ['exposure', () => import('@proxy/openai/model-exposure')],
    ['logging', () => import('@proxy/logging')],
    ['sync/zed', () => import('@proxy/sync/zed')]
  ])('%s loads without pi', async (_entry, load) => {
    await expect(load()).resolves.toBeDefined()
  })
})
