/**
 * The stable surface, checked against OpenAI's published OpenAPI spec (#132), pinned in
 * `test/fixtures/openai-spec/openapi-subset.json` (`pnpm run openai-spec:update <commit>`).
 *
 * Responses: every body the three stable routes send (the model list and model object, chat
 * completions streamed and not, and each error status) is validated against OpenAI's schema for
 * it. The real app answers, with pi's real provider client in front of the mock provider.
 *
 * Requests: every field and enum value the proxy accepts must exist in OpenAI's request, and each
 * one OpenAI defines that the proxy does not accept is listed here with what the proxy does
 * instead. A spec bump that adds a field or a value fails until it is listed or accepted.
 *
 * Fields the proxy adds (`x_pi`, `prompt_tokens_details.cache_write_tokens`) pass because
 * OpenAI's schemas leave `additionalProperties` open; a spec that closes one fails here.
 */

import { readFileSync } from 'node:fs'

import { chatCompletionRequestSchema, rejectedFields } from '@proxy/openai/schemas'
import { isRecord } from '@proxy/utils/guards'
import { Ajv2020 } from 'ajv/dist/2020'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vite-plus/test'
import * as z from 'zod'

import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'
import {
  cutOff,
  finishChunk,
  httpError,
  type MockProvider,
  silent,
  sse,
  startMockProvider,
  textChunks,
  toolCallChunks
} from '../fixtures/mock-provider'
import { jsonBody, testApp, testConfig } from '../helpers'

const HTTP_OK = 200
const HTTP_BAD_REQUEST = 400
const HTTP_UNAUTHORIZED = 401
const HTTP_NOT_FOUND = 404
const HTTP_PAYLOAD_TOO_LARGE = 413
const HTTP_UNPROCESSABLE_ENTITY = 422
const HTTP_TOO_MANY_REQUESTS = 429
const HTTP_INTERNAL_SERVER_ERROR = 500
const HTTP_BAD_GATEWAY = 502
const HTTP_SERVICE_UNAVAILABLE = 503
const HTTP_GATEWAY_TIMEOUT = 504
/** Short enough that the silent provider times out quickly. */
const SHORT_UPSTREAM_TIMEOUT_MS = 50
/** Smaller than any chat request body. */
const TINY_BODY_LIMIT = 10
const PROXY_TOKEN = 'notarealsecret-openai-spec-token'
/** A field the proxy rejects by name; a computed key, since its name is one letter (`n`). */
const REJECTED_FIELD = rejectedFields[0]
/** The `$id` the pinned subset is registered under. */
const SPEC_ID = 'openai'
const USAGE = { prompt_tokens: 3, completion_tokens: 2 }

/** The part of the pinned subset the checks read. */
const subsetSchema = z.object({
  'x-source': z.object({ commit: z.string().trim() }),
  'components': z.object({ schemas: z.record(z.string(), z.unknown()) })
})
const subset = subsetSchema.parse(
  JSON.parse(
    readFileSync(new URL('../fixtures/openai-spec/openapi-subset.json', import.meta.url), 'utf8')
  )
)
const openaiSchemas = subset.components.schemas

// `strict: false`: the spec carries OpenAPI keywords that are not JSON Schema (`discriminator`).
// Formats are not checked: no format plugin is installed, and none of the checked shapes depends
// on one.
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false, logger: false })
ajv.addSchema({ $id: SPEC_ID, components: subset.components })

