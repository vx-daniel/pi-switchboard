import { validateChatRequest } from '@proxy/openai/validate'
import { describe, expect, test } from 'vite-plus/test'

const HTTP_UNPROCESSABLE = 422

describe('validateChatRequest', () => {
  test('accepts minimal valid request', () => {
    const result = validateChatRequest({
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }]
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.model).toBe('openai/gpt-4o')
    expect(result.data.messages).toHaveLength(1)
  })

  // Catches every docker-agent request to a gpt-* model failing with a 400 at messages.N: it sends
  // system content as text parts, each with a prompt_cache_breakpoint (docker-agent v1.145.0). The
  // breakpoint is kept for the APIs that take it; a field OpenAI does not define is not.
  test('accepts system and developer content as text parts, keeping prompt_cache_breakpoint', () => {
    const result = validateChatRequest({
      model: 'gpt-6.1-sol',
      messages: [
        {
          role: 'system',
          content: [
            {
              type: 'text',
              text: 'Rules.',
              prompt_cache_breakpoint: { mode: 'explicit' },
              not_an_openai_field: true
            }
          ]
        },
        { role: 'developer', content: [{ type: 'text', text: 'Context.' }] },
        { role: 'user', content: 'Hello' }
      ]
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.messages[0]).toEqual({
      role: 'system',
      content: [{ type: 'text', text: 'Rules.', prompt_cache_breakpoint: { mode: 'explicit' } }]
    })
  })

  // Catches the new shape letting through what a system message cannot carry: no parts at all,
  // or a part pi could not put in a system prompt.
  test.each([
    ['an empty part list', []],
    ['an image part', [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }]]
  ])('rejects system content that is %s', (_description, content) => {
    const result = validateChatRequest({
      model: 'gpt-6.1-sol',
      messages: [
        { role: 'system', content },
        { role: 'user', content: 'Hello' }
      ]
    })
    expect(result.ok).toBe(false)
  })

  test('accepts request with all Phase 1 fields', () => {
    const result = validateChatRequest({
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true,
      temperature: 0.7,
      max_tokens: 100,
      stop: ['\n', 'END'],
      user: 'test-user',
      stream_options: { include_usage: true }
    })
    expect(result.ok).toBe(true)
  })

  test('rejects empty messages', () => {
    const result = validateChatRequest({
      model: 'openai/gpt-4o',
      messages: []
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(400)
  })

  test('rejects permanently rejected fields with 422', () => {
    const permanentlyRejected = [
      'n',
      'logprobs',
      'top_logprobs',
      'logit_bias',
      'functions',
      'function_call'
    ]

    for (const field of permanentlyRejected) {
      const body = {
        model: 'openai/gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
        [field]: 'some_value'
      }
      const result = validateChatRequest(body)
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.status).toBe(422)
      expect(result.param).toBe(field)
    }
  })

  test('accepts Phase 2 fields', () => {
    const result = validateChatRequest({
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get the weather',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city']
            }
          }
        }
      ],
      tool_choice: 'auto',
      reasoning_effort: 'high',
      top_p: 0.9,
      frequency_penalty: 0.5,
      presence_penalty: 0.5,
      seed: 42,
      response_format: { type: 'json_object' }
    })
    expect(result.ok).toBe(true)
  })

  // Catches an unknown-field rejection that loses the 422 status or stops naming the offending
  // field in `param`, which clients use to point at the bad parameter.
  test('rejects unknown top-level fields with 422 naming the field', () => {
    const result = validateChatRequest({
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
      unknown_field: 'value'
    })
    expect(result).toEqual({
      ok: false,
      status: HTTP_UNPROCESSABLE,
      message: 'Unknown parameter(s): unknown_field',
      param: 'unknown_field'
    })
  })

  test('rejects temperature out of range', () => {
    const result = validateChatRequest({
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
      temperature: 3.0
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(400)
  })

  test('rejects missing model', () => {
    const result = validateChatRequest({
      messages: [{ role: 'user', content: 'Hello' }]
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(400)
  })

  test('accepts max_completion_tokens', () => {
    const result = validateChatRequest({
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
      max_completion_tokens: 256
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.max_completion_tokens).toBe(256)
  })

  test('accepts all reasoning_effort values', () => {
    for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
      const result = validateChatRequest({
        model: 'openai/gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
        reasoning_effort: effort
      })
      expect(result.ok).toBe(true)
      if (!result.ok) continue
      expect(result.data.reasoning_effort).toBe(effort)
    }
  })

  test('rejects invalid reasoning_effort', () => {
    const result = validateChatRequest({
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
      reasoning_effort: 'extreme'
    })
    expect(result.ok).toBe(false)
  })

  test('accepts response_format json_schema', () => {
    const result = validateChatRequest({
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'my_schema',
          description: 'A test schema',
          schema: {
            type: 'object',
            properties: {
              name: { type: 'string' }
            }
          },
          strict: true
        }
      }
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.response_format?.type).toBe('json_schema')
  })

  test('accepts response_format json_schema without optional fields', () => {
    const result = validateChatRequest({
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'minimal'
        }
      }
    })
    expect(result.ok).toBe(true)
  })

  test('accepts parallel_tool_calls', () => {
    const result = validateChatRequest({
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
      parallel_tool_calls: false
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.parallel_tool_calls).toBe(false)
  })

  test('accepts metadata', () => {
    const result = validateChatRequest({
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
      metadata: { task: 'autocomplete', chat_id: 'abc-123' }
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.metadata).toEqual({ task: 'autocomplete', chat_id: 'abc-123' })
  })

  test('accepts prediction with string content', () => {
    const result = validateChatRequest({
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
      prediction: {
        type: 'content',
        content: 'predicted output text'
      }
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.prediction?.type).toBe('content')
  })

  test('accepts prediction with array content', () => {
    const result = validateChatRequest({
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
      prediction: {
        type: 'content',
        content: [{ type: 'text', text: 'predicted output' }]
      }
    })
    expect(result.ok).toBe(true)
  })

  test('rejects prediction with invalid type', () => {
    const result = validateChatRequest({
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
      prediction: {
        type: 'invalid',
        content: 'text'
      }
    })
    expect(result.ok).toBe(false)
  })
})
