/**
 * `POST /v1/responses`: OpenAI's Responses API, stateless and experimental (#140).
 *
 * @remarks
 * Off by default (`responsesApi`, `--responses-api`, `PI_SWITCHBOARD_RESPONSES_API`); while off it
 * answers 404 with how to turn it on, and stays in the OpenAPI document so the document does not
 * depend on the config. On, the request is validated and translated into a chat request
 * (`src/openai/responses-api/request.ts`) and run as one (`runChat`): model resolution, routing,
 * upstream keys, timeouts, disconnects and errors are the chat route's. Only the answer differs,
 * a `response` object or `response.*` events.
 *
 * @packageDocumentation
 */

import { proxyLogger } from '@proxy/logging'
import {
  responseObjectSchema,
  responseStreamEventSchema
} from '@proxy/openai/responses-api/doc-schemas'
import { responseFrame } from '@proxy/openai/responses-api/output'
import {
  responsesRequestRejection,
  toChatRequest,
  withReplayedReasoning
} from '@proxy/openai/responses-api/request'
import { createResponseRequestSchema } from '@proxy/openai/responses-api/request-schema'
import { responsesFormat } from '@proxy/server/answer-formats'
import { invalidRequest } from '@proxy/server/errors'
import { HTTP_BAD_REQUEST, HTTP_NOT_FOUND } from '@proxy/server/http-status'
import { jsonBodyMiddleware } from '@proxy/server/middleware'
import { chatHeadersSchema, errorResponse, OPENAI_TAG } from '@proxy/server/openapi'
import { rejectionResponse } from '@proxy/server/request-rejection'
import type { ChatRouteSettings, ChatRunner } from '@proxy/server/routes'
import type { ProxyEnv } from '@proxy/server/types'
import type { Hono } from 'hono'
import { type DescribeRouteOptions, describeRoute, resolver, validator } from 'hono-openapi'

/** Logger for the Responses route: the chat category, as its requests run as chat ones. */
const chatLogger = proxyLogger('server', 'chat')

/** The Responses API's create path. */
const RESPONSES_PATH = '/v1/responses'

/** The request body schema, with an example for the document. */
const responsesRequestBodySchema = createResponseRequestSchema.meta({
  examples: [{ model: 'MODEL_ID', input: 'Hello!' }]
})

/** `POST /v1/responses`, for the OpenAPI document. */
const createResponseDescription: DescribeRouteOptions = {
  operationId: 'createResponse',
  tags: [OPENAI_TAG],
  summary: 'Create a response (experimental)',
  description:
    "OpenAI's Responses API, stateless: off unless `responsesApi` is on. Runs as chat " +
    'completions do, with function tools only and nothing stored. Unsupported fields are ' +
    'rejected, not ignored: 422 for a field the proxy does not accept, 400 for an invalid value.',
  responses: {
    200: {
      description:
        'With `stream` false or absent, one `response` object. With `stream: true`, server-sent ' +
        '`response.*` events, ending with `response.completed`, `response.incomplete` or ' +
        '`response.failed`.',
      content: {
        'application/json': { schema: resolver(responseObjectSchema) },
        'text/event-stream': { schema: resolver(responseStreamEventSchema) }
      }
    },
    400: errorResponse(
      'Invalid JSON, an invalid field value, a reasoning `encrypted_content` this proxy did not ' +
        'write, or the errors chat completions give.'
    ),
    404: errorResponse('The Responses API is off, or no exposed model has this ID.'),
    422: errorResponse(
      'A field the proxy does not accept (`unsupported_parameter`): stored state ' +
        '(`previous_response_id`, `conversation`, `background`, `prompt`, `store: true`), a tool ' +
        'that is not a function, and the others listed in docs/api.md.'
    )
  }
}

/**
 * Registers `POST /v1/responses`.
 *
 * @param routes - the app's OpenAI-compatible routes
 * @param settings - the server config, exposure config reader and remote image policy
 * @param run - the chat route's runner, which the translated request runs through
 */
export function registerResponsesRoute(
  routes: Hono<ProxyEnv>,
  settings: ChatRouteSettings,
  run: ChatRunner
): void {
  const enabled = settings.config.responsesApiEnabled
  routes.post(
    RESPONSES_PATH,
    describeRoute(createResponseDescription),
    async (context, next) => {
      if (enabled) {
        await next()
        return undefined
      }
      chatLogger.warn('Rejected Responses request: the Responses API is off')
      return context.json(
        invalidRequest(
          'The Responses API is off; turn on responsesApi (--responses-api, PI_SWITCHBOARD_RESPONSES_API)'
        ),
        HTTP_NOT_FOUND
      )
    },
    validator('header', chatHeadersSchema),
    jsonBodyMiddleware(),
    validator('json', responsesRequestBodySchema, (result, context) =>
      result.success
        ? undefined
        : rejectionResponse(
            context,
            responsesRequestRejection(result.data),
            'Rejected Responses request: invalid field {param} ({status})'
          )
    ),
    async (context) => {
      const request = context.req.valid('json')
      const translated = toChatRequest(request)
      if (!translated.ok) {
        chatLogger.warn('Rejected Responses request: {param}', { param: translated.param })
        return context.json(invalidRequest(translated.message, translated.param), HTTP_BAD_REQUEST)
      }
      const { chat, reasoning } = translated.value
      return run(context, chat, settings, {
        format: (requestId) => responsesFormat(responseFrame(requestId, request)),
        adjust: (piContext) => withReplayedReasoning(piContext, reasoning)
      })
    }
  )
}