/**
 * Validates a value against one of OpenAI's schemas.
 *
 * @param schemaName - the schema's name under `components.schemas`
 * @param value - the value to validate
 * @returns one line per violation, `<path> <message>`; empty when the value is valid
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
  const weatherCall = toolCallChunks(0, {
    id: 'call_a',
    name: 'get_weather',
    argumentParts: ['{"city":', '"Oslo"}']
  })
  const timeCall = toolCallChunks(1, {
    id: 'call_b',
    name: 'get_time',
    argumentParts: ['{"zone":', '"CET"}']
  })
  mock = await startMockProvider({
    'text': sse([...textChunks('Hel', 'lo'), finishChunk('stop', USAGE)]),
    'tools': sse([...weatherCall, ...timeCall, finishChunk('tool_calls', USAGE)]),
    'text-and-tool': sse([...textChunks('Checking'), ...weatherCall, finishChunk('tool_calls')]),
    'cut-off': cutOff('Hel', 'lo'),
    'upstream-401': httpError(HTTP_UNAUTHORIZED, {
      error: {
        message: 'Incorrect API key',
        type: 'invalid_request_error',
        code: 'invalid_api_key'
      }
    }),
    'upstream-429': httpError(HTTP_TOO_MANY_REQUESTS, {
      error: { message: 'Rate limit reached', type: 'tokens', code: 'rate_limit_exceeded' }
    }),
    'upstream-500': httpError(HTTP_INTERNAL_SERVER_ERROR, {
      error: { message: 'The server had an error', type: 'server_error' }
    }),
    'upstream-503': httpError(HTTP_SERVICE_UNAVAILABLE, {
      error: { message: 'The engine is overloaded', type: 'server_error' }
    }),
    'silent': silent()
  })
  agentDir = await loadFixtureAgentDir({ modelsJson: { providers: { mock: mock.provider() } } })
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await mock.close()
  agentDir.remove()
})

/**
 * Sends a chat completion request, with the `Content-Length` a real client sends.
 *
 * @param body - the request body; a string is sent as is, anything else as JSON
 * @param app - the app to ask; {@link testApp} with the default config when omitted
 * @returns the proxy's response
 */
async function chat(body: unknown, app = testApp()): Promise<Response> {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return app.request('/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(text))
    },
    body: text
  })
}

/**
 * Builds the smallest chat request for a mock model.
 *
 * @param model - the mock model ID
 * @param extra - more request fields
 * @returns the request body
 */
function ask(model: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { model: `mock/${model}`, messages: [{ role: 'user', content: 'Hi' }], ...extra }
}

/**
 * Parses an SSE body into its `data:` payloads, without the final `[DONE]`.
 *
 * @param body - the response text
 * @returns each JSON payload, in order
 */
function dataPayloads(body: string): unknown[] {
  return body
    .split('\n\n')
    .filter((event) => event.startsWith('data: {'))
    .map((event): unknown => JSON.parse(event.slice('data: '.length)))
}

