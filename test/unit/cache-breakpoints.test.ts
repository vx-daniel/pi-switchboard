/**
 * `prompt_cache_breakpoint` reaches the APIs that take it, in pi's real payloads: OpenAI's own chat
 * completions and Responses get the client's parts back, breakpoints on them; any other host gets
 * pi's payload unchanged. Each payload is captured in `onPayload`, which pi calls before it sends
 * anything; the hook then throws, so no request leaves the test.
 */

import type { Api, Model } from '@earendil-works/pi-ai'
import { streamSimple as streamCompletions } from '@earendil-works/pi-ai/api/openai-completions'
import { streamSimple as streamResponses } from '@earendil-works/pi-ai/api/openai-responses'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import { convertMessages } from '@proxy/openai/messages'
import { validateChatRequest } from '@proxy/openai/validate'
import { breakpointPatch } from '@proxy/pi/cache-breakpoints'
import { isRecord } from '@proxy/utils/guards'
import { describe, expect, test } from 'vite-plus/test'

/** OpenAI's own API, where breakpoints are forwarded. */
const OPENAI_BASE_URL = 'https://api.openai.com/v1'
/** Another OpenAI-compatible server, where they are dropped. */
const OTHER_BASE_URL = 'https://llm.example.com/v1'
/** What `onPayload` throws once it has the payload, so pi sends nothing. */
const STOP = 'payload captured'
/** OpenAI's breakpoint value. */
const BREAKPOINT = { mode: 'explicit' }

/** The pi APIs this test builds payloads for. */
type PayloadApi = 'openai-completions' | 'openai-responses'

/**
 * Builds a zero-cost model on `api` at `baseUrl`, taking text and images.
 *
 * @typeParam TApi - the pi API
 * @param api - the pi API
 * @param baseUrl - where the model is served
 * @returns the model
 */
function makeModel<TApi extends Api>(api: TApi, baseUrl: string): Model<TApi> {
  return {
    id: 'gpt-test',
    name: 'gpt-test',
    api,
    provider: 'openai',
    baseUrl,
    reasoning: false,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096
  }
}

/**
 * Runs `messages` through the proxy's validation and conversion and pi's real payload builder for
 * `api` at `baseUrl`, with the proxy's breakpoint patch, and returns the payload pi would send.
 *
 * @param api - the pi API
 * @param baseUrl - where the model is served
 * @param messages - the request's messages, as a client sends them
 * @returns the payload, after the patch
 */
async function sentPayload(
  api: PayloadApi,
  baseUrl: string,
  messages: unknown[]
): Promise<Record<string, unknown>> {
  const validation = validateChatRequest({ model: 'gpt-test', messages })
  if (!validation.ok) throw new Error(`request did not validate: ${validation.message}`)
  const conversion = convertMessages(validation.data.messages)
  if (!conversion.ok) throw new Error('messages did not convert')
  // What pi's ModelRuntime does before calling an API: the system prompt becomes a leading
  // system message.
  const context = normalizeContext(conversion.context)
  let captured: Record<string, unknown> | undefined
  const options = {
    apiKey: 'notarealsecret-breakpoints',
    onPayload: (payload: unknown) => {
      if (isRecord(payload)) {
        const model = makeModel(api, baseUrl)
        breakpointPatch(model, validation.data.messages)?.(payload)
        captured = payload
      }
      throw new Error(STOP)
    }
  }
  const events =
    api === 'openai-completions'
      ? streamCompletions(makeModel(api, baseUrl), context, options)
      : streamResponses(makeModel(api, baseUrl), context, options)
  // The hook throws, so the stream ends with an error message; the payload is already captured.
  await events.result()
  if (captured === undefined) throw new Error('pi did not build a payload')
  return captured
}

/**
 * Reads the first message of a payload: `messages[0]` or `input[0]`.
 *
 * @param payload - the payload pi built
 * @param field - where its messages are
 * @returns that message's content, or `undefined` when it has none
 */
function firstContent(payload: Record<string, unknown>, field: 'messages' | 'input'): unknown {
  const messages = payload[field]
  const first: unknown = Array.isArray(messages) ? messages[0] : undefined
  return isRecord(first) ? first['content'] : undefined
}

/** docker-agent's shape: system parts, the first one marking the end of the reusable prefix. */
const SYSTEM_PARTS = [
  {
    role: 'system',
    content: [
      { type: 'text', text: 'You are an agent. Rules…', prompt_cache_breakpoint: BREAKPOINT },
      { type: 'text', text: 'Working dir: /repo' }
    ]
  },
  { role: 'developer', content: 'Answer briefly.' },
  { role: 'user', content: 'Hi' }
]

