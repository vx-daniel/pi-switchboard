/**
 * A login's credential health (`src/pi/login-health.ts`, #388): the latest result wins, and a
 * login logged in again starts over.
 */

import {
  clearLoginHealth,
  forgetLoginHealth,
  loginHealth,
  noteCredentialFailure,
  noteCredentialOk
} from '@proxy/pi/login-health'
import { beforeEach, describe, expect, test } from 'vite-plus/test'

const NOW = 1_800_000_000_000

beforeEach(() => {
  clearLoginHealth()
})

describe('loginHealth', () => {
  // Catches a login stuck failing after it served again (a refresh that recovered, a key put
  // back), or one read working while its newest result is a failure.
  test('the latest result wins, and the other is kept for when it happened', () => {
    noteCredentialFailure('anthropic', 'OAuth refresh failed (HTTP 400)', NOW)
    noteCredentialOk('anthropic', NOW + 1000)

    expect(loginHealth('anthropic')).toEqual({
      status: 'working',
      lastOk: NOW + 1000,
      lastFailure: { at: NOW, reason: 'OAuth refresh failed (HTTP 400)' }
    })

    noteCredentialFailure(
      'anthropic',
      'the provider refused the credential (401 or 403)',
      NOW + 2000
    )
    expect(loginHealth('anthropic')).toMatchObject({ status: 'failing', lastOk: NOW + 1000 })
    expect(loginHealth('anthropic-2')).toEqual({
      status: 'unknown',
      lastOk: undefined,
      lastFailure: undefined
    })
  })

  // Catches a login logged in again in the console still read as failing on the old credential.
  test('a login forgotten (logged in again, or out) starts over', () => {
    noteCredentialFailure('anthropic', 'no credentials configured', NOW)

    forgetLoginHealth('anthropic')

    expect(loginHealth('anthropic').status).toBe('unknown')
  })
})