describe('responses validate against OpenAI schemas', () => {
  // Catches a model list or model object reshaped away from OpenAI's (a field renamed, retyped or
  // dropped), which strict typed clients reject.
  test('GET /v1/models is a ListModelsResponse, and its first model a Model', async () => {
    const list = await jsonBody(await testApp().request('/v1/models'))
    const data = isRecord(list) && Array.isArray(list['data']) ? list['data'] : []
    const first: unknown = data[0]
    const id = isRecord(first) && typeof first['id'] === 'string' ? first['id'] : ''
    const detail = await testApp().request(`/v1/models/${encodeURIComponent(id)}`)

    expect(violations('ListModelsResponse', list)).toEqual([])
    expect(data.length).toBeGreaterThan(0)
    expect(detail.status).toBe(HTTP_OK)
    expect(violations('Model', await jsonBody(detail))).toEqual([])
  })

  // Catches a non-streaming completion that leaves out a field OpenAI requires (#132 found
  // `choices[].logprobs` missing) or sends one with the wrong type (`system_fingerprint: null`).
  test.each(['text', 'tools', 'text-and-tool'])(
    'a non-streaming %s answer is a CreateChatCompletionResponse',
    async (model) => {
      const response = await chat(ask(model))

      expect(response.status).toBe(HTTP_OK)
      expect(violations('CreateChatCompletionResponse', await jsonBody(response))).toEqual([])
    }
  )

  // Catches a stream chunk reshaped away from OpenAI's: the role, text, tool call, finish or usage
  // chunk, with or without `stream_options.include_usage`.
  test.each([
    ['text', true],
    ['text', false],
    ['tools', true],
    ['text-and-tool', false]
  ])(
    'every chunk of a streamed %s answer (usage %s) is a stream response',
    async (model, usage) => {
      const response = await chat(
        ask(model, { stream: true, ...(usage ? { stream_options: { include_usage: true } } : {}) })
      )
      const chunks = dataPayloads(await response.text())

      expect(response.status).toBe(HTTP_OK)
      expect(chunks.length).toBeGreaterThan(1)
      expect(
        chunks.flatMap((chunk) => violations('CreateChatCompletionStreamResponse', chunk))
      ).toEqual([])
    }
  )

  // Catches the error frame of a stream the provider drops partway sent in a shape OpenAI's
  // clients cannot read as an error.
  test('a stream the provider cuts off ends with an ErrorResponse frame', async () => {
    const response = await chat(ask('cut-off', { stream: true }))
    const payloads = dataPayloads(await response.text())
    const last = payloads.at(-1)

    expect(violations('ErrorResponse', last)).toEqual([])
    expect(
      payloads
        .slice(0, -1)
        .flatMap((chunk) => violations('CreateChatCompletionStreamResponse', chunk))
    ).toEqual([])
  })

  const proxyAuthApp = testApp({
    ...testConfig(),
    proxyAuth: { kind: 'token', token: PROXY_TOKEN }
  })
  const errorCases: readonly {
    readonly label: string
    readonly send: () => Response | Promise<Response>
    readonly status: number
  }[] = [
    { label: 'invalid JSON', send: () => chat('{'), status: HTTP_BAD_REQUEST },
    {
      label: 'an out-of-range field',
      send: () => chat(ask('text', { temperature: 9 })),
      status: HTTP_BAD_REQUEST
    },
    {
      label: 'a rejected field',
      send: () => chat(ask('text', { [REJECTED_FIELD]: 2 })),
      status: HTTP_UNPROCESSABLE_ENTITY
    },
    {
      label: 'an unknown field',
      send: () => chat(ask('text', { not_a_field: true })),
      status: HTTP_UNPROCESSABLE_ENTITY
    },
    {
      label: 'an unknown model',
      send: () => chat({ model: 'nope/none', messages: [{ role: 'user', content: 'Hi' }] }),
      status: HTTP_NOT_FOUND
    },
    {
      label: 'an unknown model ID on the detail route',
      send: () => testApp().request('/v1/models/nope%2Fnone'),
      status: HTTP_NOT_FOUND
    },
    {
      label: 'an unsupported OpenAI endpoint',
      send: () => testApp().request('/v1/embeddings', { method: 'POST' }),
      status: HTTP_NOT_FOUND
    },
    {
      label: 'a missing proxy token',
      send: () => proxyAuthApp.request('/v1/models'),
      status: HTTP_UNAUTHORIZED
    },
    {
      label: 'a body over the size limit',
      send: () => chat(ask('text'), testApp({ ...testConfig(), maxBodySize: TINY_BODY_LIMIT })),
      status: HTTP_PAYLOAD_TOO_LARGE
    },
    {
      label: 'an upstream 401',
      send: () => chat(ask('upstream-401')),
      status: HTTP_BAD_GATEWAY
    },
    {
      label: 'an upstream 429',
      send: () => chat(ask('upstream-429')),
      status: HTTP_TOO_MANY_REQUESTS
    },
    {
      label: 'an upstream 500',
      send: () => chat(ask('upstream-500')),
      status: HTTP_BAD_GATEWAY
    },
    {
      label: 'an upstream 503',
      send: () => chat(ask('upstream-503')),
      status: HTTP_SERVICE_UNAVAILABLE
    },
    {
      label: 'an upstream that never answers',
      send: () =>
        chat(
          ask('silent'),
          testApp({ ...testConfig(), upstreamTimeoutMs: SHORT_UPSTREAM_TIMEOUT_MS })
        ),
      status: HTTP_GATEWAY_TIMEOUT
    }
  ]

  // Catches an error body OpenAI's clients cannot parse as an error: a renamed or retyped
  // `message`, `type`, `param` or `code`, or no `error` wrapper.
  test.each(errorCases)('$label answers $status with an ErrorResponse', async (errorCase) => {
    const response = await errorCase.send()

    expect(response.status).toBe(errorCase.status)
    expect(violations('ErrorResponse', await jsonBody(response))).toEqual([])
  })
})