describe('OpenAI at api.openai.com gets the breakpoints', () => {
  // Catches the breakpoint dropped where OpenAI would use it, or put on the wrong part, or the
  // parts' text changed from the system prompt pi built (the blank-line joins included).
  test('chat completions: the system prompt goes as the client parts, breakpoint kept', async () => {
    const payload = await sentPayload('openai-completions', OPENAI_BASE_URL, SYSTEM_PARTS)

    expect(firstContent(payload, 'messages')).toEqual([
      { type: 'text', text: 'You are an agent. Rules…\n\n', prompt_cache_breakpoint: BREAKPOINT },
      { type: 'text', text: 'Working dir: /repo\n\n' },
      { type: 'text', text: 'Answer briefly.' }
    ])
  })

  // Catches the same on Responses, whose text parts are `input_text`.
  test('Responses: the system prompt goes as input_text parts, breakpoint kept', async () => {
    const payload = await sentPayload('openai-responses', OPENAI_BASE_URL, SYSTEM_PARTS)

    expect(firstContent(payload, 'input')).toEqual([
      {
        type: 'input_text',
        text: 'You are an agent. Rules…\n\n',
        prompt_cache_breakpoint: BREAKPOINT
      },
      { type: 'input_text', text: 'Working dir: /repo\n\n' },
      { type: 'input_text', text: 'Answer briefly.' }
    ])
  })

  // Catches breakpoints on user parts lost, or moved to a part the client did not mark.
  test('chat completions: user parts keep their breakpoints, by position', async () => {
    const payload = await sentPayload('openai-completions', OPENAI_BASE_URL, [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Long document…', prompt_cache_breakpoint: BREAKPOINT },
          { type: 'text', text: 'Question?' }
        ]
      }
    ])

    expect(firstContent(payload, 'messages')).toEqual([
      expect.objectContaining({
        type: 'text',
        text: 'Long document…',
        prompt_cache_breakpoint: BREAKPOINT
      }),
      expect.not.objectContaining({ prompt_cache_breakpoint: expect.anything() as unknown })
    ])
  })

  // Catches a breakpoint on an image part lost (its URL is rewritten on the way, so it cannot be
  // matched by value), on both APIs' part types.
  test.each<[PayloadApi, 'messages' | 'input', string, string]>([
    ['openai-completions', 'messages', 'text', 'image_url'],
    ['openai-responses', 'input', 'input_text', 'input_image']
  ])(
    '%s: user text and image parts keep their breakpoints',
    async (api, field, textType, imageType) => {
      const payload = await sentPayload(api, OPENAI_BASE_URL, [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this.' },
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' },
              prompt_cache_breakpoint: BREAKPOINT
            }
          ]
        }
      ])

      expect(firstContent(payload, field)).toEqual([
        expect.not.objectContaining({ prompt_cache_breakpoint: expect.anything() as unknown }),
        expect.objectContaining({ type: imageType, prompt_cache_breakpoint: BREAKPOINT })
      ])
      expect(firstContent(payload, field)).toEqual([
        expect.objectContaining({ type: textType, text: 'Describe this.' }),
        expect.anything()
      ])
    }
  )
})

describe('a malformed breakpoint', () => {
  // Catches any object accepted as a breakpoint and then forwarded to OpenAI, which defines one
  // mode only. The message schema is a union, so the error names the message, as it does for any
  // invalid field inside one.
  test('is rejected with 400 at the message', () => {
    const result = validateChatRequest({
      model: 'gpt-test',
      messages: [
        {
          role: 'system',
          content: [{ type: 'text', text: 'Rules.', prompt_cache_breakpoint: { mode: 'implicit' } }]
        },
        { role: 'user', content: 'Hi' }
      ]
    })

    expect(result).toMatchObject({ ok: false, status: 400, param: 'messages.0' })
  })
})

describe('any other host gets pi payload unchanged', () => {
  // Catches the field sent to an OpenAI-compatible server that may refuse a field it does not
  // know, failing every request from a client that marks breakpoints.
  test.each<PayloadApi>(['openai-completions', 'openai-responses'])(
    '%s: no prompt_cache_breakpoint anywhere in the payload',
    async (api) => {
      const payload = await sentPayload(api, OTHER_BASE_URL, SYSTEM_PARTS)

      expect(JSON.stringify(payload)).not.toContain('prompt_cache_breakpoint')
    }
  )
})
