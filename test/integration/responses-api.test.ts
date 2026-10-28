/**
 * The experimental Responses API (`POST /v1/responses`, #140), end to end through the official
 * `openai` SDK's `client.responses.create()`: text, streamed and not; a client-side tool round trip;
 * reasoning, replayed through `encrypted_content`; images; the effort report; and the fields it
 * refuses. The app runs in process (the SDK's `fetch` is the app's), with pi's real OpenAI chat
 * completions client in front of the mock provider.
 */

import type { ProxyEnv } from '@proxy/server/types'
import { isRecord } from '@proxy/utils/guards'
import type { Hono } from 'hono'
import OpenAI from 'openai'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'
import {
  chunk,
  finishChunk,
  type MockProvider,
  type MockReply,
  sse,
  startMockProvider,
  textChunks,
  toolCallChunks
} from '../fixtures/mock-provider'
import { jsonBody, testApp, testConfig } from '../helpers'

const HTTP_OK = 200
const HTTP_BAD_REQUEST = 400
const HTTP_NOT_FOUND = 404
const HTTP_UNPROCESSABLE_ENTITY = 422
const USAGE = { prompt_tokens: 3, completion_tokens: 2 }
/** A one-pixel PNG, for the image request. */
const PNG_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/**
 * Answers with a weather tool call, or, once the conversation has its result, with text.
 *
 * @param response - the response to write
 * @param request - the request, whose messages say whether the tool has answered
 */
const toolLoop: MockReply = async (response, request) => {
  const body = isRecord(request.body) ? request.body : {}
  const messages = Array.isArray(body['messages']) ? body['messages'] : []
  const answered = messages.some((message) => isRecord(message) && message['role'] === 'tool')
  const reply = answered
    ? sse([...textChunks('Sunny'), finishChunk('stop', USAGE)])
    : sse([
        ...toolCallChunks(0, {
          id: 'call_weather',
          name: 'get_weather',
          argumentParts: ['{"city":', '"Oslo"}']
        }),
        finishChunk('tool_calls', USAGE)
      ])
  await reply(response, request)
}

let mock: MockProvider
let agentDir: FixtureAgentDir

beforeAll(async () => {
  mock = await startMockProvider({
    text: sse([...textChunks('Hel', 'lo'), finishChunk('stop', USAGE)]),
    tools: toolLoop,
    thinker: sse([
      chunk({ role: 'assistant', reasoning_content: 'Think' }),
      chunk({ reasoning_content: 'ing.' }),
      ...textChunks('Done'),
      finishChunk('stop', USAGE)
    ]),
    long: sse([...textChunks('Cut'), finishChunk('length', USAGE)])
  })
  agentDir = await loadFixtureAgentDir({
    modelsJson: {
      providers: {
        mock: {
          ...mock.provider(),
          models: [
            { id: 'text', input: ['text', 'image'] },
            { id: 'tools' },
            { id: 'thinker', reasoning: true },
            { id: 'long' }
          ]
        }
      }
    }
  })
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await mock.close()
  agentDir.remove()
})

/**
 * Builds the app with the Responses API on.
 *
 * @returns the app
 */
function app(): Hono<ProxyEnv> {
  return testApp({ ...testConfig(), responsesApiEnabled: true })
}

/**
 * Builds an SDK client whose requests go to the app in process.
 *
 * @returns the client
 */
function client(): OpenAI {
  const served = app()
  return new OpenAI({
    apiKey: 'notarealsecret-sdk-key',
    baseURL: 'http://proxy.test/v1',
    maxRetries: 0,
    fetch: async (input, init) => served.request(input, init)
  })
}

/**
 * Keeps the output items a client sends back as input: messages, function calls and reasoning.
 *
 * @param output - a response's output
 * @returns the items, typed as input
 */
function asInput(
  output: readonly OpenAI.Responses.ResponseOutputItem[]
): OpenAI.Responses.ResponseInputItem[] {
  return output.filter(
    (
      outputItem
    ): outputItem is
      | OpenAI.Responses.ResponseOutputMessage
      | OpenAI.Responses.ResponseFunctionToolCall
      | OpenAI.Responses.ResponseReasoningItem =>
      outputItem.type === 'message' ||
      outputItem.type === 'function_call' ||
      outputItem.type === 'reasoning'
  )
}

