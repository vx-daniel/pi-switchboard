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
  N_OTHER_THAN_ONE_REFUSAL,
  rejectedFields,
  STORE_TRUE_REFUSAL
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

/**
 * Fields accepted only at the value the proxy honors (constitution principle I), and the named
 * 422 for any other value. `store: true` is refused the same way on the Responses API
 * (`responsesRequestRejection`), with the same message.
 */
const HONORED_VALUE_FIELDS = [
  { field: 'store', refuses: (value: unknown) => value === true, message: STORE_TRUE_REFUSAL },
  {
    field: 'n',
    refuses: (value: unknown) => value !== undefined && value !== null && value !== 1,
    message: N_OTHER_THAN_ONE_REFUSAL
  }
] as const

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
 * generic unknown-parameter error, and so is a value other than the one a field in
 * {@link HONORED_VALUE_FIELDS} accepts (`store: true`, `n: 2`), which the schema refuses as a
 * mere invalid value. An accepted value (`n: 1`) is not blamed for another field's error. Only
 * the first Zod issue is reported.
 *
 * @param body - the parsed JSON request body, which does not match the schema
 * @returns a 422 for rejected/unknown fields, or a 400 for any other invalid value (with the
 *   dotted path as `param`, or `null` at the root)
 */
export function chatRequestRejection(body: unknown): ValidationError {
  return rejectedFieldRejection(body) ?? schemaRejection(chatCompletionRequestSchema, body)
}

/**
 * Says why a body fails a request schema: its first issue, made specific.
 *
 * @param schema - the route's request schema
 * @param body - the parsed JSON request body, which does not match the schema
 * @returns a 422 for unknown fields, or a 400 for any other invalid value (with the dotted path
 *   as `param`, or `null` at the root)
 */
export function schemaRejection(schema: z.ZodType, body: unknown): ValidationError {
  const result = schema.safeParse(body)
  // Report only the first Zod issue, for a clean message
  const issues = result.success ? [] : result.error.issues
  const firstIssue = issues[0]
  if (firstIssue !== undefined) return issueRejection(specificIssue(firstIssue), issues.length)

  validateLogger.warn('Rejected request body with no validation issue detail')
  return { ok: false, status: 400, message: 'Invalid request body', param: null }
}

/**
 * Finds the first field the body sets at a value the proxy refuses by name: any value of a field
 * in {@link rejectedFields}, or a value other than the honored one of a field in
 * {@link HONORED_VALUE_FIELDS}.
 *
 * @param body - the parsed JSON request body
 * @returns its named 422, or `undefined` when the body sets none
 */
function rejectedFieldRejection(body: unknown): ValidationError | undefined {
  if (!isRecord(body)) return undefined
  const honored = HONORED_VALUE_FIELDS.find(({ field, refuses }) => refuses(body[field]))
  if (honored !== undefined) {
    validateLogger.warn('Rejected unsupported field {field}', { field: honored.field })
    return { ok: false, status: 422, message: honored.message, param: honored.field }
  }
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
 * Assistant fields accepted only empty, as SDKs echo them back, and what each accepts: pi has
 * nowhere to put a refusal, an audio reply, a function call in the deprecated form, or annotations.
 */
const EMPTY_ONLY_FIELDS: ReadonlyMap<string, string> = new Map([
  ['refusal', 'null'],
  ['audio', 'null'],
  ['function_call', 'null'],
  ['annotations', 'null or []']
])

/** The path length of a field on a message: `messages`, its index, the field. */
const MESSAGE_FIELD_DEPTH = 3

/**
 * Picks the most specific issue inside a union's: the one the input got furthest into.
 *
 * @remarks
 * A union reports one `invalid_union` issue at its own path, with each branch's issues inside. A
 * user message's parts are a union of a string and an array, so an unknown key on a part would
 * otherwise read as "invalid input" at `messages.0.content`. The branch whose issue has the
 * longest path is the one the input matched the shape of; its issue is reported, at the full path.
 * On a tie the first branch's issue wins: `toSorted` is stable, as the language requires.
 *
 * @param issue - a Zod issue
 * @returns the issue to report
 */
function specificIssue(issue: z.core.$ZodIssue): z.core.$ZodIssue {
  if (issue.code !== 'invalid_union') return issue
  const deepest = issue.errors
    .flat()
    .toSorted((left, right) => right.path.length - left.path.length)[0]
  if (deepest === undefined || deepest.path.length === 0) return issue
  return specificIssue({ ...deepest, path: [...issue.path, ...deepest.path] })
}

/**
 * Joins an issue path into the dotted `param` form.
 *
 * @param path - the issue path
 * @param key - a key below it, when the issue names one
 * @returns the dotted path, or `null` at the root
 */
function dottedPath(path: readonly PropertyKey[], key?: string): string | null {
  const parts = [...path.map(String), ...(key === undefined ? [] : [key])]
  return parts.length > 0 ? parts.join('.') : null
}

/**
 * Turns the first schema issue into the client's error: a 422 for unknown fields and for a value
 * in an assistant field accepted only empty ({@link EMPTY_ONLY_FIELDS}), a 400 for anything else.
 *
 * @param issue - the first Zod issue, made specific by {@link specificIssue}
 * @param issueCount - how many issues the body had, for the log
 * @returns the rejection
 */
function issueRejection(issue: z.core.$ZodIssue, issueCount: number): ValidationError {
  if (issue.code === 'unrecognized_keys') {
    const fields = issue.keys.map((key) => dottedPath(issue.path, key) ?? key)
    validateLogger.warn('Rejected unknown fields {fields}', { fields })
    return {
      ok: false,
      status: 422,
      message: `Unknown parameter(s): ${fields.join(', ')}`,
      param: fields[0] ?? null
    }
  }
  const path = dottedPath(issue.path)
  const field = issue.path.at(-1)
  const accepted = typeof field === 'string' ? EMPTY_ONLY_FIELDS.get(field) : undefined
  const onMessage = issue.path[0] === 'messages' && issue.path.length === MESSAGE_FIELD_DEPTH
  if (accepted !== undefined && onMessage) {
    validateLogger.warn('Rejected unsupported field {field}', { field: path })
    return {
      ok: false,
      status: 422,
      message: `'${path ?? ''}' is not supported in this version of the proxy; only ${accepted} is accepted`,
      param: path
    }
  }
  // The issue code and path only: an issue message can quote the rejected value.
  validateLogger.warn('Rejected invalid value at {path} ({code})', {
    path: path ?? '(root)',
    code: issue.code,
    issueCount
  })
  return {
    ok: false,
    status: 400,
    message: `Invalid value for '${path ?? ''}': ${issue.message}`,
    param: path
  }
}
