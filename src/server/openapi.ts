/**
 * The proxy's OpenAPI description (#129): what each documented route accepts and answers, and the
 * document they are assembled into.
 *
 * @remarks
 * The routes apply these with hono-openapi's `describeRoute`, which only marks a route for the
 * document; validation stays in each handler (`validateChatRequest`), whose 400/422 split and
 * error wording the document describes but does not drive. The schemas are the ones the handlers
 * type their bodies with, so the document cannot describe a field the code does not send.
 *
 * Documented: the stable routes and the `/v1/switchboard/` routes. Not documented: the health
 * endpoints (operational, and their bodies are not shape-locked), the OpenAI endpoints the proxy
 * answers with 404, and the document and docs UI themselves.
 *
 * `openapi.json` at the repository root is this document as committed; a test fails when the
 * routes no longer produce it, so a contract change shows up in review.
 *
 * @packageDocumentation
 */

import { openAIModelListSchema, openAIModelSchema, piModelListSchema } from '@proxy/openai/models'
import { openAIChatCompletionSchema } from '@proxy/openai/responses'
import { chatCompletionRequestSchema } from '@proxy/openai/schemas'
import { sseChunkSchema } from '@proxy/openai/sse'
import { openAIErrorSchema } from '@proxy/server/errors'
import { type DescribeRouteOptions, type GenerateSpecOptions, resolver } from 'hono-openapi'
import type * as z from 'zod'

/** The prefix of the proxy's own routes, outside OpenAI's API (constitution, principle I). */
export const SWITCHBOARD_PREFIX = '/v1/switchboard'
/** Where the OpenAPI document is served. */
export const OPENAPI_PATH = `${SWITCHBOARD_PREFIX}/openapi.json`
/** Where the opt-in docs UI is served: outside `/v1`, at the root, for a browser. */
export const DOCS_PATH = '/docs'
/**
 * The `swagger-ui-dist` version the docs page loads from the jsDelivr CDN. Pinned, so a new
 * release is never loaded unreviewed; not bundled, because the package depends on an install-time
 * analytics script (#129).
 */
export const SWAGGER_UI_VERSION = '5.34.0'

/** Tag of the OpenAI-compatible routes. */
const OPENAI_TAG = 'OpenAI-compatible'
/** Tag of the `/v1/switchboard/` routes. */
const SWITCHBOARD_TAG = 'Switchboard'
/** Tag of the health endpoints. */
export const OPERATIONAL_TAG = 'Operational'
/** Tag of this document and the docs page. */
const DOCUMENTATION_TAG = 'Documentation'
/** Tag of the OpenAI endpoints the proxy answers with 404. */
const NOT_SUPPORTED_TAG = 'Not supported'
/** The name the bearer scheme is registered under. */
const PROXY_AUTH_SCHEME = 'proxyAuth'
/** The shared response the unsupported endpoints reference. */
const NOT_SUPPORTED_RESPONSE = 'NotSupported'

/**
 * OpenAI endpoints the proxy does not implement; each answers 404 with a clear message, whatever
 * the method. A trailing `/*` covers the path and everything under it.
 */
export const UNSUPPORTED_ENDPOINTS = [
  '/v1/completions',
  '/v1/embeddings',
  '/v1/audio/*',
  '/v1/images/*',
  '/v1/assistants',
  '/v1/assistants/*',
  '/v1/threads',
  '/v1/threads/*',
  '/v1/files',
  '/v1/files/*',
  '/v1/batches',
  '/v1/batches/*',
  '/v1/fine_tuning/*'
] as const

/** A documented response: a description and a JSON body. */
export type DocumentedResponse = NonNullable<DescribeRouteOptions['responses']>[string]

/**
 * Documents a JSON response.
 *
 * @param description - when the response is sent
 * @param schema - the body's schema
 * @returns the response object
 */
export function jsonResponse(description: string, schema: z.ZodType): DocumentedResponse {
  return { description, content: { 'application/json': { schema: resolver(schema) } } }
}

/**
 * Documents an error response, whose body is always OpenAI's error shape.
 *
 * @param description - when the error is sent
 * @returns the response object
 */
function errorResponse(description: string): DocumentedResponse {
  return jsonResponse(description, openAIErrorSchema)
}

/** The 401 every `/v1/*` route and every `/healthz/<check>` can answer. */
export const UNAUTHORIZED = errorResponse(
  'Proxy auth is on and the `Authorization: Bearer <token>` header is missing or wrong.'
)