/**
 * Reads what the last upstream request sent.
 *
 * @returns its body
 */
function lastUpstream(): Record<string, unknown> {
  const body = mock.requests.at(-1)?.body
  return isRecord(body) ? body : {}
}

/**
 * Posts a raw body to `/v1/responses`.
 *
 * @param body - the request body
 * @param on - whether the Responses API is on
 * @returns the status and parsed body
 */
async function post(body: unknown, on = true): Promise<{ status: number; body: unknown }> {
  const served = on ? app() : testApp()
  const response = await served.request('/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  return { status: response.status, body: await jsonBody(response) }
}

describe('the Responses API', () => {
  // Catches the route answering while the operator has not turned it on, or the 404 not saying how.
  test('is off by default, and says how to turn it on', async () => {
    const answer = await post({ model: 'mock/text', input: 'Hi' }, false)

    expect(answer.status).toBe(HTTP_NOT_FOUND)
    expect(JSON.stringify(answer.body)).toContain('--responses-api')
  })

  // Catches the off switch answering before proxy auth, which would tell an unauthenticated
  // caller how this proxy is configured.
  test('needs the proxy token before saying whether it is on', async () => {
    const token = 'notarealsecret-responses-token'
    const served = testApp({ ...testConfig(), proxyAuth: { kind: 'token', token } })
    const request = (headers: Record<string, string>): Promise<Response> | Response =>
      served.request('/v1/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ model: 'mock/text', input: 'Hi' })
      })

    const without = await request({})
    const withToken = await request({ Authorization: `Bearer ${token}` })

    expect([without.status, withToken.status]).toEqual([401, HTTP_NOT_FOUND])
    expect(JSON.stringify(await jsonBody(without))).not.toContain('responses-api')
  })

  // Catches the empty-key check left off this route: the empty key would reach the provider and
  // come back as a 502 blaming it (#207).
  test('refuses an empty X-Switchboard-Upstream-Api-Key with 400, calling nothing', async () => {
    const before = mock.requests.length
    const response = await app().request('/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Switchboard-Upstream-Api-Key': '' },
      body: JSON.stringify({ model: 'mock/text', input: 'Hi' })
    })

    expect(response.status).toBe(HTTP_BAD_REQUEST)
    expect(JSON.stringify(await jsonBody(response))).toContain('header is empty')
    expect(mock.requests.length).toBe(before)
  })

  // Catches a response the SDK can't read: `output_text` is the SDK's own join of the message
  // items, so it is empty unless the items are shaped as OpenAI's.
  test('answers text, non-streamed', async () => {
    const response = await client().responses.create({ model: 'mock/text', input: 'Hi' })

    expect(response.output_text).toBe('Hello')
    expect(response).toMatchObject({
      object: 'response',
      status: 'completed',
      model: 'mock/text',
      store: false,
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 }
    })
    expect(lastUpstream()['messages']).toEqual([{ role: 'user', content: 'Hi' }])
  })

  // Catches events out of OpenAI's order, a missing terminal event, or deltas that don't add up to
  // the text: SDK helpers rebuild the text from the deltas.
  test('streams text as response events', async () => {
    const stream = await client().responses.create({
      model: 'mock/text',
      input: 'Hi',
      instructions: 'Be brief.',
      stream: true
    })
    const types: string[] = []
    let text = ''
    let sequence = -1
    for await (const event of stream) {
      types.push(event.type)
      expect(event.sequence_number).toBe(sequence + 1)
      sequence = event.sequence_number
      if (event.type === 'response.output_text.delta') text += event.delta
    }

    expect(text).toBe('Hello')
    expect(types).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed'
    ])
    expect(lastUpstream()['messages']).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Hi' }
    ])
  })

  // Catches a tool call the client can't answer (no `call_id`, arguments not JSON), or its output
  // not reaching the model as the result of that call.
  test('runs a client-side tool round trip', async () => {
    const sdk = client()
    const tools = [
      {
        type: 'function' as const,
        name: 'get_weather',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
        strict: false
      }
    ]
    const first = await sdk.responses.create({ model: 'mock/tools', input: 'Weather?', tools })
    const call = first.output.find((outputItem) => outputItem.type === 'function_call')
    if (call?.type !== 'function_call') throw new Error('no function call')

    const second = await sdk.responses.create({
      model: 'mock/tools',
      tools,
      input: [
        { role: 'user', content: 'Weather?' },
        ...asInput(first.output),
        { type: 'function_call_output', call_id: call.call_id, output: '12 C, clear' }
      ]
    })

    expect(JSON.parse(call.arguments)).toEqual({ city: 'Oslo' })
    expect(second.output_text).toBe('Sunny')
    expect(lastUpstream()['messages']).toMatchObject([
      { role: 'user', content: 'Weather?' },
      {
        role: 'assistant',
        tool_calls: [{ id: call.call_id, function: { name: 'get_weather' } }]
      },
      { role: 'tool', tool_call_id: call.call_id, content: '12 C, clear' }
    ])
  })

  // Catches items interleaved in the stream (pi ends thinking only once text has started), which
  // OpenAI never sends: each item is done before the next is added.
  test('streams reasoning, then text, one item at a time', async () => {
    const stream = await client().responses.create({
      model: 'mock/thinker',
      input: 'Why?',
      stream: true
    })
    const types: string[] = []
    for await (const event of stream) types.push(event.type)

    expect(types).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.reasoning_summary_part.added',
      'response.reasoning_summary_text.delta',
      'response.reasoning_summary_text.delta',
      'response.reasoning_summary_text.done',
      'response.reasoning_summary_part.done',
      'response.output_item.done',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed'
    ])
  })

  // Catches reasoning dropped from the answer, the token missing when asked for, or the model not
  // getting its reasoning back on the next turn: the stateless loop Codex CLI runs.
  test('returns reasoning, and replays it from encrypted_content', async () => {
    const sdk = client()
    const first = await sdk.responses.create({
      model: 'mock/thinker',
      input: 'Why?',
      include: ['reasoning.encrypted_content'],
      store: false
    })
    const reasoning = first.output.find((outputItem) => outputItem.type === 'reasoning')

    await sdk.responses.create({
      model: 'mock/thinker',
      input: [
        { role: 'user', content: 'Why?' },
        ...asInput(first.output),
        { role: 'user', content: 'And?' }
      ]
    })

    expect(reasoning).toMatchObject({
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'Thinking.' }],
      encrypted_content: expect.any(String) as unknown
    })
    expect(first.output_text).toBe('Done')
    expect(lastUpstream()['messages']).toMatchObject([
      { role: 'user', content: 'Why?' },
      { role: 'assistant', content: 'Done', reasoning_content: 'Thinking.' },
      { role: 'user', content: 'And?' }
    ])
  })

  // Catches the token sent when nobody asked for it, or an echoed reasoning item without one
  // silently left out: the proxy can't replay it, and says how to get one, as OpenAI refuses an
  // echoed reasoning item it has not stored.
  test('without include, reasoning has no token, and sending it back is refused', async () => {
    const first = await client().responses.create({ model: 'mock/thinker', input: 'Why?' })
    const reasoning = first.output.find((outputItem) => outputItem.type === 'reasoning')

    const echoed = await post({
      model: 'mock/thinker',
      input: [
        { role: 'user', content: 'Why?' },
        ...asInput(first.output),
        { role: 'user', content: 'And?' }
      ]
    })

    expect(reasoning !== undefined && 'encrypted_content' in reasoning).toBe(false)
    expect(echoed.status).toBe(HTTP_BAD_REQUEST)
    expect(echoed.body).toMatchObject({ error: { param: 'input.1.encrypted_content' } })
  })

  // Catches reasoning put on the wrong assistant turn when there are several, one of them empty:
  // each turn's token must reach that turn.
  test('replays each turn its own reasoning, across several turns', async () => {
    const sdk = client()
    const include: ['reasoning.encrypted_content'] = ['reasoning.encrypted_content']
    const first = await sdk.responses.create({ model: 'mock/thinker', input: 'One?', include })
    const second = await sdk.responses.create({ model: 'mock/thinker', input: 'Two?', include })

    await sdk.responses.create({
      model: 'mock/thinker',
      input: [
        { role: 'user', content: 'One?' },
        ...asInput(first.output),
        { role: 'user', content: 'Quiet?' },
        { role: 'assistant', content: '' },
        { role: 'user', content: 'Two?' },
        ...asInput(second.output),
        { role: 'user', content: 'Three?' }
      ]
    })

    const assistants = (lastUpstream()['messages'] as unknown[]).filter(
      (message) => isRecord(message) && message['role'] === 'assistant'
    )
    // pi sends no empty assistant message upstream; the two around it keep their own reasoning.
    expect(assistants).toEqual([
      expect.objectContaining({ content: 'Done', reasoning_content: 'Thinking.' }),
      expect.objectContaining({ content: 'Done', reasoning_content: 'Thinking.' })
    ])
  })

  // Catches reasoning replayed to a model that did not produce it (its signature means nothing
  // there), or a forged token with an API no model has reaching any model.
  test('replays a token only to the model that produced it', async () => {
    const first = await client().responses.create({
      model: 'mock/thinker',
      input: 'Why?',
      include: ['reasoning.encrypted_content']
    })
    const forged = Buffer.from(
      JSON.stringify({
        version: 1,
        provider: 'mock',
        api: 'not-an-api',
        model: 'thinker',
        thinking: 'Forged.',
        signature: 'reasoning_content'
      })
    ).toString('base64url')

    const otherModel = await post({
      model: 'mock/text',
      input: [
        { role: 'user', content: 'Why?' },
        ...asInput(first.output),
        { role: 'user', content: 'And?' }
      ]
    })
    const otherAssistant = (lastUpstream()['messages'] as unknown[])[1]
    const forgedApi = await post({
      model: 'mock/thinker',
      input: [
        { role: 'user', content: 'Why?' },
        { type: 'reasoning', id: 'rs_x', summary: [], encrypted_content: forged },
        { role: 'assistant', content: 'Done' },
        { role: 'user', content: 'And?' }
      ]
    })
    const forgedAssistant = (lastUpstream()['messages'] as unknown[])[1]

    expect([otherModel.status, forgedApi.status]).toEqual([200, 200])
    expect(isRecord(otherAssistant) && 'reasoning_content' in otherAssistant).toBe(false)
    expect(isRecord(forgedAssistant) && 'reasoning_content' in forgedAssistant).toBe(false)
  })

  // Catches reasoning that nothing followed being sent with no turn to go on, or dropped.
  test('refuses reasoning that no message or call follows', async () => {
    const first = await client().responses.create({
      model: 'mock/thinker',
      input: 'Why?',
      include: ['reasoning.encrypted_content']
    })
    const reasoning = first.output.find((outputItem) => outputItem.type === 'reasoning')

    const answer = await post({
      model: 'mock/thinker',
      input: [{ role: 'user', content: 'Why?' }, reasoning, { role: 'user', content: 'And?' }]
    })

    expect(answer.status).toBe(HTTP_BAD_REQUEST)
    expect(answer.body).toMatchObject({ error: { param: 'input.1' } })
  })

  // Catches an image part dropped or misplaced on the way to the model.
  test('sends an input image', async () => {
    await client().responses.create({
      model: 'mock/text',
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'What is this?' },
            { type: 'input_image', image_url: PNG_DATA_URI, detail: 'auto' }
          ]
        }
      ]
    })

    expect(lastUpstream()['messages']).toMatchObject([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          { type: 'image_url', image_url: { url: PNG_DATA_URI } }
        ]
      }
    ])
  })

  // Catches the effort report and a length stop lost in translation: they come from the chat
  // route's code, which this one runs through.
  test('reports the effort it ran at, and a length stop as incomplete', async () => {
    const answer = await post({ model: 'mock/long', input: 'Hi', reasoning: { effort: 'high' } })

    expect(answer.body).toMatchObject({
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      x_pi: { reasoning_effort: { requested: 'high', applied: 'none' } }
    })
  })

  // Catches a field that needs state, or a hosted tool, accepted and ignored instead of refused by
  // name (constitution principle I).
  test.each([
    [{ previous_response_id: 'resp_1' }, 'previous_response_id'],
    [{ conversation: 'conv_1' }, 'conversation'],
    [{ store: true }, 'store'],
    [{ tools: [{ type: 'web_search' }] }, 'tools.0.type'],
    [{ include: ['message.output_text.logprobs'] }, 'include.0'],
    [{ top_logprobs: 2 }, 'top_logprobs'],
    [{ verbosity: 'low' }, 'verbosity']
  ])('refuses %j by name', async (extra, param) => {
    const answer = await post({ model: 'mock/text', input: 'Hi', ...extra })

    expect(answer.status).toBe(HTTP_UNPROCESSABLE_ENTITY)
    expect(answer.body).toMatchObject({ error: { param } })
  })

  // Catches a forged or corrupted token replayed as if the proxy had written it.
  test('refuses an encrypted_content it did not write', async () => {
    const answer = await post({
      model: 'mock/text',
      input: [
        { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'not-a-token' },
        { role: 'user', content: 'Hi' }
      ]
    })

    expect(answer.status).toBe(HTTP_BAD_REQUEST)
    expect(answer.body).toMatchObject({ error: { param: 'input.0.encrypted_content' } })
  })

  // Catches an item of a type the proxy doesn't take reported at the whole item instead of its
  // `type`: every branch's `type` or `role` differs, so all are set aside, and then compared again
  // as before #318 rather than giving up at the union.
  test('refuses an input item of an unknown type at its type', async () => {
    const answer = await post({
      model: 'mock/text',
      input: [{ type: 'web_search_call', id: 'ws_1', status: 'completed' }]
    })

    expect(answer.status).toBe(HTTP_BAD_REQUEST)
    expect(answer.body).toMatchObject({ error: { param: 'input.0.type' } })
  })

  // Catches a function tool's or a json_schema format's description trimmed on this route's own
  // schema (#255): the model reads it, and a list or a trailing example lost its layout.
  test('keeps the whitespace of tool and json_schema descriptions', async () => {
    const tool = '  Run it.\n  - once\n'
    const format = '\n  one field\n'
    const answer = await post({
      model: 'mock/text',
      input: 'Hi',
      tools: [{ type: 'function', name: 'run', description: tool }],
      text: {
        format: {
          type: 'json_schema',
          name: 'answer',
          description: format,
          schema: { type: 'object' }
        }
      }
    })

    expect(answer.status).toBe(HTTP_OK)
    expect(lastUpstream()['tools']).toEqual([
      expect.objectContaining({ function: expect.objectContaining({ description: tool }) })
    ])
    expect(lastUpstream()['response_format']).toMatchObject({
      json_schema: { description: format }
    })
  })

  // Catches a replayed assistant turn refused for the empty `annotations`/`logprobs` the SDK
  // echoes back, or a non-empty one accepted though the proxy can't send it on, or refused with
  // another item type's field named (#318: it said `content.0.type`, "expected reasoning_text").
  test.each(['annotations', 'logprobs'])(
    'takes an empty %s on a replayed output_text, and refuses a non-empty one',
    async (field) => {
      const turn = (value: unknown[]): unknown => ({
        model: 'mock/text',
        input: [
          { role: 'user', content: 'Hi' },
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Hello', [field]: value }]
          },
          { role: 'user', content: 'Again' }
        ]
      })

      const empty = await post(turn([]))
      const filled = await post(turn([{ token: 'Hello', logprob: 0 }]))

      expect(empty.status).toBe(HTTP_OK)
      expect(filled.status).toBe(HTTP_BAD_REQUEST)
      expect(filled.body).toMatchObject({
        error: { param: expect.stringMatching(new RegExp(`^input\\.1\\.content\\.0\\.${field}`)) }
      })
    }
  )

  // Catches the stored-response operations answering the generic unknown-route 404, or worse,
  // falling through to another route.
  test.each([
    ['GET', '/v1/responses/resp_1'],
    ['DELETE', '/v1/responses/resp_1'],
    ['POST', '/v1/responses/resp_1/cancel'],
    ['POST', '/v1/responses/compact']
  ])('%s %s is not supported', async (method, path) => {
    const response = await app().request(path, { method })

    expect(response.status).toBe(HTTP_NOT_FOUND)
    expect(JSON.stringify(await jsonBody(response))).toContain('is not supported by this proxy')
  })
})
