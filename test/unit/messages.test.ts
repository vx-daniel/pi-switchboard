import { convertMessages } from '@proxy/openai/messages'
import type { OpenAIMessage } from '@proxy/openai/schemas'
import { assert, describe, expect, test } from 'vite-plus/test'

describe('convertMessages', () => {
  test('converts system messages into systemPrompt', () => {
    const messages: OpenAIMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello' }
    ]
    const result = convertMessages(messages)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.context.systemPrompt).toBe('You are helpful.')
    expect(result.context.messages).toHaveLength(1)
    expect(result.context.messages[0]?.role).toBe('user')
  })

  test('merges system and developer messages', () => {
    const messages: OpenAIMessage[] = [
      { role: 'system', content: 'System prompt' },
      { role: 'developer', content: 'Developer context' },
      { role: 'user', content: 'Hello' }
    ]
    const result = convertMessages(messages)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.context.systemPrompt).toBe('System prompt\n\nDeveloper context')
  })

  // Catches text-part instructions (docker-agent sends them for gpt-* models) losing a part, or
  // running parts together: each part is a block, joined like separate messages, wherever it is.
  test('joins the text parts of a system or developer message with blank lines', () => {
    const result = convertMessages([
      {
        role: 'system',
        content: [
          { type: 'text', text: 'Rule one.' },
          { type: 'text', text: 'Rule two.' }
        ]
      },
      { role: 'developer', content: 'Developer context' },
      { role: 'user', content: 'Hello' },
      { role: 'system', content: [{ type: 'text', text: 'Later rule.' }] }
    ])
    assert(result.ok, 'expected the conversation to convert')

    expect(result.context.systemPrompt).toBe('Rule one.\n\nRule two.\n\nDeveloper context')
    expect(result.context.messages.at(-1)).toMatchObject({ role: 'system', content: 'Later rule.' })
  })

  // Catches a blank part (untrimmed since #145) adding stray blank lines between blocks, and a
  // later developer message with parts not being joined the same way, or not kept in place.
  test('leaves blank parts out, and joins a later developer message with parts in place', () => {
    const result = convertMessages([
      {
        role: 'system',
        content: [
          { type: 'text', text: 'Rule one.' },
          { type: 'text', text: '  \n' },
          { type: 'text', text: '  Rule two, indented.' }
        ]
      },
      { role: 'user', content: 'Hello' },
      {
        role: 'developer',
        content: [
          { type: 'text', text: 'Later rule.' },
          { type: 'text', text: '' },
          { type: 'text', text: 'Another.' }
        ]
      },
      { role: 'developer', content: [{ type: 'text', text: '   ' }] }
    ])
    assert(result.ok, 'expected the conversation to convert')

    expect(result.context.systemPrompt).toBe('Rule one.\n\n  Rule two, indented.')
    expect(rolesAndText(result.context.messages)).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'system', content: 'Later rule.\n\nAnother.' }
    ])
  })

  /**
   * Reduces each pi message to its role and its text (system and user messages carry plain text
   * here).
   *
   * @param messages - the converted pi messages
   * @returns `{ role, content }` per message, with `content` only when it is a string
   */
  function rolesAndText(messages: readonly { role: string; content?: unknown }[]): unknown[] {
    return messages.map((message) => ({
      role: message.role,
      ...(typeof message.content === 'string' ? { content: message.content } : {})
    }))
  }

  // Catches a later instruction merged into the system prompt (#45), or a leading one moved out of
  // it: only messages before the first turn form the prompt; later ones keep their position.
  test('keeps a later system or developer message in place, leading ones in the prompt', () => {
    const result = convertMessages([
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello' },
      { role: 'developer', content: 'Now answer only in JSON.' },
      { role: 'user', content: 'Weather?' },
      { role: 'system', content: 'Use Celsius.' }
    ])
    assert(result.ok, 'expected the conversation to convert')

    expect(result.context.systemPrompt).toBe('You are terse.')
    expect(rolesAndText(result.context.messages)).toEqual([
      { role: 'user', content: 'Hi' },
      { role: 'assistant' },
      { role: 'system', content: 'Now answer only in JSON.' },
      { role: 'user', content: 'Weather?' },
      { role: 'system', content: 'Use Celsius.' }
    ])
  })

  // Catches a first system message that comes after a turn being promoted to the system prompt.
  test('a conversation with no leading system message has no system prompt', () => {
    const result = convertMessages([
      { role: 'user', content: 'Hi' },
      { role: 'system', content: 'Now answer only in JSON.' },
      { role: 'user', content: 'Weather?' }
    ])
    assert(result.ok, 'expected the conversation to convert')

    expect(result.context.systemPrompt).toBeUndefined()
    expect(rolesAndText(result.context.messages)).toEqual([
      { role: 'user', content: 'Hi' },
      { role: 'system', content: 'Now answer only in JSON.' },
      { role: 'user', content: 'Weather?' }
    ])
  })

  test('converts user text messages', () => {
    const messages: OpenAIMessage[] = [{ role: 'user', content: 'Hello world' }]
    const result = convertMessages(messages)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.context.messages).toHaveLength(1)
    const message = result.context.messages[0]
    expect(message?.role).toBe('user')
    assert(message?.role === 'user')
    expect(message.content).toBe('Hello world')
  })

  test('converts assistant messages into history', () => {
    const messages: OpenAIMessage[] = [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' },
      { role: 'user', content: 'How are you?' }
    ]
    const result = convertMessages(messages)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.context.messages).toHaveLength(3)
    const assistant = result.context.messages[1]
    expect(assistant?.role).toBe('assistant')
  })

  // Catches the empty fields an SDK echoes back reaching pi as something: `tool_calls: null` as
  // a call, or the text lost next to them. The reply must convert to its text alone.
  test('converts an SDK-echoed reply, its empty fields included, to its text alone', () => {
    const messages: OpenAIMessage[] = [
      { role: 'user', content: 'Hi' },
      {
        role: 'assistant',
        content: 'Hello!',
        refusal: null,
        audio: null,
        function_call: null,
        annotations: null,
        tool_calls: null
      },
      { role: 'user', content: 'Again' }
    ]
    const result = convertMessages(messages)
    assert(result.ok)

    expect(result.context.messages[1]).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello!' }]
    })
  })
})

