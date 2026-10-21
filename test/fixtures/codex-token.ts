/**
 * A fake Codex OAuth token for tests that point pi's Codex adapter at the mock provider: pi reads
 * the ChatGPT account ID from the token's claims before it sends anything.
 *
 * @packageDocumentation
 */

/**
 * Encodes a value as a JWT segment: base64url JSON.
 *
 * @param value - the header or payload to encode
 * @returns the base64url encoding of `value`'s JSON
 */
function jwtSegment(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

/** An unsigned JWT with the claim pi's Codex adapter reads the account ID from. */
export const FAKE_CODEX_TOKEN = [
  jwtSegment({ alg: 'none' }),
  jwtSegment({
    'https://api.openai.com/auth': { chatgpt_account_id: 'notarealsecret-account' }
  }),
  'notarealsecret-signature'
].join('.')
