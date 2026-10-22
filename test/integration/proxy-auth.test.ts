/**
 * Proxy auth (`proxyAuthMiddleware`, #128 items 1 and 2): which `Authorization` headers a proxy with
 * a token accepts.
 */

import { describe, expect, test } from 'vite-plus/test'

import { testApp, testConfig } from '../helpers'

const TOKEN = 'notarealsecret-proxy-token'

/** What a request past proxy auth gets here: `/v1/responses` is a route the proxy refuses (404). */
const PAST_AUTH = 404

/**
 * Requests `/v1/responses`, which answers 404 once past proxy auth, with this `Authorization`
 * header.
 *
 * @param authorization - the header's value, or `undefined` to send none
 * @returns the response status: 401 when proxy auth refused it
 */
async function statusWith(authorization: string | undefined): Promise<number> {
  const app = testApp({ ...testConfig(), proxyAuth: { kind: 'token', token: TOKEN } })
  const headers: Record<string, string> =
    authorization === undefined ? {} : { Authorization: authorization }
  const response = await app.request('/v1/responses', { headers })
  await response.text()
  return response.status
}

describe('proxy auth', () => {
  // Catches a client that writes the scheme in another case, or with more than one space before
  // the token, refused: RFC 7235 §2.1 makes the scheme case-insensitive and allows 1*SP.
  test.each([
    ['the canonical form', `Bearer ${TOKEN}`],
    ['a lowercase scheme', `bearer ${TOKEN}`],
    ['an uppercase scheme', `BEARER ${TOKEN}`],
    ['several spaces before the token', `Bearer   ${TOKEN}`]
  ])('accepts %s', async (_form, authorization) => {
    expect(await statusWith(authorization)).toBe(PAST_AUTH)
  })

  // Catches the looser scheme match loosening the token: the token is still compared exactly, so a
  // prefix, an extension, a change of case or another scheme is refused.
  test.each([
    ['no header', undefined],
    ['another scheme', `Basic ${TOKEN}`],
    ['no space after the scheme', `Bearer${TOKEN}`],
    ['an empty token', 'Bearer '],
    ['a prefix of the token', `Bearer ${TOKEN.slice(0, -1)}`],
    ['the token with more after it', `Bearer ${TOKEN}x`],
    ['the token in another case', `Bearer ${TOKEN.toUpperCase()}`],
    ['the token with a space inside', `Bearer ${TOKEN.slice(0, 5)} ${TOKEN.slice(5)}`]
  ])('refuses %s with 401', async (_form, authorization) => {
    expect(await statusWith(authorization)).toBe(401)
  })
})
