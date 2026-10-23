/**
 * The experimental Responses API (#140), checked against OpenAI's published spec as the stable
 * surface is (#132), pinned in `test/fixtures/openai-spec/openapi-subset.json`.
 *
 * Responses: every body and stream event the route sends (text, a tool call, reasoning with its
 * token, a length stop, a stream an upstream error ends) validates against OpenAI's `Response` and
 * `ResponseStreamEvent` schemas. Requests: every field the proxy accepts is a `CreateResponse`
 * field, each one it does not accept is in `RESPONSES_REJECTED_FIELDS` with its reason, and the
 * requests the proxy accepts are valid for OpenAI too.
 */

import {
  createResponseRequestSchema,
  RESPONSES_REJECTED_FIELDS
} from '@proxy/openai/responses-api/request-schema'
import { isRecord } from '@proxy/utils/guards'
import { Ajv2020 } from 'ajv/dist/2020'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'
import {
  chunk,
  cutOff,
  finishChunk,
  type MockProvider,
  sse,
  startMockProvider,
  textChunks,
  toolCallChunks
} from '../fixtures/mock-provider'
import {
  openaiResponsesRequestSchema,
  propertiesOf,
  proxyResponsesRequestSchema,
  requiredOf,
  subset
} from '../fixtures/openai-spec/schema'
import { jsonBody, testApp, testConfig } from '../helpers'

/** The `$id` the pinned subset is registered under. */
const SPEC_ID = 'openai'
const USAGE = { prompt_tokens: 3, completion_tokens: 2 }

// As in the chat spec check: OpenAPI keywords are not JSON Schema, and formats are not checked.
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false, logger: false })
ajv.addSchema({ $id: SPEC_ID, components: subset.components })

/**
 * Validates a value against one of OpenAI's schemas.
 *
 * @param schemaName - the schema's name under `components.schemas`
 * @param value - the value to validate
 * @returns one line per violation; empty when the value is valid
 */
function violations(schemaName: string, value: unknown): string[] {
  const validate = ajv.getSchema(`${SPEC_ID}#/components/schemas/${schemaName}`)
  if (validate === undefined) throw new Error(`No schema '${schemaName}' in the pinned subset`)
  if (validate(value) === true) return []
  return (validate.errors ?? []).map(
    (error) => `${error.instancePath || '/'} ${error.message ?? error.keyword}`
  )
}

let mock: MockProvider
let agentDir: FixtureAgentDir