/**
 * Builds an assistant turn that called these tools, as an OpenAI client sends it back in history.
 *
 * @param calls - each call's ID, function name and raw JSON arguments string
 * @returns an assistant message with `content: null` and one `tool_calls` entry per call
 */
function assistantCalling(
  ...calls: { readonly id: string; readonly name: string; readonly arguments: string }[]
): OpenAIMessage {
  return {
    role: 'assistant',
    content: null,
    tool_calls: calls.map((call) => ({
      id: call.id,
      type: 'function' as const,
      function: { name: call.name, arguments: call.arguments }
    }))
  }
}

/**
 * Converts messages that must convert.
 *
 * @param messages - the OpenAI messages to convert
 * @returns the converted pi messages, without the system prompt
 * @throws AssertionError when conversion fails
 */
function convertedMessages(messages: OpenAIMessage[]): unknown[] {
  const result = convertMessages(messages)
  assert(result.ok, 'expected the messages to convert')
  return result.context.messages
}

describe('convertMessages: tool calls and results', () => {
  // Catches the 7ab6e143 regression: a tool result sent without its tool's name, which Gemini
  // rejects (`function_response.name: REQUIRED_FIELD_MISSING`). OpenAI's tool message carries only
  // the call ID, so the name has to come from the assistant turn that made the call.
  test('a tool result carries the name, ID and content of the call it answers', () => {
    const [, , toolResult] = convertedMessages([
      { role: 'user', content: "What's the weather?" },
      assistantCalling({ id: 'tc_1', name: 'get_weather', arguments: '{"city":"SF"}' }),
      { role: 'tool', content: '{"temp":72}', tool_call_id: 'tc_1' }
    ])

    expect(toolResult).toEqual({
      role: 'toolResult',
      toolCallId: 'tc_1',
      toolName: 'get_weather',
      content: [{ type: 'text', text: '{"temp":72}' }],
      isError: false,
      timestamp: expect.any(Number) as number
    })
  })

  // Catches names matched by position instead of call ID: results answered out of order.
  test('each result gets its own call’s name when results come back in another order', () => {
    const messages = convertedMessages([
      { role: 'user', content: 'Weather and time?' },
      assistantCalling(
        { id: 'tc_weather', name: 'get_weather', arguments: '{}' },
        { id: 'tc_time', name: 'get_time', arguments: '{}' }
      ),
      { role: 'tool', content: '12:00', tool_call_id: 'tc_time' },
      { role: 'tool', content: 'sunny', tool_call_id: 'tc_weather' }
    ])

    expect(messages.slice(2)).toEqual([
      expect.objectContaining({ toolCallId: 'tc_time', toolName: 'get_time' }),
      expect.objectContaining({ toolCallId: 'tc_weather', toolName: 'get_weather' })
    ])
  })

  // Catches a result for an unknown call being dropped (losing what the client sent) instead of
  // forwarded with the only name the proxy can give it.
  test('a result for a call no assistant turn made is kept, with an empty name', () => {
    const [, toolResult] = convertedMessages([
      { role: 'user', content: 'Hi' },
      { role: 'tool', content: 'orphan', tool_call_id: 'tc_unknown' }
    ])

    expect(toolResult).toMatchObject({
      role: 'toolResult',
      toolCallId: 'tc_unknown',
      toolName: '',
      content: [{ type: 'text', text: 'orphan' }]
    })
  })

  // Catches history tool calls lost, renamed, or sent with their arguments as a string.
  test('assistant tool calls become toolCall parts with parsed arguments', () => {
    const [, assistant] = convertedMessages([
      { role: 'user', content: "What's the weather?" },
      assistantCalling({ id: 'tc_1', name: 'get_weather', arguments: '{"city":"SF","days":2}' })
    ])

    expect(assistant).toMatchObject({
      role: 'assistant',
      content: [
        { type: 'toolCall', id: 'tc_1', name: 'get_weather', arguments: { city: 'SF', days: 2 } }
      ]
    })
  })

  // Catches a malformed history call failing the whole request: providers need an object, and
  // an earlier turn's arguments are not worth refusing the next turn over.
  test.each([
    ['not JSON', '{"city":'],
    ['JSON but not an object', '["SF"]']
  ])('arguments that are %s are sent as an empty object', (_case, rawArguments) => {
    const [, assistant] = convertedMessages([
      { role: 'user', content: 'Hi' },
      assistantCalling({ id: 'tc_1', name: 'get_weather', arguments: rawArguments })
    ])

    expect(assistant).toMatchObject({
      content: [{ type: 'toolCall', id: 'tc_1', name: 'get_weather', arguments: {} }]
    })
  })
})

