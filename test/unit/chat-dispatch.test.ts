/**
 * How the chat dispatch classifies a failed answer for an alias's `fallbackOn` (#67,
 * `src/server/chat-dispatch.ts`).
 */

import { failureClass } from '@proxy/server/chat-dispatch'
import { describe, expect, test } from 'vite-plus/test'

/**
 * Builds a failed answer with this status and error code.
 *
 * @param status - the status the client would get
 * @param code - the error body's `code`
 * @returns the answer
 */
function answer(
  status: 400 | 401 | 404 | 429 | 502 | 503 | 504,
  code: string | null = null
): Parameters<typeof failureClass>[0] {
  return {
    status,
    body: { error: { message: 'failed', type: 'upstream_error', param: null, code } }
  }
}

describe('failureClass', () => {
  // Catches a failure put in the wrong class, so an alias falls back on what it didn't name, or
  // not on what it did. A 400 has no class: another model is never the answer to a bad request.
  // A missing pi credential is `auth` though its status is 502, so `fallbackOn: [auth]` still
  // moves past it (#128).
  test.each([
    [400, null, undefined],
    [401, 'upstream_api_key_invalid', 'auth'],
    [404, 'model_not_found', 'refused'],
    [429, 'rate_limit', 'rate_limit'],
    [502, 'upstream_auth_error', 'auth'],
    [502, 'upstream_credentials_missing', 'auth'],
    [502, 'upstream_error', 'upstream_error'],
    [503, null, 'unavailable'],
    [504, 'timeout', 'timeout']
  ] as const)('%s %s is %s', (status, code, expected) => {
    expect(failureClass(answer(status, code))).toBe(expected)
  })
})
