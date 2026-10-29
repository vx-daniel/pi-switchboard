/**
 * The chat route's body validation: what `POST /v1/chat/completions` refuses (sent through the
 * route, so its validator hook is what answers), and what it accepts (parsed with the schema that
 * validator runs, to check the request the handler gets).
 */

import { afterAll, beforeAll, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'
import { parseChatBody, postChatBody } from '../helpers'

const HTTP_BAD_REQUEST = 400
const HTTP_NOT_FOUND = 404
const HTTP_UNPROCESSABLE = 422

/** An empty agent dir: pi loaded, no model exposed. */
let agentDir: FixtureAgentDir

beforeAll(async () => {
  agentDir = await loadFixtureAgentDir()
})

afterAll(() => {
  vi.unstubAllEnvs()
  agentDir.remove()
})

describe('the chat route accepts', () => {
  // Catches the route's validator hook answering a valid body with an error, or the route parsing
  // the body with a different schema than the one these tests check: a body that passes reaches
  // model resolution, which refuses it here only because no model is exposed.
  test('a valid body, passing it on to model resolution', async () => {
    const answer = await postChatBody({
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }]
    })

    expect(answer).toMatchObject({ status: HTTP_NOT_FOUND, param: 'model' })
  })

  // Catches the minimal request losing its model or messages on the way to the handler.
  test('a minimal request', () => {
    const request = parseChatBody({
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }]
    })
    expect(request.model).toBe('openai/gpt-4o')
    expect(request.messages).toHaveLength(1)
  })

  // Catches every docker-agent request to a gpt-* model failing with a 400 at messages.N: it sends
  // system content as text parts, each with a prompt_cache_breakpoint (docker-agent v1.145.0),
  // which is kept for the APIs that take it.
  test('system and developer content as text parts, keeping prompt_cache_breakpoint', () => {
    const request = parseChatBody({
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
    expect(request.messages[0]).toEqual({
      role: 'system',
      content: [{ type: 'text', text: 'Rules.', prompt_cache_breakpoint: { mode: 'explicit' } }]
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
  ])('an echoed assistant reply: %s', (_label, echoed) => {
    expect(() =>
      parseChatBody({
        model: 'gpt-6.1-sol',
        messages: [{ role: 'user', content: 'hi' }, echoed, { role: 'user', content: 'again' }]
      })
    ).not.toThrow()
  })

  // Catches a Phase 1 field the proxy supports being refused.
  test('every Phase 1 field', () => {
    expect(() =>
      parseChatBody({
        model: 'openai/gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
        temperature: 0.7,
        max_tokens: 100,
        stop: ['\n', 'END'],
        user: 'test-user',
        stream_options: { include_usage: true }
      })
    ).not.toThrow()
  })

  // Catches a Phase 2 field the proxy supports being refused.
  test('every Phase 2 field', () => {
    expect(() =>
      parseChatBody({
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
    ).not.toThrow()
  })

  // Catches max_completion_tokens refused or dropped before the handler reads it.
  test('max_completion_tokens', () => {
    const request = parseChatBody({
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
      max_completion_tokens: 256
    })
    expect(request.max_completion_tokens).toBe(256)
  })

  // Catches a reasoning_effort level the proxy maps being refused or dropped.
  test.each(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const)(
    'reasoning_effort %s',
    (effort) => {
      const request = parseChatBody({
        model: 'openai/gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
        reasoning_effort: effort
      })
      expect(request.reasoning_effort).toBe(effort)
    }
  )

  // Catches a json_schema response_format refused, or its type lost on the way to the handler.
  test('response_format json_schema', () => {
    const request = parseChatBody({
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
    expect(request.response_format?.type).toBe('json_schema')
  })

  // Catches a json_schema response_format refused for leaving out its optional fields.
  test('response_format json_schema without optional fields', () => {
    expect(() =>
      parseChatBody({
        model: 'openai/gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'minimal'
          }
        }
      })
    ).not.toThrow()
  })

  // Catches parallel_tool_calls refused, or `false` lost on the way to the handler.
  test('parallel_tool_calls', () => {
    const request = parseChatBody({
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
      parallel_tool_calls: false
    })
    expect(request.parallel_tool_calls).toBe(false)
  })

  // Catches metadata refused, or changed before it is passed through.
  test('metadata', () => {
    const request = parseChatBody({
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
      metadata: { task: 'autocomplete', chat_id: 'abc-123' }
    })
    expect(request.metadata).toEqual({ task: 'autocomplete', chat_id: 'abc-123' })
  })

  // Catches a string prediction refused, or its type lost before it is passed through.
  test('prediction with string content', () => {
    const request = parseChatBody({
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
      prediction: {
        type: 'content',
        content: 'predicted output text'
      }
    })
    expect(request.prediction?.type).toBe('content')
  })

  // Catches a prediction given as text parts refused.
  test('prediction with array content', () => {
    expect(() =>
      parseChatBody({
        model: 'openai/gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
        prediction: {
          type: 'content',
          content: [{ type: 'text', text: 'predicted output' }]
        }
      })
    ).not.toThrow()
  })
})

describe('the chat route refuses', () => {
  // Catches a field inside a message or part dropped silently (#146), or refused at the message
  // instead of at its own path: the client must see which field to remove, in OpenAI's form
  // (`messages[0].content[0]`, not `messages.0.content.0`; #342).
  test.each([
    [
      'a part field OpenAI does not define',
      [{ role: 'system', content: [{ type: 'text', text: 'r', cache_control: {} }] }],
      'messages[0].content[0].cache_control'
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
      'messages[0].content[0].image_url.extra'
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
      'messages[1].tool_calls[0].function.strict'
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
      'messages[2].name'
    ],
    [
      'a deprecated assistant function_call',
      [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: null, function_call: { name: 'f', arguments: '{}' } }
      ],
      'messages[1].function_call'
    ],
    [
      'a non-null assistant refusal',
      [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'x', refusal: 'I cannot' }
      ],
      'messages[1].refusal'
    ],
    [
      'a non-null assistant audio',
      [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'x', audio: { id: 'audio_1' } }
      ],
      'messages[1].audio'
    ],
    [
      'a non-empty assistant annotations',
      [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'x', annotations: [{ type: 'url_citation' }] }
      ],
      'messages[1].annotations'
    ]
  ])('%s with a 422 at its path', async (_label, messages, param) => {
    expect(await postChatBody({ model: 'gpt-6.1-sol', messages })).toMatchObject({
      status: HTTP_UNPROCESSABLE,
      param
    })
  })

  // Catches an error inside a union reported at the wrong field: a user message's content is a
  // string or a part list, and its parts a union by type, so an error must name the field the
  // input got into, and stay at the content itself when it matches neither shape. A Zod upgrade
  // that changes how unions report their branches fails here.
  test.each([
    ['content that is neither a string nor parts', 42, 'messages[0].content'],
    [
      'a part type the proxy does not take',
      [{ type: 'input_audio', input_audio: { data: 'AA', format: 'wav' } }],
      'messages[0].content[0].type'
    ],
    [
      'a text part whose text is not a string',
      [{ type: 'text', text: 5 }],
      'messages[0].content[0].text'
    ]
  ])('%s with a 400 at its own path', async (_label, content, param) => {
    const answer = await postChatBody({
      model: 'gpt-6.1-sol',
      messages: [{ role: 'user', content }]
    })

    expect(answer).toMatchObject({ status: HTTP_BAD_REQUEST, param })
  })

  // Catches a message with a role the proxy does not take reported at the message, or as a
  // mismatch with some other role's fields: messages are told apart by `role`, so the error names
  // it. The deprecated `function` role is the one clients still send.
  test.each(['function', 'robot'])('role %s with a 400 at the role', async (role) => {
    const answer = await postChatBody({
      model: 'gpt-6.1-sol',
      messages: [{ role, content: 'x', name: 'f' }]
    })

    expect(answer).toMatchObject({ status: HTTP_BAD_REQUEST, param: 'messages[0].role' })
  })

  // Catches the new shape letting through what a system message cannot carry: no parts at all,
  // or a part pi could not put in a system prompt.
  test.each([
    ['an empty part list', []],
    ['an image part', [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }]]
  ])('system content that is %s', async (_description, content) => {
    const answer = await postChatBody({
      model: 'gpt-6.1-sol',
      messages: [
        { role: 'system', content },
        { role: 'user', content: 'Hello' }
      ]
    })
    expect(answer.status).toBe(HTTP_BAD_REQUEST)
  })

  // Catches a request with no messages reaching pi, which has nothing to send.
  test('empty messages with a 400', async () => {
    const answer = await postChatBody({
      model: 'openai/gpt-4o',
      messages: []
    })
    expect(answer.status).toBe(HTTP_BAD_REQUEST)
  })

  // Catches a field the proxy refuses by name answered as a generic invalid value, or at the
  // wrong `param`.
  test.each(['n', 'logprobs', 'top_logprobs', 'logit_bias', 'functions', 'function_call'])(
    'the permanently rejected field %s with a 422 naming it',
    async (field) => {
      const answer = await postChatBody({
        model: 'openai/gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
        [field]: 'some_value'
      })
      expect(answer).toMatchObject({ status: HTTP_UNPROCESSABLE, param: field })
    }
  )

  // Catches an unknown-field rejection that loses the 422 status or stops naming the offending
  // field in `param`, which clients use to point at the bad parameter.
  test('an unknown top-level field with a 422 naming it', async () => {
    const answer = await postChatBody({
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
      unknown_field: 'value'
    })
    expect(answer).toEqual({
      status: HTTP_UNPROCESSABLE,
      message: 'Unknown parameter(s): unknown_field',
      param: 'unknown_field'
    })
  })

  // Catches a temperature outside OpenAI's range reaching the provider.
  test('temperature out of range with a 400', async () => {
    const answer = await postChatBody({
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
      temperature: 3.0
    })
    expect(answer.status).toBe(HTTP_BAD_REQUEST)
  })

  // Catches a request with no model reaching model resolution.
  test('a missing model with a 400', async () => {
    const answer = await postChatBody({
      messages: [{ role: 'user', content: 'Hello' }]
    })
    expect(answer.status).toBe(HTTP_BAD_REQUEST)
  })

  // Catches a reasoning_effort level the proxy cannot map reaching the provider.
  test('an invalid reasoning_effort with a 400', async () => {
    const answer = await postChatBody({
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
      reasoning_effort: 'extreme'
    })
    expect(answer.status).toBe(HTTP_BAD_REQUEST)
  })

  // Catches a prediction of a type OpenAI does not define being passed through.
  test('a prediction with an invalid type with a 400', async () => {
    const answer = await postChatBody({
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
      prediction: {
        type: 'invalid',
        content: 'text'
      }
    })
    expect(answer.status).toBe(HTTP_BAD_REQUEST)
  })
})