// --- Requests ---

/** The proxy's request schema, as JSON Schema, in the shape a client sends it. */
const proxyRequestSchema: unknown = z.toJSONSchema(chatCompletionRequestSchema, { io: 'input' })
/** How a schema reference to another OpenAI schema starts. */
const SCHEMA_REF_PREFIX = '#/components/schemas/'

/**
 * Follows a `$ref` to an OpenAI schema; any other node is returned as is.
 *
 * @param node - a schema node
 * @returns the node, or the schema it references
 */
function resolve(node: unknown): Record<string, unknown> {
  if (!isRecord(node)) return {}
  const ref = node['$ref']
  if (typeof ref !== 'string' || !ref.startsWith(SCHEMA_REF_PREFIX)) return node
  return resolve(openaiSchemas[ref.slice(SCHEMA_REF_PREFIX.length)])
}

/**
 * Lists the array items of a schema node's `key`, or nothing.
 *
 * @param node - a schema node
 * @param key - `allOf`, `anyOf` or `oneOf`
 * @returns the branches
 */
function branches(node: Record<string, unknown>, key: string): unknown[] {
  const value = node[key]
  return Array.isArray(value) ? value : []
}

/**
 * Collects an object schema's properties, through `$ref` and `allOf`.
 *
 * @param node - an object schema
 * @returns every property schema, by name
 */
function propertiesOf(node: unknown): Record<string, unknown> {
  const schema = resolve(node)
  const own = isRecord(schema['properties']) ? schema['properties'] : {}
  const inherited: Record<string, unknown> = {}
  for (const branch of branches(schema, 'allOf')) Object.assign(inherited, propertiesOf(branch))
  return { ...inherited, ...own }
}

/**
 * Collects an object schema's required property names, through `$ref` and `allOf`.
 *
 * @param node - an object schema
 * @returns the required names
 */
function requiredOf(node: unknown): string[] {
  const schema = resolve(node)
  const own = Array.isArray(schema['required']) ? schema['required'] : []
  return [
    ...branches(schema, 'allOf').flatMap(requiredOf),
    ...own.filter((requiredName): requiredName is string => typeof requiredName === 'string')
  ]
}

/**
 * Lists the string literals a schema node allows directly: its `enum` strings and `const`.
 *
 * @param node - a resolved schema node
 * @returns the literals
 */
function literalsOf(node: Record<string, unknown>): string[] {
  const values = [...branches(node, 'enum'), node['const']]
  return values.filter((literal): literal is string => typeof literal === 'string')
}

/**
 * Lists the alternatives a schema allows: string literals, and for object branches the value of
 * their discriminator property, as `<discriminator>: <value>`.
 *
 * @param node - the schema
 * @param discriminator - the property that tells object branches apart (`type`, `role`)
 * @returns the alternatives, sorted and without repeats
 */
function alternatives(node: unknown, discriminator: string): string[] {
  const schema = resolve(node)
  const unionBranches = [...branches(schema, 'anyOf'), ...branches(schema, 'oneOf')]
  const found =
    unionBranches.length > 0
      ? unionBranches.flatMap((branch) => alternatives(branch, discriminator))
      : literalsOf(schema)
  if (found.length > 0 || unionBranches.length > 0) return [...new Set(found)].toSorted()
  const tag = propertiesOf(schema)[discriminator]
  return literalsOf(resolve(tag)).map((literal) => `${discriminator}: ${literal}`)
}

