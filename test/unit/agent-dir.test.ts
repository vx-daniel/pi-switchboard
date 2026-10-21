/**
 * `piAgentDir` resolves pi's agent directory without loading pi (#165), so it has to stay what
 * pi's own `getAgentDir` returns. Each case runs both against the same environment.
 */

import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { piAgentDir } from '@proxy/config/agent-dir'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('piAgentDir', () => {
  // Catches the proxy and pi reading different agent directories: the proxy's config file and pid
  // file land beside pi's login only if both resolve PI_CODING_AGENT_DIR the same way, and a pi
  // upgrade that changes its rules fails here.
  test.each([
    ['unset', undefined],
    ['empty', ''],
    ['an absolute path', '/srv/pi/agent'],
    ['~', '~'],
    ['a path under ~', '~/work/agent'],
    ['a file URL', 'file:///srv/pi/agent'],
    ['a relative path', 'relative/agent']
  ])('matches pi for PI_CODING_AGENT_DIR %s', (_case, value) => {
    vi.stubEnv('PI_CODING_AGENT_DIR', value)

    expect(piAgentDir()).toBe(getAgentDir())
  })
})
