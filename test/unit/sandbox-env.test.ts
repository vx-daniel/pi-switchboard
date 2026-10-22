/**
 * The standalone binary's environment recovery (`src/standalone/sandbox-env.ts`): a sandbox that
 * empties `process.env` must not cost the proxy its settings, auth token included.
 */

import { restoreSandboxEnv } from '@proxy/standalone/sandbox-env'
import { describe, expect, test } from 'vite-plus/test'

describe('restoreSandboxEnv', () => {
  // Catches the recovery overwriting or adding to a real environment: only an empty one is filled.
  test('leaves a non-empty environment untouched, without reading the source', () => {
    const env: NodeJS.ProcessEnv = { HOME: '/home/user' }
    let reads = 0
    restoreSandboxEnv(env, () => {
      reads += 1
      return 'PI_SWITCHBOARD_AUTH_TOKEN=notarealsecret-from-environ\0'
    })
    expect(env).toEqual({ HOME: '/home/user' })
    expect(reads).toBe(0)
  })

  // Catches a value cut at its first `=` (a token or URL can contain one) and junk entries kept.
  test('fills an empty environment from the source, keeping `=` inside values', () => {
    const env: NodeJS.ProcessEnv = {}
    restoreSandboxEnv(
      env,
      () =>
        'PI_SWITCHBOARD_AUTH_TOKEN=notarealsecret=abc\0HOME=/home/user\0=no-name\0no-separator\0'
    )
    expect(env).toEqual({ PI_SWITCHBOARD_AUTH_TOKEN: 'notarealsecret=abc', HOME: '/home/user' })
  })

  // Catches an unreadable source (not Linux, no permission) crashing the binary at startup.
  test('leaves an empty environment empty when the source cannot be read', () => {
    const env: NodeJS.ProcessEnv = {}
    restoreSandboxEnv(env, () => {
      throw new Error('ENOENT')
    })
    expect(env).toEqual({})
  })
})