/**
 * The schema of one request field, or of its array items.
 *
 * @param request - the request schema
 * @param field - the top-level field
 * @param items - whether to take the field's `items`
 * @returns the field's (or its items') schema
 */
function fieldSchema(request: unknown, field: string, items: boolean): unknown {
  const schema = resolve(propertiesOf(request)[field])
  return items ? schema['items'] : schema
}

const openaiRequestSchema = openaiSchemas['CreateChatCompletionRequest']

/** Why the proxy rejects a field OpenAI defines. */
const NAMED_REJECTION = 'rejected with a named 422 (`rejectedFields`)'
const UNKNOWN_REJECTION = 'rejected as an unknown parameter (422)'

/** OpenAI request fields the proxy does not accept, with what it does instead. */
const FIELDS_NOT_ACCEPTED: Readonly<Record<string, string>> = {
  ...Object.fromEntries(rejectedFields.map((field) => [field, NAMED_REJECTION])),
  prompt_cache_key: `${UNKNOWN_REJECTION}; accepting it is #39`,
  prompt_cache_retention: `${UNKNOWN_REJECTION}; decided with #39`,
  prompt_cache_options: `${UNKNOWN_REJECTION}; decided with #39`,
  safety_identifier: UNKNOWN_REJECTION,
  service_tier: UNKNOWN_REJECTION,
  store: UNKNOWN_REJECTION,
  modalities: `${UNKNOWN_REJECTION}; the proxy answers in text only`,
  audio: `${UNKNOWN_REJECTION}; the proxy answers in text only`,
  verbosity: UNKNOWN_REJECTION,
  web_search_options: UNKNOWN_REJECTION,
  moderation: UNKNOWN_REJECTION
}

/** A request field whose alternatives (enum values, union branches) are tracked. */
interface TrackedAlternatives {
  readonly field: string
  /** Whether the alternatives are those of the field's array items. */
  readonly items: boolean
  readonly discriminator: string
  /** OpenAI alternatives the proxy does not accept, with what it does instead. */
  readonly notAccepted: Readonly<Record<string, string>>
}

const TRACKED_ALTERNATIVES: readonly TrackedAlternatives[] = [
  {
    field: 'messages',
    items: true,
    discriminator: 'role',
    notAccepted: { 'role: function': 'rejected (400): deprecated, superseded by `tool` messages' }
  },
  { field: 'reasoning_effort', items: false, discriminator: 'type', notAccepted: {} },
  {
    field: 'tool_choice',
    items: false,
    discriminator: 'type',
    notAccepted: {
      'type: allowed_tools': 'rejected (400): only function tools are accepted',
      'type: custom': 'rejected (400): only function tools are accepted'
    }
  },
  {
    field: 'tools',
    items: true,
    discriminator: 'type',
    notAccepted: { 'type: custom': 'rejected (400): only function tools are accepted' }
  },
  { field: 'response_format', items: false, discriminator: 'type', notAccepted: {} }
]

