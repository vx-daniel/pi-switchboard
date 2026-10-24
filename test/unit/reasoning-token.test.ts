/**
 * The reasoning token (`encrypted_content` on a Responses reasoning item, #140): what the proxy
 * writes decodes back as written, and anything else is refused as "not a token this proxy
 * wrote", never misread. The route's 400 on a refused token is tested in the Responses API suite.
 */

import {
  decodeReasoningToken,
  encodeReasoningToken
} from '@proxy/openai/responses-api/reasoning-token'
import { describe, expect, test } from 'vite-plus/test'

const TOKEN = {
  provider: 'anthropic',
  api: 'anthropic-messages',
  model: 'claude-fable-5-1',
  thinking: { type: 'thinking', thinking: '  reasoning with edges  \n', thinkingSignature: 'sig' }
} as const

/**
 * Encodes a payload the way the proxy does, with no checks: for tokens the proxy would not write.
 *
 * @param payload - the payload to encode
 * @returns the base64url token
 */
function rawToken(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

describe('decodeReasoningToken', () => {
  // Catches the round trip losing a field, or trimming the thinking text or the signature, which
  // go back to the provider as they came.
  test('decodes what encodeReasoningToken wrote, text untouched', () => {
    expect(decodeReasoningToken(encodeReasoningToken(TOKEN))).toEqual(TOKEN)
  })

  // Catches `redacted` being dropped on the way back, or added when it was not set.
  test('keeps redacted when set, and only then', () => {
    const redacted = { ...TOKEN, thinking: { ...TOKEN.thinking, redacted: true } }

    expect(decodeReasoningToken(encodeReasoningToken(redacted))).toEqual(redacted)
    expect(decodeReasoningToken(encodeReasoningToken(TOKEN))?.thinking).not.toHaveProperty(
      'redacted'
    )
  })

  // Catches a token of another version, or one with a field of the wrong type, being read anyway:
  // the schema is what the proxy wrote, and nothing else.
  test.each([
    ['not base64url JSON', 'not-a-token'],
    [
      'another version',
      rawToken({ version: 2, provider: 'p', api: 'a', model: 'm', thinking: 't' })
    ],
    [
      'thinking not a string',
      rawToken({ version: 1, provider: 'p', api: 'a', model: 'm', thinking: 1 })
    ],
    [
      'a signature that is not a string',
      rawToken({ version: 1, provider: 'p', api: 'a', model: 'm', thinking: 't', signature: 5 })
    ],
    ['a missing model', rawToken({ version: 1, provider: 'p', api: 'a', thinking: 't' })],
    // The proxy writes `redacted: true` or leaves it out; any other value is not its token.
    [
      'redacted set to false',
      rawToken({ version: 1, provider: 'p', api: 'a', model: 'm', thinking: 't', redacted: false })
    ],
    ['a JSON array', rawToken([1, 2, 3])]
  ])('%s is refused', (_label, encoded) => {
    expect(decodeReasoningToken(encoded)).toBeUndefined()
  })
})
