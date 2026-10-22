/**
 * Proxy auth (`proxyAuthMiddleware`, #128 items 1 and 2): which `Authorization` headers a proxy with
 * a token accepts.
 */

import { createProxyAuthSwitch } from '@proxy/server/proxy-auth'
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

  // Catches the refusal bodies changing with the new matching: a missing header and a wrong token
  // still get the same OpenAI-shaped 401, and neither quotes what the client sent.
  test('answers the same 401 bodies as before', async () => {
    const app = testApp({ ...testConfig(), proxyAuth: { kind: 'token', token: TOKEN } })
    const refusal = async (headers: Record<string, string>): Promise<unknown> =>
      (await app.request('/v1/responses', { headers })).json()
    const body = (message: string): unknown => ({
      error: { message, type: 'authentication_error', param: null, code: null }
    })

    expect(await refusal({})).toEqual(body('Missing Authorization header'))
    expect(await refusal({ Authorization: `Bearer ${TOKEN}x` })).toEqual(
      body('Invalid proxy authentication token')
    )
  })

  // Catches the console's auth change (`p`) not reaching the running server, or a replaced token
  // still accepted: the middleware must read the switch on every request, not the token it was
  // built with.
  test('applies a change of auth from the next request on', async () => {
    const proxyAuth = createProxyAuthSwitch({ kind: 'off' })
    const app = testApp(testConfig(), undefined, proxyAuth)
    const status = async (headers: Record<string, string>): Promise<number> => {
      const response = await app.request('/v1/responses', { headers })
      await response.text()
      return response.status
    }
    const withToken = { Authorization: `Bearer ${TOKEN}` }

    expect(await status({})).toBe(PAST_AUTH)
    proxyAuth.set({ kind: 'token', token: TOKEN })
    expect(await status({})).toBe(401)
    expect(await status(withToken)).toBe(PAST_AUTH)
    proxyAuth.set({ kind: 'token', token: `${TOKEN}-replaced` })
    expect(await status(withToken)).toBe(401)
    proxyAuth.set({ kind: 'off' })
    expect(await status({})).toBe(PAST_AUTH)
  })
})
