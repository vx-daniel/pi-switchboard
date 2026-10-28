/**
 * Request text reaches the provider exactly as the client sent it (#145): message content, stop
 * sequences and tool results keep their whitespace, through pi's real clients. Before, every
 * request string was trimmed, so a `"\n"` stop sequence went out as `""`.
 */

import { isRecord } from '@proxy/utils/guards'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'
import {
  finishChunk,
  type MockProvider,
  type MockRequest,
  sse,
  startMockProvider,
  textChunks
} from '../fixtures/mock-provider'
import { testApp } from '../helpers'

/** An OpenAI-compatible model on the mock. */
const CHAT_MODEL = 'chat/model'
/** An Anthropic-API model on the mock. */
const CLAUDE_MODEL = 'claude/model'
/** User text whose leading indentation and trailing newline are part of it. */
const INDENTED = '  def f():\n      return 1\n'

let mock: MockProvider
let agentDir: FixtureAgentDir

beforeAll(async () => {
  const answer = sse([...textChunks('ok'), finishChunk('stop')])
  mock = await startMockProvider({ model: answer })
  agentDir = await loadFixtureAgentDir({
    modelsJson: {
      providers: { chat: mock.provider(), claude: mock.provider('anthropic-messages') }
    }
  })
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await mock.close()
  agentDir.remove()
})

/**
 * Sends one chat request and returns the body pi sent upstream.
 *
 * @param model - the public model ID to ask
 * @param fields - the request fields besides `model`
 * @returns the upstream request body, or `undefined` when no request was made
 */
async function upstreamBody(model: string, fields: Record<string, unknown>): Promise<unknown> {
  const before = mock.requests.length
  await testApp().request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, ...fields })
  })
  const upstream: MockRequest | undefined = mock.requests[before]
  return upstream?.body
}

/**
 * Reads one top-level field of an upstream body.
 *
 * @param body - the upstream body
 * @param name - the field to read
 * @returns its value, or `undefined` when the body is not an object or lacks it
 */
function field(body: unknown, name: string): unknown {
  return isRecord(body) ? body[name] : undefined
}

describe('whitespace in request text reaches the provider', () => {
  // Catches a trimmed stop sequence: a newline stop, among the most common, went out as "" (which
  // providers read as no stop, or refuse), and " END " as "END".
  test('openai-completions: stop sequences keep their whitespace', async () => {
    const body = await upstreamBody(CHAT_MODEL, {
      messages: [{ role: 'user', content: 'hi' }],
      stop: ['\n', ' END ']
    })

    expect(field(body, 'stop')).toEqual(['\n', ' END '])
  })

  // Catches the same on Anthropic, where an empty stop sequence is invalid.
  test('anthropic-messages: stop_sequences keep their whitespace', async () => {
    const body = await upstreamBody(CLAUDE_MODEL, {
      messages: [{ role: 'user', content: 'hi' }],
      stop: '\n\nHuman:'
    })

    expect(field(body, 'stop_sequences')).toEqual(['\n\nHuman:'])
  })

  // Catches message text losing its leading indentation and trailing newline: code, quoted text
  // and tool output change meaning without them.
  test('user content and tool results keep their whitespace', async () => {
    const body = await upstreamBody(CHAT_MODEL, {
      messages: [
        { role: 'user', content: INDENTED },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'run', arguments: '{}' } }
          ]
        },
        { role: 'tool', tool_call_id: 'call_1', content: '\n  output\n' }
      ]
    })
    const messages = field(body, 'messages')

    expect(messages).toEqual([
      { role: 'user', content: INDENTED },
      expect.objectContaining({ role: 'assistant' }),
      expect.objectContaining({ role: 'tool', tool_call_id: 'call_1', content: '\n  output\n' })
    ])
  })

  // Catches a tool's or a schema's description trimmed (#255): every provider gives it to the
  // model, so a description written as a list or with a trailing example lost its layout.
  test('tool and json_schema descriptions keep their whitespace', async () => {
    const body = await upstreamBody(CHAT_MODEL, {
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'run', description: INDENTED } }],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'answer', description: '\n  one field\n', schema: { type: 'object' } }
      }
    })

    expect(field(body, 'tools')).toEqual([
      expect.objectContaining({ function: expect.objectContaining({ description: INDENTED }) })
    ])
    expect(field(body, 'response_format')).toMatchObject({
      json_schema: { description: '\n  one field\n' }
    })
  })
})

describe('a blank system message', () => {
  // Catches untrimmed blank instructions reaching Anthropic as a "   " system prompt, which it
  // refuses; trimmed, they used to come out as no system prompt at all.
  test('anthropic-messages: sends no system prompt', async () => {
    const body = await upstreamBody(CLAUDE_MODEL, {
      messages: [
        { role: 'system', content: '   \n' },
        { role: 'user', content: 'hi' }
      ]
    })

    expect(field(body, 'system')).toBeUndefined()
  })
})

describe('a blank assistant turn with tool calls', () => {
  // Catches untrimmed "\n" assistant content reaching Anthropic as a whitespace-only text block,
  // which it refuses (`text content blocks must contain non-whitespace text`). Clients echo such
  // turns back in history all the time; pi's Anthropic adapter skips the blank block.
  test('anthropic-messages: sends the tool call without a blank text block', async () => {
    const body = await upstreamBody(CLAUDE_MODEL, {
      messages: [
        { role: 'user', content: 'run it' },
        {
          role: 'assistant',
          content: '\n',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'run', arguments: '{}' } }
          ]
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'done' }
      ]
    })
    const messages = field(body, 'messages')
    const assistant = Array.isArray(messages)
      ? messages.find((message) => isRecord(message) && message['role'] === 'assistant')
      : undefined

    expect(isRecord(assistant) ? assistant['content'] : undefined).toEqual([
      expect.objectContaining({ type: 'tool_use', id: 'call_1', name: 'run' })
    ])
  })
})

describe('a blank assistant turn on its own', () => {
  // Catches a blank assistant turn reaching Anthropic as a whitespace-only text block, which it
  // refuses, or the request losing its last user turn around it. Clients echo an empty reply back
  // in history; pi drops the blank block, and with it the empty assistant turn.
  test('anthropic-messages: the conversation still ends with the user turn', async () => {
    const body = await upstreamBody(CLAUDE_MODEL, {
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: '\n' },
        { role: 'user', content: 'second' }
      ]
    })
    const messages = field(body, 'messages')
    const texts = JSON.stringify(messages)

    expect(texts).not.toMatch(/"text":"\\n"/)
    expect(Array.isArray(messages) ? messages.at(-1) : undefined).toMatchObject({ role: 'user' })
    expect(texts).toContain('second')
  })
})
