/**
 * `piAgentDir` resolves pi's agent directory without loading pi (#165), so it has to stay what
 * pi's own `getAgentDir` returns. Each case runs both against the same environment, and the
 * Windows cases with `process.platform` set to `win32`, which both read at call time.
 */

import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { piAgentDir } from '@proxy/config/agent-dir'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

/** The real platform, restored after each Windows case. */
const REAL_PLATFORM = process.platform

afterEach(() => {
  vi.unstubAllEnvs()
  Object.defineProperty(process, 'platform', { value: REAL_PLATFORM })
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

  // Catches the same on Windows, where pi converts Git Bash, MSYS, Cygwin and WSL drive paths
  // first: a user running pi from Git Bash would otherwise have the proxy read another directory.
  test.each([
    ['a Git Bash drive path', '/c/Users/me/agent'],
    ['a WSL drive path', '/mnt/d/pi/agent'],
    ['a Cygwin drive path', '/cygdrive/e/agent'],
    ['a bare drive', '/c'],
    ['a UNC path', '//server/share/agent'],
    ['a path under ~ with a backslash', '~\\agent'],
    ['a native path', 'C:\\Users\\me\\agent']
  ])('matches pi on Windows for %s', (_case, value) => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    vi.stubEnv('PI_CODING_AGENT_DIR', value)

    expect(piAgentDir()).toBe(getAgentDir())
  })
})