/** Requests the proxy accepts, each of which OpenAI's request schema must accept too. */
const ACCEPTED_REQUESTS: readonly { readonly label: string; readonly body: unknown }[] = [
  { label: 'a minimal request', body: { model: 'm', messages: [{ role: 'user', content: 'Hi' }] } },
  {
    label: 'every message role, image parts and a tool round trip',
    body: {
      model: 'm',
      messages: [
        { role: 'system', content: 'Be brief.', name: 'rules' },
        { role: 'developer', content: 'Answer in English.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA', detail: 'low' } }
          ]
        },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_a', type: 'function', function: { name: 'look', arguments: '{}' } }
          ]
        },
        { role: 'tool', content: 'a cat', tool_call_id: 'call_a' }
      ]
    }
  },
  {
    label: 'tools with a named tool choice',
    body: {
      model: 'm',
      messages: [{ role: 'user', content: 'Weather?' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Current weather',
            parameters: { type: 'object', properties: { city: { type: 'string' } } },
            strict: true
          }
        }
      ],
      tool_choice: { type: 'function', function: { name: 'get_weather' } },
      parallel_tool_calls: false
    }
  },
  {
    label: 'every sampling and output field',
    body: {
      model: 'm',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
      stream_options: { include_usage: true },
      temperature: 1,
      top_p: 0.5,
      frequency_penalty: 1,
      presence_penalty: -1,
      seed: 7,
      max_tokens: 10,
      max_completion_tokens: 10,
      stop: ['END', 'STOP'],
      user: 'u-1',
      reasoning_effort: 'max',
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'answer', schema: { type: 'object' }, strict: true }
      },
      metadata: { purpose: 'test' },
      prediction: { type: 'content', content: 'Hello' }
    }
  },
  {
    label: 'a string stop and a JSON object format',
    body: {
      model: 'm',
      messages: [{ role: 'user', content: 'Hi' }],
      stop: 'END',
      tool_choice: 'auto',
      response_format: { type: 'json_object' }
    }
  }
]

describe(`the request schema stays within OpenAI's (spec ${subset['x-source'].commit.slice(0, 7)})`, () => {
  const proxyFields = Object.keys(propertiesOf(proxyRequestSchema)).toSorted()
  const openaiFields = Object.keys(propertiesOf(openaiRequestSchema)).toSorted()

  // Catches a field the proxy accepts that OpenAI's API does not have: a client written against
  // OpenAI never sends it, and a typo in the schema goes unnoticed.
  test('every field the proxy accepts is an OpenAI request field', () => {
    expect(proxyFields.filter((field) => !openaiFields.includes(field))).toEqual([])
  })

  // Catches a new OpenAI field after a spec bump, and a field the proxy starts accepting without
  // its entry here going: each must be decided, not left to the unknown-parameter error.
  test('every OpenAI request field the proxy does not accept is listed with its reason', () => {
    expect(openaiFields.filter((field) => !proxyFields.includes(field))).toEqual(
      Object.keys(FIELDS_NOT_ACCEPTED).toSorted()
    )
  })

  // Catches the proxy requiring a field OpenAI leaves optional, which rejects valid requests.
  test('every field the proxy requires is required by OpenAI', () => {
    const openaiRequired = requiredOf(openaiRequestSchema)
    expect(
      requiredOf(proxyRequestSchema).filter((field) => !openaiRequired.includes(field))
    ).toEqual([])
  })

  // Catches an enum value or union branch the proxy accepts that OpenAI does not, and a new
  // OpenAI one after a spec bump that is neither accepted nor listed.
  test.each(TRACKED_ALTERNATIVES)(
    '$field: accepted alternatives are OpenAI ones, the rest listed',
    ({ field, items, discriminator, notAccepted }) => {
      const proxyValues = alternatives(fieldSchema(proxyRequestSchema, field, items), discriminator)
      const openaiValues = alternatives(
        fieldSchema(openaiRequestSchema, field, items),
        discriminator
      )

      expect(proxyValues.length).toBeGreaterThan(0)
      expect(proxyValues.filter((alternative) => !openaiValues.includes(alternative))).toEqual([])
      expect(openaiValues.filter((alternative) => !proxyValues.includes(alternative))).toEqual(
        Object.keys(notAccepted).toSorted()
      )
    }
  )

  // Catches a request shape the proxy accepts that OpenAI's schema rejects: a nested field
  // misnamed or typed differently, so a request written for this proxy fails against OpenAI.
  test.each(ACCEPTED_REQUESTS)('$label is valid for both', ({ body }) => {
    expect(chatCompletionRequestSchema.safeParse(body).success).toBe(true)
    expect(violations('CreateChatCompletionRequest', body)).toEqual([])
  })
})