/** `GET /v1/models`. */
export const listModelsDescription: DescribeRouteOptions = {
  operationId: 'listModels',
  tags: [OPENAI_TAG],
  summary: 'List the exposed models',
  description:
    'The models the exposure config exposes that have a credential, as standard OpenAI model ' +
    'objects with their public IDs.',
  responses: {
    200: jsonResponse('The exposed models.', openAIModelListSchema),
    401: UNAUTHORIZED
  }
}

/** `GET /v1/models/{model}`. */
export const retrieveModelDescription: DescribeRouteOptions = {
  operationId: 'retrieveModel',
  tags: [OPENAI_TAG],
  summary: 'Retrieve an exposed model',
  parameters: [
    {
      name: 'model',
      in: 'path',
      required: true,
      description:
        'A public model ID, or a canonical `provider/model-id` of an exposed model. IDs may ' +
        'contain `/`: send it URL-encoded (`%2F`) or as is.',
      schema: { type: 'string' }
    }
  ],
  responses: {
    200: jsonResponse('The model.', openAIModelSchema),
    401: UNAUTHORIZED,
    404: errorResponse('No exposed model has this ID (`model_not_found`).')
  }
}

/** `POST /v1/chat/completions`. */
export const createChatCompletionDescription: DescribeRouteOptions = {
  operationId: 'createChatCompletion',
  tags: [OPENAI_TAG],
  summary: 'Create a chat completion',
  description:
    'Runs the request on the model through pi. Unsupported fields are rejected, not ignored: ' +
    '422 for a field the proxy does not accept, 400 for an invalid value.',
  parameters: [
    {
      name: 'X-Switchboard-Upstream-Api-Key',
      in: 'header',
      required: false,
      description:
        "An API key for the model's provider, used instead of pi's stored credential for this " +
        'request. Before the rename it was `X-Pi-Upstream-Api-Key`, which is now rejected with 400.',
      schema: { type: 'string' }
    }
  ],
  requestBody: {
    required: true,
    content: {
      'application/json': {
        schema: resolver(chatCompletionRequestSchema),
        // What "Try it out" starts from: the generated example lists every role and field, so
        // sent as is it fails. Replace the model with an ID from `GET /v1/models`.
        example: { model: 'MODEL_ID', messages: [{ role: 'user', content: 'Hello!' }] }
      }
    }
  },
  responses: {
    200: {
      description:
        'With `stream` false or absent, one JSON completion. With `stream: true`, server-sent ' +
        'events: each `data:` line is a chunk; a failure after the stream started is one ' +
        '`data:` line with an error body; the stream ends with `data: [DONE]`.',
      content: {
        'application/json': { schema: resolver(openAIChatCompletionSchema) },
        'text/event-stream': { schema: resolver(sseChunkSchema) }
      }
    },
    400: errorResponse(
      'Invalid JSON, an invalid field value or message, a conversation longer than the model ' +
        'takes, or the old `X-Pi-Upstream-Api-Key` header.'
    ),
    401: errorResponse(
      'Proxy auth failed, or pi has no credential for the model and no ' +
        '`X-Switchboard-Upstream-Api-Key` was sent.'
    ),
    404: errorResponse('No exposed model has this ID (`model_not_found`).'),
    413: errorResponse('The body is over the size limit.'),
    422: errorResponse('A field the proxy does not accept (`unsupported_parameter`).'),
    429: errorResponse('The provider rate-limited the request.'),
    502: errorResponse('The provider refused the credential, or failed.'),
    503: errorResponse('The provider is unavailable or overloaded.'),
    504: errorResponse('The provider timed out, or sent nothing for the upstream timeout.')
  }
}

/** `GET /v1/switchboard/models`. */
export const listModelCapabilitiesDescription: DescribeRouteOptions = {
  operationId: 'listModelCapabilities',
  tags: [SWITCHBOARD_TAG],
  summary: "List each exposed model's pi capabilities",
  description:
    "Not OpenAI's: what pi knows about each model `GET /v1/models` lists, such as the " +
    '`reasoning_effort` values it runs at as asked.',
  responses: {
    200: jsonResponse('Each exposed model, with its capabilities.', piModelListSchema),
    401: UNAUTHORIZED
  }
}

/** `GET /v1/switchboard/openapi.json`. */
export const openAPIDocumentDescription: DescribeRouteOptions = {
  operationId: 'getOpenAPIDocument',
  tags: [DOCUMENTATION_TAG],
  summary: 'This document',
  description: 'Built from the routes; committed as `openapi.json`. Needs no token.',
  security: [],
  responses: {
    200: {
      description: 'The OpenAPI 3.1 document.',
      content: { 'application/json': { schema: { type: 'object' } } }
    }
  }
}

