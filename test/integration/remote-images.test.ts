/**
 * Integration tests for remote image URLs through POST /v1/chat/completions (#109): off by
 * default, refused by the strict policy when on, and fetched and inlined when the policy lets the
 * local image server through (`LOOPBACK_IMAGE_FETCH`, a test seam with no production setting).
 * The model is served by the local mock provider; nothing leaves the machine.
 */

import type { ServerConfig } from '@proxy/config/env'
import { MAX_REMOTE_IMAGE_BYTES_PER_REQUEST } from '@proxy/openai/remote-image-fetch'
import { MAX_REMOTE_IMAGES_PER_REQUEST } from '@proxy/openai/remote-images'
import type { ProxyEnv } from '@proxy/server/types'
import type { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'
import {
  type ImageServer,
  LOOPBACK_IMAGE_FETCH,
  PNG_BASE64,
  pngReply,
  startImageServer
} from '../fixtures/image-server'
import {
  finishChunk,
  type MockProvider,
  sse,
  startMockProvider,
  textChunks
} from '../fixtures/mock-provider'
import { jsonBody, present, testApp, testConfig } from '../helpers'

const MODEL_ID = 'images-fixture/vision-model'

let mock: MockProvider
let agentDir: FixtureAgentDir
let images: ImageServer

beforeAll(async () => {
  mock = await startMockProvider({
    'vision-model': sse([...textChunks('A small PNG.'), finishChunk('stop')])
  })
  agentDir = await loadFixtureAgentDir({
    modelsJson: {
      providers: {
        'images-fixture': {
          ...mock.provider(),
          models: [{ id: 'vision-model', input: ['text', 'image'] }]
        },
        // A credential that never resolves: its key command prints nothing (`!` runs a command).
        'images-broken': {
          baseUrl: 'http://127.0.0.1:9/v1',
          api: 'openai-completions',
          apiKey: '!true',
          models: [{ id: 'broken-vision', input: ['text', 'image'] }]
        }
      }
    }
  })
  images = await startImageServer({ '/image.png': pngReply })
})

afterAll(async () => {
  await images.close()
  await mock.close()
  agentDir.remove()
})

/**
 * The test config with `remoteImages` on.
 *
 * @returns the config
 */
function enabledConfig(): ServerConfig {
  return { ...testConfig(), remoteImagesEnabled: true }
}

/**
 * Sends a chat completion with one text part and the given image URLs.
 *
 * @param app - the proxy app
 * @param imageUrls - the `image_url.url` of each image part, after the text part
 * @param model - the public model ID; the vision model with a working credential by default
 * @returns the proxy's response
 */
async function sendImages(
  app: Hono<ProxyEnv>,
  imageUrls: string[],
  model = MODEL_ID
): Promise<Response> {
  return app.request('/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Proxy auth is off, so this reaches the route; it must never reach the image host.
      'Authorization': 'Bearer notarealsecret-client-token',
      'Cookie': 'session=notarealsecret'
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            ...imageUrls.map((url) => ({ type: 'image_url', image_url: { url } }))
          ]
        }
      ]
    })
  })
}

