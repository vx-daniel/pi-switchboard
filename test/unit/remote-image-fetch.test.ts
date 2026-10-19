/**
 * Unit tests for remote image fetching (#109): the address policy, and each safeguard of
 * `fetchRemoteImage` against a local image server. The strict policy refuses 127.0.0.1, so the
 * fetches that must succeed pass `LOOPBACK_IMAGE_FETCH`, which only lets 127.0.0.1 through; the
 * policy tests pass the strict options and must never reach the server. Nothing leaves the machine.
 */

import type { LookupAddress } from 'node:dns'

import {
  classifyAddress,
  type FetchImageResult,
  fetchRemoteImage,
  MAX_REMOTE_IMAGE_BYTES,
  type RemoteImageFetchOptions,
  STRICT_REMOTE_IMAGE_FETCH
} from '@proxy/openai/remote-image-fetch'
import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test'

import {
  type ImageServer,
  LOOPBACK_IMAGE_FETCH,
  PNG_BASE64,
  pngReply,
  startImageServer
} from '../fixtures/image-server'

/** The byte cap the size tests use, far below the real one. */
const SMALL_CAP_BYTES = 1024

let server: ImageServer

beforeAll(async () => {
  server = await startImageServer({
    '/image.png': pngReply,
    '/image.jpg': (response) => {
      response.writeHead(200, { 'content-type': 'Image/JPEG; charset=binary' })
      response.end(Buffer.from(PNG_BASE64, 'base64'))
    },
    '/page.html': (response) => {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<html></html>')
    },
    '/image.svg': (response) => {
      response.writeHead(200, { 'content-type': 'image/svg+xml' })
      response.end('<svg/>')
    },
    '/declared-large.png': (response) => {
      response.writeHead(200, {
        'content-type': 'image/png',
        'content-length': String(SMALL_CAP_BYTES + 1)
      })
      response.end(Buffer.alloc(SMALL_CAP_BYTES + 1))
    },
    // Undeclared length, and it never ends: only a cap enforced while streaming stops it.
    '/endless.png': (response) => {
      response.writeHead(200, { 'content-type': 'image/png' })
      response.write(Buffer.alloc(SMALL_CAP_BYTES * 2))
    },
    '/empty.png': (response) => {
      response.writeHead(200, { 'content-type': 'image/png' })
      response.end()
    },
    '/missing.png': (response) => {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('secret server detail')
    },
    '/silent.png': () => {
      // Never answers
    },
    '/redirect-ok': (response) => {
      response.writeHead(302, { location: '/image.png' })
      response.end()
    },
    '/redirect-metadata': (response) => {
      response.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' })
      response.end()
    },
    '/redirect-file': (response) => {
      response.writeHead(302, { location: 'file:///etc/passwd' })
      response.end()
    },
    '/loop': (response) => {
      response.writeHead(307, { location: '/loop' })
      response.end()
    }
  })
})

afterAll(async () => {
  await server.close()
})

/**
 * Fetches a path of the local image server.
 *
 * @param path - the path, with a leading slash
 * @param options - the fetch options; {@link LOOPBACK_IMAGE_FETCH} when omitted
 * @returns the fetch result
 */
async function fetchPath(
  path: string,
  options: RemoteImageFetchOptions = LOOPBACK_IMAGE_FETCH
): Promise<FetchImageResult> {
  return fetchRemoteImage(`${server.origin}${path}`, options, new AbortController().signal)
}

/**
 * Counts the server's requests for a path.
 *
 * @param path - the path
 * @returns how many requests the server received for it
 */
function hits(path: string): number {
  return server.requests.filter((request) => request.path === path).length
}

