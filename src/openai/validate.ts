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
import type * as z from 'zod'

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
 * The chat route validates with hono-openapi's `validator()`, which runs the same schema, then
 * calls {@link chatRequestRejection} only for a body that failed, and
 * {@link logValidatedChatRequest} for one that passed. This function is the two together.
 *
 * @param body - the parsed JSON request body, of any shape
 * @returns the parsed request, or a 422 for rejected/unknown fields, or a 400 for any other
 *   invalid value (with the dotted path as `param`, or `null` at the root)
 */
export function validateChatRequest(body: unknown): ValidationResult {
  const result = chatCompletionRequestSchema.safeParse(body)
  if (!result.success) return chatRequestRejection(body)
  logValidatedChatRequest(result.data)
  return { ok: true, data: result.data }
}

/**
 * Logs a chat request that passed validation, at debug.
 *
 * @param data - the parsed request
 */
export function logValidatedChatRequest(data: ChatCompletionRequest): void {
  validateLogger.debug('Validated chat request for {model}', () => ({
    model: data.model,
    stream: data.stream === true,
    messageCount: data.messages.length,
    toolCount: data.tools?.length ?? 0,
    fields: Object.keys(data),
    passthroughFields: PASSTHROUGH_FIELDS.filter((field) => data[field] !== undefined)
  }))
}

/**
 * Says why a body that failed {@link chatCompletionRequestSchema} is rejected.
 *
 * @remarks
 * Fields in {@link rejectedFields} are checked first so they get a named 422 instead of the
 * generic unknown-parameter error. Only the first Zod issue is reported.
 *
 * @param body - the parsed JSON request body, which does not match the schema
 * @returns a 422 for rejected/unknown fields, or a 400 for any other invalid value (with the
 *   dotted path as `param`, or `null` at the root)
 */
export function chatRequestRejection(body: unknown): ValidationError {
  const rejected = rejectedFieldRejection(body)
  if (rejected !== undefined) return rejected

  const result = chatCompletionRequestSchema.safeParse(body)
  // Report only the first Zod issue, for a clean message
  const issues = result.success ? [] : result.error.issues
  const firstIssue = issues[0]
  if (firstIssue !== undefined) return issueRejection(firstIssue, issues.length)

  validateLogger.warn('Rejected request body with no validation issue detail')
  return { ok: false, status: 400, message: 'Invalid request body', param: null }
}

/**
 * Finds the first field in {@link rejectedFields} the body sets.
 *
 * @param body - the parsed JSON request body
 * @returns its named 422, or `undefined` when the body sets none
 */
function rejectedFieldRejection(body: unknown): ValidationError | undefined {
  if (!isRecord(body)) return undefined
  const field = rejectedFields.find((rejectedField) => body[rejectedField] !== undefined)
  if (field === undefined) return undefined
  validateLogger.warn('Rejected unsupported field {field}', { field })
  return {
    ok: false,
    status: 422,
    message: `'${field}' is not supported in this version of the proxy`,
    param: field
  }
}

/**
 * Turns the first schema issue into the client's error: a 422 for unknown fields, a 400 for
 * anything else.
 *
 * @param issue - the first Zod issue
 * @param issueCount - how many issues the body had, for the log
 * @returns the rejection
 */
function issueRejection(issue: z.core.$ZodIssue, issueCount: number): ValidationError {
  if (issue.code === 'unrecognized_keys') {
    validateLogger.warn('Rejected unknown fields {fields}', { fields: issue.keys })
    return {
      ok: false,
      status: 422,
      message: `Unknown parameter(s): ${issue.keys.join(', ')}`,
      param: issue.keys[0] ?? null
    }
  }
  const path = issue.path.join('.')
  // The issue code and path only: an issue message can quote the rejected value.
  validateLogger.warn('Rejected invalid value at {path} ({code})', {
    path: path.length > 0 ? path : '(root)',
    code: issue.code,
    issueCount
  })
  return {
    ok: false,
    status: 400,
    message: `Invalid value for '${path}': ${issue.message}`,
    param: path.length > 0 ? path : null
  }
}