beforeAll(async () => {
  mock = await startMockProvider({
    'text': sse([...textChunks('Hel', 'lo'), finishChunk('stop', USAGE)]),
    'tools': sse([
      ...toolCallChunks(0, {
        id: 'call_a',
        name: 'get_weather',
        argumentParts: ['{"city":"Oslo"}']
      }),
      finishChunk('tool_calls', USAGE)
    ]),
    'thinker': sse([
      chunk({ role: 'assistant', reasoning_content: 'Thinking.' }),
      ...textChunks('Done'),
      finishChunk('stop', USAGE)
    ]),
    'long': sse([...textChunks('Cut'), finishChunk('length', USAGE)]),
    'cut-off': cutOff('Hel', 'lo')
  })
  agentDir = await loadFixtureAgentDir({
    modelsJson: {
      providers: {
        mock: {
          ...mock.provider(),
          models: [
            { id: 'text' },
            { id: 'tools' },
            { id: 'thinker', reasoning: true },
            { id: 'long' },
            { id: 'cut-off' }
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
 * Sends a Responses request to the app with the API on.
 *
 * @param body - the request body
 * @returns the proxy's response
 */
function create(body: Record<string, unknown>): Promise<Response> | Response {
  return testApp({ ...testConfig(), responsesApiEnabled: true }).request('/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}

/**
 * Parses a Responses stream into its events.
 *
 * @param text - the response text
 * @returns each event's JSON payload, in order
 */
function events(text: string): unknown[] {
  return text
    .split('\n\n')
    .map((frame) => frame.split('\n').find((line) => line.startsWith('data: ')))
    .filter((line): line is string => line !== undefined)
    .map((line): unknown => JSON.parse(line.slice('data: '.length)))
}

/** A Responses request per answer shape the route produces. */
const ANSWERS = [
  { label: 'text', body: { model: 'mock/text', input: 'Hi', instructions: 'Be brief.' } },
  {
    label: 'a function call',
    body: {
      model: 'mock/tools',
      input: 'Weather?',
      tools: [
        { type: 'function', name: 'get_weather', parameters: { type: 'object' }, strict: true }
      ],
      tool_choice: 'required'
    }
  },
  {
    label: 'reasoning with its token',
    body: {
      model: 'mock/thinker',
      input: 'Why?',
      include: ['reasoning.encrypted_content'],
      reasoning: { effort: 'high', summary: 'auto' }
    }
  },
  { label: 'a length stop', body: { model: 'mock/long', input: 'Hi', max_output_tokens: 3 } }
]

describe('Responses API answers validate against OpenAI schemas', () => {
  // Catches a response reshaped away from OpenAI's (a required field missing, an item misnamed),
  // which the SDK's typed clients and strict parsers reject.
  test.each(ANSWERS)('non-streamed: $label is a Response', async ({ body }) => {
    const response = await create(body)
    const answer = await jsonBody(response)

    expect(response.status).toBe(200)
    expect(violations('Response', answer)).toEqual([])
  })

  // Catches an event OpenAI's schema rejects (a missing `sequence_number`, `logprobs` or
  // `item_id`), and a stream without its terminal event.
  test.each(ANSWERS)(
    'streamed: every event of $label is a ResponseStreamEvent',
    async ({ body }) => {
      const response = await create({ ...body, stream: true })
      const streamed = events(await response.text())

      expect(streamed.length).toBeGreaterThan(2)
      for (const event of streamed) expect(violations('ResponseStreamEvent', event)).toEqual([])
      const last = streamed.at(-1)
      expect(isRecord(last) ? last['type'] : undefined).toMatch(
        /^response\.(completed|incomplete)$/u
      )
    }
  )

  // Catches a stream an upstream failure ends with a body OpenAI's schema rejects, or none.
  test('a stream the provider cuts off ends with response.failed', async () => {
    const response = await create({ model: 'mock/cut-off', input: 'Hi', stream: true })
    const streamed = events(await response.text())

    for (const event of streamed) expect(violations('ResponseStreamEvent', event)).toEqual([])
    expect(streamed.at(-1)).toMatchObject({
      type: 'response.failed',
      response: { status: 'failed' }
    })
  })
})

/** Requests the proxy accepts, which must be valid for OpenAI too. */
const ACCEPTED_REQUESTS = [
  { label: 'a string input', body: { model: 'm', input: 'Hi' } },
  {
    label: 'every input item kind',
    body: {
      model: 'm',
      instructions: 'Be brief.',
      input: [
        { role: 'developer', content: 'Answer in English.' },
        // A string: OpenAI's own schema matches a part list on a user message twice
        // (`EasyInputMessage` and `InputMessage`), which its `oneOf` refuses.
        { type: 'message', role: 'user', content: 'What is this?' },
        {
          type: 'reasoning',
          id: 'rs_1',
          summary: [{ type: 'summary_text', text: 'Hm.' }],
          encrypted_content: 'x'
        },
        {
          type: 'message',
          role: 'assistant',
          id: 'msg_1',
          status: 'completed',
          content: [{ type: 'output_text', text: 'A cat?', annotations: [], logprobs: [] }]
        },
        {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_a',
          name: 'look',
          arguments: '{}',
          status: 'completed'
        },
        { type: 'function_call_output', call_id: 'call_a', output: 'a cat' }
      ]
    }
  },
  {
    label: 'every setting',
    body: {
      model: 'm',
      input: 'Hi',
      stream: true,
      stream_options: { include_obfuscation: false },
      tools: [
        {
          type: 'function',
          name: 'get_weather',
          description: 'Current weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
          strict: true
        }
      ],
      tool_choice: { type: 'function', name: 'get_weather' },
      parallel_tool_calls: false,
      temperature: 1,
      top_p: 0.5,
      max_output_tokens: 100,
      reasoning: { effort: 'max', summary: 'auto' },
      text: {
        format: { type: 'json_schema', name: 'answer', schema: { type: 'object' }, strict: true }
      },
      metadata: { purpose: 'test' },
      user: 'u-1',
      prompt_cache_key: 'session-1',
      store: false,
      include: ['reasoning.encrypted_content']
    }
  }
]

describe(`the Responses request schema stays within OpenAI's (spec ${subset['x-source'].commit.slice(0, 7)})`, () => {
  const proxyFields = Object.keys(propertiesOf(proxyResponsesRequestSchema)).toSorted()
  const openaiFields = Object.keys(propertiesOf(openaiResponsesRequestSchema)).toSorted()

  // Catches a field the proxy accepts that OpenAI's API does not have.
  test('every field the proxy accepts is a CreateResponse field', () => {
    expect(proxyFields.filter((field) => !openaiFields.includes(field))).toEqual([])
  })

  // Catches a new OpenAI field after a spec bump, or one the proxy neither accepts nor refuses by
  // name with its reason.
  test('every CreateResponse field the proxy does not accept is refused by name', () => {
    expect(openaiFields.filter((field) => !proxyFields.includes(field))).toEqual(
      Object.keys(RESPONSES_REJECTED_FIELDS).toSorted()
    )
  })

  // Catches the proxy requiring a field OpenAI leaves optional, beyond the two it needs to run:
  // a model, and something to answer.
  test('the proxy requires only the model and the input', () => {
    const openaiRequired = requiredOf(openaiResponsesRequestSchema)
    expect(
      requiredOf(proxyResponsesRequestSchema).filter((field) => !openaiRequired.includes(field))
    ).toEqual(['model', 'input'])
  })

  // Catches a request shape the proxy accepts that OpenAI's schema rejects.
  test.each(ACCEPTED_REQUESTS)('$label is valid for both', ({ body }) => {
    expect(createResponseRequestSchema.safeParse(body).success).toBe(true)
    expect(violations('CreateResponse', body)).toEqual([])
  })
})
