import { createSealer, pkceChallenge, randomToken } from '@proxy/admin/sealed'
import { describe, expect, test } from 'vite-plus/test'
import * as z from 'zod'

const KEY = 'notarealsecret-session-key-0123456789abcdef'
const NOW = 1_800_000_000_000
const LATER = NOW + 60_000
const DataSchema = z.object({ login: z.string().trim() })

describe('pkceChallenge', () => {
  // Catches a challenge GitHub would reject: RFC 7636 appendix B's own verifier and challenge.
  test('matches RFC 7636 appendix B', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
    )
  })

  // Catches a verifier outside RFC 7636's 43 to 128 unreserved characters, which GitHub refuses.
  test('random tokens are 43 base64url characters', () => {
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/u)
  })
})

describe('createSealer', () => {
  const sealer = createSealer(KEY)

  // Catches a sealed value that does not open again with the same key, purpose and shape.
  test('opens what it sealed, before it expires', () => {
    const sealed = sealer.seal('session', { login: 'alice' }, LATER)

    expect(sealer.unseal('session', sealed, DataSchema, NOW)).toEqual({ login: 'alice' })
  })

  // Catches a forged, misused or stale cookie accepted: each must open to nothing.
  test.each([
    ['another key', createSealer(`${KEY}-other`).seal('session', { login: 'alice' }, LATER)],
    ['another purpose', sealer.seal('sign-in', { login: 'alice' }, LATER)],
    ['an expired one', sealer.seal('session', { login: 'alice' }, NOW)],
    ['another shape', sealer.seal('session', { name: 'alice' }, LATER)],
    ['no mac', sealer.seal('session', { login: 'alice' }, LATER).split('.')[0]],
    ['garbage', 'not-a-sealed-value'],
    ['nothing', undefined]
  ])('refuses %s', (_case, sealed) => {
    expect(sealer.unseal('session', sealed, DataSchema, NOW)).toBeUndefined()
  })

  // Catches a payload changed after sealing (a role raised from viewer to editor) still accepted.
  test('refuses a payload changed after sealing', () => {
    const sealed = sealer.seal('session', { login: 'alice' }, LATER)
    const [payload = '', mac = ''] = sealed.split('.')
    const changed = Buffer.from(
      Buffer.from(payload, 'base64url').toString('utf8').replace('alice', 'mallory')
    ).toString('base64url')

    expect(sealer.unseal('session', `${changed}.${mac}`, DataSchema, NOW)).toBeUndefined()
  })
})
