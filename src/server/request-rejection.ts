/**
 * Answers a request body that failed its route's schema, for the chat and Responses routes alike:
 * a named 422 for an unsupported or unknown field, a 400 for any other invalid value.
 *
 * @packageDocumentation
 */

import { proxyLogger } from '@proxy/logging'
import type { ValidationError } from '@proxy/openai/validate'
import { invalidRequest, unsupportedParameter } from '@proxy/server/errors'
import { HTTP_BAD_REQUEST, HTTP_UNPROCESSABLE_ENTITY } from '@proxy/server/http-status'
import type { Context } from 'hono'

/** Logger for chat requests: the category both routes' requests log under. */
const chatLogger = proxyLogger('server', 'chat')

/**
 * Answers a rejected request body.
 *
 * @remarks
 * A body that is not JSON never gets here: the validator throws for it, and `app.onError` answers
 * 400.
 *
 * @param context - the request's Hono context
 * @param rejection - why the body is refused
 * @param logMessage - the warning to log, with `{param}` and `{status}` placeholders
 * @returns the error response
 */
export function rejectionResponse(
  context: Context,
  rejection: ValidationError,
  logMessage: string
): Response {
  // The field name only: validation messages can echo request values.
  chatLogger.warn(logMessage, {
    param: rejection.param ?? 'unknown',
    status: rejection.status
  })
  if (rejection.status === HTTP_UNPROCESSABLE_ENTITY) {
    return context.json(
      unsupportedParameter(rejection.param ?? 'unknown', rejection.message),
      HTTP_UNPROCESSABLE_ENTITY
    )
  }
  return context.json(
    invalidRequest(rejection.message, rejection.param ?? undefined),
    HTTP_BAD_REQUEST
  )
}
