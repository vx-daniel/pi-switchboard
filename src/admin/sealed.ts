/**
 * The admin UI's signed values (#367): the sign-in and session cookies, and the PKCE pair a sign-in
 * sends GitHub.
 *
 * @remarks
 * A sealed value is `<payload>.<mac>`, each base64url: the payload is JSON naming the value's
 * purpose, its version and when it expires, around the caller's data; the mac is its HMAC-SHA256
 * under the session key, compared in constant time before the payload is parsed. Naming the purpose
 * inside what is signed keeps a sign-in cookie from passing for a session cookie, and the version
 * lets a change of shape sign everyone out. Nothing here is encrypted: a sealed value holds nothing
 * secret (a login, a role, a sign-in's `state` and PKCE verifier, which GitHub's own redirect would
 * carry anyway), only something that must not be forged.
 *
 * PKCE is RFC 7636's S256 method: a verifier of 32 random bytes (43 base64url characters) and its
 * SHA-256 as the challenge.
 *
 * @packageDocumentation
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import * as z from 'zod'

/** The version of every sealed value's shape; raising it signs everyone out. */
const SEALED_VERSION = 1

/** Random bytes in a `state` or a PKCE verifier: 256 bits. */
const RANDOM_BYTES = 32

/** What a sealed value is for: a sign-in in progress, or a signed-in session. */
export type SealedPurpose = 'sign-in' | 'session'

/** The envelope every sealed value's payload has. */
const EnvelopeSchema = z.object({
  version: z.literal(SEALED_VERSION),
  purpose: z.enum(['sign-in', 'session']),
  expires: z.int().positive(),
  data: z.unknown()
})

/** Seals and opens values under one session key. */
export interface Sealer {
  /**
   * Seals data for a purpose until a time.
   *
   * @param purpose - what the value is for
   * @param data - what it carries; JSON
   * @param expiresAt - when it stops being accepted, in milliseconds since the epoch
   * @returns the sealed value, safe in a cookie
   */
  seal(purpose: SealedPurpose, data: unknown, expiresAt: number): string
  /**
   * Opens a sealed value: checks its mac, purpose, version and expiry, then its data's shape.
   *
   * @typeParam T - the data's type
   * @param purpose - what the value must be for
   * @param value - the sealed value, as the cookie carried it; `undefined` when there was none
   * @param schema - the data's schema
   * @param now - the time, in milliseconds since the epoch
   * @returns the data, or `undefined` when the value is missing, forged, for another purpose or
   *   version, expired, or of another shape
   */
  unseal<T>(
    purpose: SealedPurpose,
    value: string | undefined,
    schema: z.ZodType<T>,
    now: number
  ): T | undefined
}

/**
 * Returns random bytes as base64url, for a `state` or a PKCE verifier.
 *
 * @returns 32 random bytes as 43 base64url characters
 */
export function randomToken(): string {
  return randomBytes(RANDOM_BYTES).toString('base64url')
}

/**
 * Computes a PKCE challenge for a verifier (RFC 7636, S256).
 *
 * @param verifier - the verifier
 * @returns `BASE64URL(SHA256(ASCII(verifier)))`
 */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url')
}

/**
 * Computes the mac of a sealed value's payload.
 *
 * @param key - the session key
 * @param payload - the base64url payload
 * @returns its HMAC-SHA256, raw
 */
function macOf(key: string, payload: string): Buffer {
  return createHmac('sha256', key).update(payload).digest()
}

/**
 * Makes a sealer for a session key.
 *
 * @param key - the session key
 * @returns the sealer
 */
export function createSealer(key: string): Sealer {
  return {
    seal(purpose, data, expiresAt) {
      const envelope = { version: SEALED_VERSION, purpose, expires: Math.floor(expiresAt), data }
      const payload = Buffer.from(JSON.stringify(envelope)).toString('base64url')
      return `${payload}.${macOf(key, payload).toString('base64url')}`
    },
    unseal(purpose, value, schema, now) {
      if (value === undefined) return undefined
      const dot = value.indexOf('.')
      if (dot <= 0) return undefined
      const payload = value.slice(0, dot)
      const given = Buffer.from(value.slice(dot + 1), 'base64url')
      const expected = macOf(key, payload)
      // Lengths first: timingSafeEqual throws on unequal lengths, and a length says nothing secret.
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined
      let parsedJson: unknown
      try {
        parsedJson = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
      } catch {
        return undefined
      }
      const envelope = EnvelopeSchema.safeParse(parsedJson)
      if (!envelope.success || envelope.data.purpose !== purpose || envelope.data.expires <= now) {
        return undefined
      }
      const data = schema.safeParse(envelope.data.data)
      return data.success ? data.data : undefined
    }
  }
}