/** `GET /docs`. */
export const docsPageDescription: DescribeRouteOptions = {
  operationId: 'getDocsPage',
  tags: [DOCUMENTATION_TAG],
  summary: 'The Swagger UI page for this document',
  description:
    'Only when `docsUi` is on (`--docs-ui`, `PI_SWITCHBOARD_DOCS_UI`); it loads Swagger UI from the ' +
    'jsDelivr CDN. Needs no token: a browser cannot send one to open it.',
  security: [],
  responses: {
    200: { description: 'The page.', content: { 'text/html': { schema: { type: 'string' } } } },
    404: errorResponse('`docsUi` is off.')
  }
}

/**
 * Documents the unsupported endpoints by hand: hono-openapi leaves wildcard routes out, and an
 * `ALL` route has no method to document. Each gets `GET` and `POST`, marked deprecated.
 *
 * @returns the path items, keyed by OpenAPI path (`/*` as a `{path}` parameter)
 */
function unsupportedPaths(): Record<string, Record<string, unknown>> {
  const entries = UNSUPPORTED_ENDPOINTS.map((endpoint): [string, Record<string, unknown>] => {
    const wildcard = endpoint.endsWith('/*')
    const path = wildcard ? `${endpoint.slice(0, -'/*'.length)}/{path}` : endpoint
    // `/v1/fine_tuning/{path}` → `V1FineTuningPath`, for unique operation IDs.
    const pathName = path
      .split(/[^a-z\d]+/i)
      .filter((segment) => segment.length > 0)
      .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
      .join('')
    const operations = Object.fromEntries(
      ['get', 'post'].map((method) => [
        method,
        {
          operationId: `notSupported${method === 'get' ? 'Get' : 'Post'}${pathName}`,
          tags: [NOT_SUPPORTED_TAG],
          summary: 'Not supported by this proxy',
          description:
            'Any method answers 404 `invalid_request_error`; nothing reaches a provider.',
          deprecated: true,
          responses: { 404: { $ref: `#/components/responses/${NOT_SUPPORTED_RESPONSE}` } }
        }
      ])
    )
    const parameters = [{ name: 'path', in: 'path', required: true, schema: { type: 'string' } }]
    return [path, wildcard ? { parameters, ...operations } : operations]
  })
  return Object.fromEntries(entries)
}

/** The document-level parts of the OpenAPI document: info, tags and the proxy auth scheme. */
export const OPENAPI_OPTIONS: Partial<GenerateSpecOptions> = {
  // `openapi.json` ends in a file extension, which hono-openapi skips by default as a static file.
  excludeStaticFile: false,
  documentation: {
    info: {
      title: 'pi-switchboard',
      // The API's version, the `/v1` in every path, not the package's: a release must not change
      // the committed document.
      version: 'v1',
      description:
        'An OpenAI-compatible API over pi: its models, logins and providers. The ' +
        `${OPENAI_TAG} routes follow OpenAI's schemas; pi-specific data on them sits under ` +
        "`x_pi`. The `/v1/switchboard/` routes are the proxy's own."
    },
    tags: [
      { name: OPENAI_TAG, description: "OpenAI's routes, as the proxy implements them." },
      { name: SWITCHBOARD_TAG, description: "The proxy's own routes." },
      {
        name: OPERATIONAL_TAG,
        description: 'Health checks, outside the OpenAI-compatible surface. Not shaped like OpenAI.'
      },
      { name: DOCUMENTATION_TAG, description: 'This document and its docs page.' },
      {
        name: NOT_SUPPORTED_TAG,
        description: 'OpenAI endpoints the proxy does not implement. Each answers 404.'
      }
    ],
    components: {
      securitySchemes: {
        [PROXY_AUTH_SCHEME]: {
          type: 'http',
          scheme: 'bearer',
          description:
            'Only when proxy auth is on (`--auth-token`, `PI_SWITCHBOARD_AUTH_TOKEN` or `authToken`); ' +
            'otherwise any or no token is accepted.'
        }
      },
      responses: {
        [NOT_SUPPORTED_RESPONSE]: errorResponse(
          'The endpoint is not supported by this proxy (`invalid_request_error`).'
        )
      }
    },
    paths: unsupportedPaths(),
    security: [{ [PROXY_AUTH_SCHEME]: [] }]
  }
}