describe('remote image URLs', () => {
  // Catches the default changing: with the setting off a remote URL is refused, nothing is
  // fetched, and the provider is not called.
  test('are refused with 400 when the setting is off', async () => {
    const imagesBefore = images.requests.length
    const upstreamBefore = mock.requests.length

    const response = await sendImages(testApp(undefined, LOOPBACK_IMAGE_FETCH), [
      `${images.origin}/image.png`
    ])

    expect({ status: response.status, body: await jsonBody(response) }).toEqual({
      status: 400,
      body: {
        error: {
          message:
            'Remote image URLs are disabled on this proxy (the remoteImages setting is off). Use base64 data URIs instead.',
          type: 'invalid_request_error',
          param: 'messages[0].content[1].image_url.url',
          code: null
        }
      }
    })
    expect(images.requests.length).toEqual(imagesBefore)
    expect(mock.requests.length).toEqual(upstreamBefore)
  })

  // Catches the production policy reaching the proxy's own machine: a loopback URL is refused
  // before any connection, so the image server sees nothing.
  test('to a loopback address are refused as blocked when the setting is on', async () => {
    const imagesBefore = images.requests.length
    const upstreamBefore = mock.requests.length

    const response = await sendImages(testApp(enabledConfig()), [`${images.origin}/image.png`])

    expect({ status: response.status, body: await jsonBody(response) }).toEqual({
      status: 400,
      body: {
        error: {
          message:
            'Remote image host is blocked: it resolves to a loopback, private, link-local or reserved address',
          type: 'invalid_request_error',
          param: 'messages[0].content[1].image_url.url',
          code: null
        }
      }
    })
    expect(images.requests.length).toEqual(imagesBefore)
    expect(mock.requests.length).toEqual(upstreamBefore)
  })

  // Catches a fetched image not reaching the provider as base64, or the client's credentials
  // reaching the image host.
  test('are fetched and sent to the provider as base64 when allowed', async () => {
    const imagesBefore = images.requests.length

    const response = await sendImages(testApp(enabledConfig(), LOOPBACK_IMAGE_FETCH), [
      `${images.origin}/image.png`
    ])

    expect(response.status).toEqual(200)
    expect(JSON.stringify(present(mock.requests.at(-1), 'an upstream request').body)).toContain(
      `data:image/png;base64,${PNG_BASE64}`
    )
    const fetched = images.requests.slice(imagesBefore)
    expect(fetched.map((request) => request.path)).toEqual(['/image.png'])
    expect(fetched[0]?.headers).not.toHaveProperty('authorization')
    expect(fetched[0]?.headers).not.toHaveProperty('cookie')
  })

  // Catches one request fanning out unbounded fetches: past the cap it is refused before any
  // fetch, at the first image over the cap.
  test('are refused with 400 past the per-request cap', async () => {
    const imagesBefore = images.requests.length
    const urls = Array.from(
      { length: MAX_REMOTE_IMAGES_PER_REQUEST + 1 },
      () => `${images.origin}/image.png`
    )

    const response = await sendImages(testApp(enabledConfig(), LOOPBACK_IMAGE_FETCH), urls)

    expect({ status: response.status, body: await jsonBody(response) }).toEqual({
      status: 400,
      body: {
        error: {
          message: `Too many remote image URLs: at most ${String(MAX_REMOTE_IMAGES_PER_REQUEST)} per request`,
          type: 'invalid_request_error',
          param: `messages[0].content[${String(MAX_REMOTE_IMAGES_PER_REQUEST + 1)}].image_url.url`,
          code: null
        }
      }
    })
    expect(images.requests.length).toEqual(imagesBefore)
  })

  // Catches one refused image letting the rest through: the request fails at that image's path,
  // and the provider is not called.
  test('fail the request at the image that was refused', async () => {
    const upstreamBefore = mock.requests.length

    const response = await sendImages(testApp(enabledConfig(), LOOPBACK_IMAGE_FETCH), [
      `${images.origin}/image.png`,
      `${images.origin}/missing.png`
    ])

    expect({ status: response.status, body: await jsonBody(response) }).toEqual({
      status: 400,
      body: {
        error: {
          message: 'Remote image server did not answer with the image',
          type: 'invalid_request_error',
          param: 'messages[0].content[2].image_url.url',
          code: null
        }
      }
    })
    expect(mock.requests.length).toEqual(upstreamBefore)
  })

  // Catches images fetched for a request that cannot reach the provider: a model whose credential
  // does not resolve answers 401 before the proxy fetches anything on the client's behalf.
  test('are not fetched when the model has no usable credential', async () => {
    const imagesBefore = images.requests.length

    const response = await sendImages(
      testApp(enabledConfig(), LOOPBACK_IMAGE_FETCH),
      [`${images.origin}/image.png`],
      'images-broken/broken-vision'
    )

    expect({ status: response.status, fetched: images.requests.length - imagesBefore }).toEqual({
      status: 401,
      fetched: 0
    })
  })

  // Catches each image of a request getting a budget of its own (#109 review): with room for one
  // and a half images, the second is refused, at its own path, and the provider is not called.
  test('share one byte budget per request', async () => {
    const imageBytes = Buffer.from(PNG_BASE64, 'base64').length
    const tightBudget = {
      ...LOOPBACK_IMAGE_FETCH,
      limits: { ...LOOPBACK_IMAGE_FETCH.limits, maxRequestBytes: imageBytes + imageBytes / 2 }
    }
    const upstreamBefore = mock.requests.length

    const response = await sendImages(testApp(enabledConfig(), tightBudget), [
      `${images.origin}/image.png`,
      `${images.origin}/image.png`
    ])

    expect({
      status: response.status,
      body: await jsonBody(response),
      upstreamCalled: mock.requests.length > upstreamBefore
    }).toEqual({
      status: 400,
      body: {
        error: {
          message: `Remote images exceed the maximum of ${String(MAX_REMOTE_IMAGE_BYTES_PER_REQUEST)} bytes per request, all images together`,
          type: 'invalid_request_error',
          param: 'messages[0].content[2].image_url.url',
          code: null
        }
      },
      upstreamCalled: false
    })
  })
})
