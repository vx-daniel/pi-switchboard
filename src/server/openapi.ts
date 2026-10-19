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
/** Where the opt-in docs UI is served. */
export const DOCS_PATH = `${SWITCHBOARD_PREFIX}/docs`
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
/** The name the bearer scheme is registered under. */
const PROXY_AUTH_SCHEME = 'proxyAuth'

/** A documented response: a description and a JSON body. */
type DocumentedResponse = NonNullable<DescribeRouteOptions['responses']>[string]

/**
 * Documents a JSON response.
 *
 * @param description - when the response is sent
 * @param schema - the body's schema
 * @returns the response object
 */
function jsonResponse(description: string, schema: z.ZodType): DocumentedResponse {
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

/** The 401 every `/v1/*` route can answer. */
const UNAUTHORIZED = errorResponse(
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
      'Invalid JSON, an invalid field value or message, or a conversation longer than the ' +
        'model takes.'
    ),
    401: errorResponse(
      'Proxy auth failed, or pi has no credential for the model and no ' +
        '`X-Pi-Upstream-Api-Key` was sent.'
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

/** The document-level parts of the OpenAPI document: info, tags and the proxy auth scheme. */
export const OPENAPI_OPTIONS: Partial<GenerateSpecOptions> = {
  documentation: {
    info: {
      title: 'pi-openai-proxy',
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
      { name: SWITCHBOARD_TAG, description: "The proxy's own routes." }
    ],
    components: {
      securitySchemes: {
        [PROXY_AUTH_SCHEME]: {
          type: 'http',
          scheme: 'bearer',
          description:
            'Only when proxy auth is on (`--auth-token`, `PI_PROXY_AUTH_TOKEN` or `authToken`); ' +
            'otherwise any or no token is accepted.'
        }
      }
    },
    security: [{ [PROXY_AUTH_SCHEME]: [] }]
  }
}
