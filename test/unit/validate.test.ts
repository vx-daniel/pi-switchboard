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
  // system content as text parts, each with a prompt_cache_breakpoint (docker-agent v1.145.0),
  // which is kept for the APIs that take it.
  test('accepts system and developer content as text parts, keeping prompt_cache_breakpoint', () => {
    const result = validateChatRequest({
      model: 'gpt-6.1-sol',
      messages: [
        {
          role: 'system',
          content: [{ type: 'text', text: 'Rules.', prompt_cache_breakpoint: { mode: 'explicit' } }]
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

  // Catches a field inside a message or part dropped silently (#146), or refused at the message
  // instead of at its own path: the client must see which field to remove.
  test.each([
    [
      'a part field OpenAI does not define',
      [{ role: 'system', content: [{ type: 'text', text: 'r', cache_control: {} }] }],
      'messages.0.content.0.cache_control'
    ],
    [
      'an image_url field OpenAI does not define',
      [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==', extra: 1 } }
          ]
        }
      ],
      'messages.0.content.0.image_url.extra'
    ],
    [
      'a tool call function field OpenAI does not define',
      [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'f', arguments: '{}', strict: true } }
          ]
        }
      ],
      'messages.1.tool_calls.0.function.strict'
    ],
    [
      // OpenAI defines no `name` on a tool result; the call it answers names the tool.
      'a name on a tool message',
      [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }]
        },
        { role: 'tool', tool_call_id: 'c1', content: 'done', name: 'f' }
      ],
      'messages.2.name'
    ],
    [
      'a deprecated assistant function_call',
      [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: null, function_call: { name: 'f', arguments: '{}' } }
      ],
      'messages.1.function_call'
    ],
    [
      'a non-null assistant refusal',
      [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'x', refusal: 'I cannot' }
      ],
      'messages.1.refusal'
    ],
    [
      'a non-null assistant audio',
      [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'x', audio: { id: 'audio_1' } }
      ],
      'messages.1.audio'
    ],
    [
      'a non-empty assistant annotations',
      [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'x', annotations: [{ type: 'url_citation' }] }
      ],
      'messages.1.annotations'
    ]
  ])('refuses %s with a 422 at its path', (_label, messages, param) => {
    expect(validateChatRequest({ model: 'gpt-6.1-sol', messages })).toMatchObject({
      ok: false,
      status: 422,
      param
    })
  })

  // Catches an assistant reply an OpenAI SDK echoes back in history being refused, which would
  // fail every multi-turn conversation from it: the Python SDK's `model_dump()` of a proxy reply
  // carries every response field, empty as `null`, and a dump can carry `annotations: []`.
  test.each([
    [
      'the full model_dump() shape',
      {
        role: 'assistant',
        content: 'x',
        refusal: null,
        audio: null,
        function_call: null,
        annotations: null,
        tool_calls: null
      }
    ],
    ['empty annotations', { role: 'assistant', content: 'x', annotations: [] }]
  ])('accepts an echoed assistant reply: %s', (_label, echoed) => {
    const result = validateChatRequest({
      model: 'gpt-6.1-sol',
      messages: [{ role: 'user', content: 'hi' }, echoed, { role: 'user', content: 'again' }]
    })

    expect(result.ok).toBe(true)
  })

  // Catches an error inside a union reported at the wrong field: a user message's content is a
  // string or a part list, and its parts a union by type, so an error must name the field the
  // input got into, and stay at the content itself when it matches neither shape. A Zod upgrade
  // that changes how unions report their branches fails here.
  test.each([
    ['content that is neither a string nor parts', 42, 'messages.0.content'],
    [
      'a part type the proxy does not take',
      [{ type: 'input_audio', input_audio: { data: 'AA', format: 'wav' } }],
      'messages.0.content.0.type'
    ],
    [
      'a text part whose text is not a string',
      [{ type: 'text', text: 5 }],
      'messages.0.content.0.text'
    ]
  ])('reports %s as a 400 at its own path', (_label, content, param) => {
    const result = validateChatRequest({
      model: 'gpt-6.1-sol',
      messages: [{ role: 'user', content }]
    })

    expect(result).toMatchObject({ ok: false, status: 400, param })
  })

  // Catches a message with a role the proxy does not take reported at the message, or as a
  // mismatch with some other role's fields: messages are told apart by `role`, so the error names
  // it. The deprecated `function` role is the one clients still send.
  test.each(['function', 'robot'])('reports role %s as a 400 at the role', (role) => {
    const result = validateChatRequest({
      model: 'gpt-6.1-sol',
      messages: [{ role, content: 'x', name: 'f' }]
    })

    expect(result).toMatchObject({ ok: false, status: 400, param: 'messages.0.role' })
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