describe('classifyAddress', () => {
  // Catches a range missing from the policy, or a public address caught by one: either lets the
  // proxy reach a host inside the network, or refuses an ordinary image host.
  test.each([
    ['8.8.8.8', 'public'],
    ['93.184.216.34', 'public'],
    ['2606:4700:4700::1111', 'public'],
    ['::ffff:8.8.8.8', 'public'],
    ['0.0.0.0', 'unspecified'],
    ['::', 'unspecified'],
    ['127.0.0.1', 'loopback'],
    ['127.255.0.9', 'loopback'],
    ['::1', 'loopback'],
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['fc00::1', 'private'],
    ['fd12:3456::1', 'private'],
    ['169.254.169.254', 'link-local'],
    ['fe80::1', 'link-local'],
    ['fe80::1%eth0', 'link-local'],
    ['100.64.0.1', 'shared'],
    ['100.127.255.255', 'shared'],
    ['224.0.0.1', 'multicast'],
    ['ff02::1', 'multicast'],
    ['255.255.255.255', 'reserved'],
    ['240.0.0.1', 'reserved'],
    ['192.0.2.1', 'reserved'],
    ['0.1.2.3', 'reserved'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:7f00:1', 'loopback'],
    ['::ffff:169.254.169.254', 'link-local'],
    ['::ffff:10.0.0.1', 'private'],
    ['::127.0.0.1', 'reserved'],
    ['64:ff9b::7f00:1', 'reserved'],
    ['2002:7f00:1::', 'reserved'],
    ['not-an-address', 'invalid'],
    ['', 'invalid']
  ])('%s is %s', (address, addressClass) => {
    expect(classifyAddress(address)).toEqual(addressClass)
  })

  // Catches a boundary drawn one block too wide: the addresses just outside each range are public.
  test.each(['172.15.255.255', '172.32.0.0', '100.63.255.255', '100.128.0.0', '169.253.255.255'])(
    '%s, just outside a blocked range, is public',
    (address) => {
      expect(classifyAddress(address)).toEqual('public')
    }
  )
})

describe('fetchRemoteImage: success', () => {
  // Catches a fetched image arriving with the wrong bytes or MIME type, or the client's headers
  // reaching the image host: only the proxy's own plain GET headers may be sent.
  test('fetches an image as base64, with only the proxy headers', async () => {
    const before = server.requests.length

    const result = await fetchPath('/image.png')

    expect(result).toEqual({ ok: true, mimeType: 'image/png', data: PNG_BASE64 })
    expect(server.requests.slice(before)).toEqual([
      {
        path: '/image.png',
        headers: {
          'host': new URL(server.origin).host,
          'user-agent': 'pi-openai-proxy (remote image fetch)',
          'accept': 'image/png, image/jpeg, image/gif, image/webp',
          'connection': 'close'
        }
      }
    ])
  })

  // Catches a content type with parameters or capitals refused, or its parameters kept.
  test('takes the MIME type without parameters, lowercased', async () => {
    expect(await fetchPath('/image.jpg')).toEqual({
      ok: true,
      mimeType: 'image/jpeg',
      data: PNG_BASE64
    })
  })

  // Catches DNS rebinding: the socket must connect to the address that was checked, while the
  // Host header keeps the URL's name.
  test('connects to the checked address and keeps the host name', async () => {
    const port = new URL(server.origin).port
    const resolved: string[] = []
    const options: RemoteImageFetchOptions = {
      ...LOOPBACK_IMAGE_FETCH,
      resolveHost: async (hostname): Promise<readonly LookupAddress[]> => {
        resolved.push(hostname)
        return [{ address: '127.0.0.1', family: 4 }]
      }
    }
    const before = server.requests.length

    const result = await fetchRemoteImage(
      `http://images.example:${port}/image.png`,
      options,
      new AbortController().signal
    )

    expect(result).toEqual({ ok: true, mimeType: 'image/png', data: PNG_BASE64 })
    expect(resolved).toEqual(['images.example'])
    expect(server.requests.slice(before).map((request) => request.headers.host)).toEqual([
      `images.example:${port}`
    ])
  })

  // Catches a relative redirect not followed, or followed without its target being checked.
  test('follows a redirect to an allowed address', async () => {
    expect(await fetchPath('/redirect-ok')).toEqual({
      ok: true,
      mimeType: 'image/png',
      data: PNG_BASE64
    })
  })
})

describe('fetchRemoteImage: refusals', () => {
  // Catches a page or an SVG (which can carry script) passed to the provider as an image.
  test.each(['/page.html', '/image.svg'])('refuses the content type of %s', async (path) => {
    expect(await fetchPath(path)).toEqual({ ok: false, reason: 'wrong-type' })
  })

  // Catches a declared oversized body downloaded anyway.
  test('refuses a declared length over the cap', async () => {
    const options = {
      ...LOOPBACK_IMAGE_FETCH,
      limits: { ...LOOPBACK_IMAGE_FETCH.limits, maxBytes: SMALL_CAP_BYTES }
    }
    expect(await fetchPath('/declared-large.png', options)).toEqual({
      ok: false,
      reason: 'too-large'
    })
  })

  // Catches the cap checked only after the whole body is buffered: this body never ends, so only
  // a cap enforced while streaming answers before the deadline.
  test('aborts a body that passes the cap while streaming', async () => {
    const options = {
      ...LOOPBACK_IMAGE_FETCH,
      limits: { ...LOOPBACK_IMAGE_FETCH.limits, maxBytes: SMALL_CAP_BYTES }
    }
    expect(await fetchPath('/endless.png', options)).toEqual({ ok: false, reason: 'too-large' })
  })

  // Catches the cap drifting from the data URI limit: its base64 must fit 20 MiB of text.
  test('the real cap is the most bytes whose base64 fits the data URI limit', () => {
    expect(MAX_REMOTE_IMAGE_BYTES).toEqual(15 * 1024 * 1024)
    expect(Math.ceil(MAX_REMOTE_IMAGE_BYTES / 3) * 4).toEqual(20 * 1024 * 1024)
  })

  // Catches an empty body passed on as an image the data URI parser then calls malformed.
  test('refuses an empty body', async () => {
    expect(await fetchPath('/empty.png')).toEqual({ ok: false, reason: 'empty' })
  })

  // Catches an error page passed on, or its text leaking into the result.
  test('refuses a non-success status', async () => {
    expect(await fetchPath('/missing.png')).toEqual({ ok: false, reason: 'http-status' })
  })

  // Catches a redirect to the cloud metadata address being followed: each target is checked.
  test('refuses a redirect to a blocked address', async () => {
    expect(await fetchPath('/redirect-metadata')).toEqual({
      ok: false,
      reason: 'blocked-address'
    })
  })

  // Catches a redirect escaping to a non-http scheme.
  test('refuses a redirect to a non-http scheme', async () => {
    expect(await fetchPath('/redirect-file')).toEqual({ ok: false, reason: 'scheme' })
  })

  // Catches a redirect loop followed without end: one request and three redirects, then refused.
  test('refuses too many redirects', async () => {
    const before = hits('/loop')

    expect(await fetchPath('/loop')).toEqual({ ok: false, reason: 'too-many-redirects' })
    expect(hits('/loop') - before).toEqual(4)
  })

  // Catches a silent server holding a request open past the deadline.
  test('refuses at the total deadline', async () => {
    const options = {
      ...LOOPBACK_IMAGE_FETCH,
      limits: { ...LOOPBACK_IMAGE_FETCH.limits, totalTimeoutMs: 200 }
    }
    expect(await fetchPath('/silent.png', options)).toEqual({ ok: false, reason: 'timeout' })
  })

  // Catches a fetch that keeps running after the client left.
  test('reports a caller abort as cancelled', async () => {
    const controller = new AbortController()
    const fetching = fetchRemoteImage(
      `${server.origin}/silent.png`,
      LOOPBACK_IMAGE_FETCH,
      controller.signal
    )
    controller.abort()
    expect(await fetching).toEqual({ ok: false, reason: 'cancelled' })
  })

  // Catches a scheme other than http and https being fetched, or even resolved.
  test.each([
    'file:///etc/passwd',
    'ftp://example.com/image.png',
    'gopher://example.com/',
    'data:image/png;base64,AAAA'
  ])('refuses %s by its scheme', async (url) => {
    const resolved: string[] = []
    const options: RemoteImageFetchOptions = {
      ...STRICT_REMOTE_IMAGE_FETCH,
      resolveHost: async (hostname): Promise<readonly LookupAddress[]> => {
        resolved.push(hostname)
        return []
      }
    }
    expect(await fetchRemoteImage(url, options, new AbortController().signal)).toEqual({
      ok: false,
      reason: 'scheme'
    })
    expect(resolved).toEqual([])
  })

  // Catches a URL that does not parse being fetched some other way.
  test('refuses a URL that does not parse', async () => {
    expect(
      await fetchRemoteImage('not a url', STRICT_REMOTE_IMAGE_FETCH, new AbortController().signal)
    ).toEqual({ ok: false, reason: 'invalid-url' })
  })
})

describe('fetchRemoteImage: the strict policy', () => {
  // Catches the production policy letting a request reach the proxy's own machine or network:
  // literal IPs, an IPv4-mapped IPv6 literal, and a name that resolves to loopback.
  test.each([
    ['a loopback IP', (port: string) => `http://127.0.0.1:${port}/image.png`],
    ['an IPv6 loopback', (port: string) => `http://[::1]:${port}/image.png`],
    [
      'an IPv4-mapped IPv6 loopback',
      (port: string) => `http://[::ffff:127.0.0.1]:${port}/image.png`
    ],
    ['a name that resolves to loopback', (port: string) => `http://localhost:${port}/image.png`],
    [
      'loopback written as one decimal number',
      (port: string) => `http://2130706433:${port}/image.png`
    ],
    ['the metadata address', () => 'http://169.254.169.254/latest/meta-data/'],
    ['a private address', () => 'http://10.0.0.1/image.png'],
    ['a CGNAT address', () => 'https://100.64.0.1/image.png'],
    ['the unspecified address', () => 'http://0.0.0.0/image.png']
  ])('refuses %s without connecting', async (_case, urlFor) => {
    const before = server.requests.length

    const result = await fetchRemoteImage(
      urlFor(new URL(server.origin).port),
      STRICT_REMOTE_IMAGE_FETCH,
      new AbortController().signal
    )

    expect(result).toEqual({ ok: false, reason: 'blocked-address' })
    expect(server.requests.length).toEqual(before)
  })

  // Catches a check of only the first address: a name with one public and one private address
  // could connect to the private one.
  test('refuses a host when any of its addresses is blocked', async () => {
    const options: RemoteImageFetchOptions = {
      ...STRICT_REMOTE_IMAGE_FETCH,
      resolveHost: async (): Promise<readonly LookupAddress[]> => [
        { address: '93.184.216.34', family: 4 },
        { address: '192.168.0.10', family: 4 }
      ]
    }
    expect(
      await fetchRemoteImage(
        'http://mixed.example/image.png',
        options,
        new AbortController().signal
      )
    ).toEqual({ ok: false, reason: 'blocked-address' })
  })

  // Catches a host that does not resolve being reported as a network failure, or fetched.
  test('refuses a host that does not resolve', async () => {
    const options: RemoteImageFetchOptions = {
      ...STRICT_REMOTE_IMAGE_FETCH,
      resolveHost: async (): Promise<readonly LookupAddress[]> => {
        throw new Error('ENOTFOUND')
      }
    }
    expect(
      await fetchRemoteImage(
        'http://nowhere.example/image.png',
        options,
        new AbortController().signal
      )
    ).toEqual({ ok: false, reason: 'unresolvable' })
  })
})

describe('fetchRemoteImage: the deadline covers resolution', () => {
  // Catches a resolver that never answers holding the request past the deadline: name resolution
  // cannot be cancelled, so the fetch must stop waiting for it.
  test('refuses at the deadline while the host is still resolving', async () => {
    const options: RemoteImageFetchOptions = {
      ...STRICT_REMOTE_IMAGE_FETCH,
      resolveHost: async (): Promise<readonly LookupAddress[]> =>
        new Promise<readonly LookupAddress[]>(() => {
          // Never resolves
        }),
      limits: { ...STRICT_REMOTE_IMAGE_FETCH.limits, totalTimeoutMs: 100 }
    }
    expect(
      await fetchRemoteImage(
        'http://slow-dns.example/image.png',
        options,
        new AbortController().signal
      )
    ).toEqual({ ok: false, reason: 'timeout' })
  })
})
