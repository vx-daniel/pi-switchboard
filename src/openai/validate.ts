/**
 * Validates chat-completion request bodies and turns schema failures into OpenAI-style errors.
 *
 * @remarks
 * Explicitly rejected fields and unknown top-level fields get 422; any other schema failure
 * (wrong type, out-of-range value, missing field) gets 400.
 *
 * @packageDocumentation
 */

import { proxyLogger } from '@proxy/logging'
import {
  type ChatCompletionRequest,
  chatCompletionRequestSchema,
  rejectedFields
} from '@proxy/openai/schemas'
import { isRecord } from '@proxy/utils/guards'

/** Logger for request validation. */
const validateLogger = proxyLogger('openai', 'validate')

/**
 * Accepted fields the proxy does not interpret; `src/pi/complete.ts` forwards them to
 * OpenAI-compatible APIs only. Listed here for the debug log.
 */
const PASSTHROUGH_FIELDS = ['metadata', 'prediction'] as const

/** Successful validation: the parsed request body. */
export interface ValidationSuccess {
  readonly ok: true
  readonly data: ChatCompletionRequest
}

/** Failed validation: the HTTP status, a client-facing message, and the offending parameter. */
export interface ValidationError {
  readonly ok: false
  readonly status: number
  readonly message: string
  readonly param: string | null
}

/** Outcome of {@link validateChatRequest}, discriminated on `ok`. */
export type ValidationResult = ValidationSuccess | ValidationError

/**
 * Validates a raw request body against {@link chatCompletionRequestSchema}.
 *
 * @remarks
 * Fields in {@link rejectedFields} are checked first so they get a named 422 instead of the
 * generic unknown-parameter error. Only the first Zod issue is reported.
 *
 * @param body - the parsed JSON request body, of any shape
 * @returns the parsed request, or a 422 for rejected/unknown fields, or a 400 for any other
 *   invalid value (with the dotted path as `param`, or `null` at the root)
 */
export function validateChatRequest(body: unknown): ValidationResult {
  // Check for rejected fields before schema parsing so they get a specific message.
  if (isRecord(body)) {
    for (const field of rejectedFields) {
      if (body[field] !== undefined) {
        validateLogger.warn('Rejected unsupported field {field}', { field })
        return {
          ok: false,
          status: 422,
          message: `'${field}' is not supported in this version of the proxy`,
          param: field
        }
      }
    }
  }

  const result = chatCompletionRequestSchema.safeParse(body)

  if (result.success) {
    const { data } = result
    validateLogger.debug('Validated chat request for {model}', () => ({
      model: data.model,
      stream: data.stream === true,
      messageCount: data.messages.length,
      toolCount: data.tools?.length ?? 0,
      fields: Object.keys(data),
      passthroughFields: PASSTHROUGH_FIELDS.filter((field) => data[field] !== undefined)
    }))
    return { ok: true, data }
  }

  // Report only the first Zod issue, for a clean message
  const firstIssue = result.error.issues[0]
  if (firstIssue !== undefined) {
    const path = firstIssue.path.join('.')
    if (firstIssue.code === 'unrecognized_keys') {
      validateLogger.warn('Rejected unknown fields {fields}', { fields: firstIssue.keys })
      return {
        ok: false,
        status: 422,
        message: `Unknown parameter(s): ${firstIssue.keys.join(', ')}`,
        param: firstIssue.keys[0] ?? null
      }
    }
    // The issue code and path only: an issue message can quote the rejected value.
    validateLogger.warn('Rejected invalid value at {path} ({code})', {
      path: path.length > 0 ? path : '(root)',
      code: firstIssue.code,
      issueCount: result.error.issues.length
    })
    return {
      ok: false,
      status: 400,
      message: `Invalid value for '${path}': ${firstIssue.message}`,
      param: path.length > 0 ? path : null
    }
  }

  validateLogger.warn('Rejected request body with no validation issue detail')
  return {
    ok: false,
    status: 400,
    message: 'Invalid request body',
    param: null
  }
}