describe('convertMessages: images', () => {
  test('rejects remote image URLs, which the chat route inlines only when remoteImages is on', () => {
    const messages: OpenAIMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          { type: 'image_url', image_url: { url: 'https://example.com/image.png' } }
        ]
      }
    ]
    const result = convertMessages(messages)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain('Remote image URLs are disabled')
  })

  test('accepts base64 data URI images', () => {
    const messages: OpenAIMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' }
          }
        ]
      }
    ]
    const result = convertMessages(messages)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.context.messages).toHaveLength(1)
    const message = result.context.messages[0]
    assert(message?.role === 'user' && Array.isArray(message.content))
    expect(message.content).toHaveLength(2)
    const imagePart = message.content[1]
    assert(imagePart?.type === 'image')
    expect(imagePart.mimeType).toBe('image/png')
    expect(imagePart.data).toBe('iVBORw0KGgo=')
  })

  test('rejects unsupported image MIME types', () => {
    const messages: OpenAIMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: 'data:image/bmp;base64,iVBORw0KGgo=' }
          }
        ]
      }
    ]
    const result = convertMessages(messages)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain('Unsupported image MIME type')
    expect(result.message).toContain('image/bmp')
  })

  // Catches the size error claiming a byte limit: the limit is on the base64 text, which is about
  // a third longer than the image it encodes (#111).
  test('rejects a data URI over the size limit, saying what was measured', () => {
    const tooLong = 'A'.repeat(20 * 1024 * 1024 + 1)
    const result = convertMessages([
      {
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${tooLong}` } }]
      }
    ])

    expect(result.ok ? undefined : result.message).toBe(
      'Image data exceeds the maximum of 20971520 base64 characters at messages[0].content[0]'
    )
  })

  test('rejects invalid base64 data URI format', () => {
    const messages: OpenAIMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: 'data:notbase64content' }
          }
        ]
      }
    ]
    const result = convertMessages(messages)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain('Invalid base64 data URI format')
  })

  test('accepts all supported image MIME types', () => {
    const mimeTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
    for (const mime of mimeTypes) {
      const messages: OpenAIMessage[] = [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: `data:${mime};base64,iVBORw0KGgo=` }
            }
          ]
        }
      ]
      const result = convertMessages(messages)
      expect(result.ok).toBe(true)
    }
  })
})

describe('convertMessages: rejection contract', () => {
  // Catches a rejected image reported at the wrong message or part, or under a different `param`:
  // clients use both to point at the offending input.
  test.each([
    [
      'a remote image URL',
      'https://example.com/image.png',
      'Remote image URLs are disabled on this proxy (the remoteImages setting is off). Use base64 data URIs instead.'
    ],
    [
      'a malformed data URI',
      'data:notbase64content',
      'Invalid base64 data URI format at messages[1].content[1]'
    ]
  ])('%s is rejected with its message and part path', (_case, url, message) => {
    const result = convertMessages([
      { role: 'system', content: 'Be brief.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          { type: 'image_url', image_url: { url } }
        ]
      }
    ])

    expect(result).toEqual({
      ok: false,
      message,
      param: 'messages[1].content[1].image_url.url'
    })
  })

  // Catches an unknown content part type slipping through as an empty message instead of being
  // refused with the part's `type` as the `param`.
  test('an unsupported content part type is rejected at its type field', () => {
    const audioPart: { type: 'text'; text: string } = { type: 'text', text: 'placeholder' }
    Object.assign(audioPart, { type: 'input_audio' })

    const result = convertMessages([{ role: 'user', content: [audioPart] }])

    expect(result).toEqual({
      ok: false,
      message: "Unsupported content part type: 'input_audio'",
      param: 'messages[0].content[0].type'
    })
  })

  // Catches a failed later user message being ignored: conversion stops at the first error.
  test('a rejected part in a later message fails the whole conversion', () => {
    const result = convertMessages([
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello' },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://x/y.png' } }] }
    ])

    expect(result).toEqual({
      ok: false,
      message:
        'Remote image URLs are disabled on this proxy (the remoteImages setting is off). Use base64 data URIs instead.',
      param: 'messages[2].content[0].image_url.url'
    })
  })

  // Catches multi-part user content reordered or reshaped on conversion.
  test('text and image parts keep their order and shape', () => {
    const [user] = convertedMessages([
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
          { type: 'text', text: 'What is this?' }
        ]
      }
    ])

    expect(user).toEqual({
      role: 'user',
      content: [
        { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
        { type: 'text', text: 'What is this?' }
      ],
      timestamp: expect.any(Number) as number
    })
  })
})
