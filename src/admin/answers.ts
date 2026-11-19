/**
 * How the admin UI's writes answer (#367, phase 2): the page's data after the change, or a
 * refusal with a machine-readable code and what to tell the operator. Shared by the settings,
 * alias and login writes, so each refuses the same way and none writes over an unusable file.
 *
 * @packageDocumentation
 */

import { configFileProblem, describeConfigFileProblem } from '@proxy/config/schema'
import type { HTTP_FORBIDDEN, HTTP_OK } from '@proxy/server/http-status'
import {
  HTTP_BAD_REQUEST,
  HTTP_CONFLICT,
  HTTP_INTERNAL_SERVER_ERROR,
  HTTP_NOT_FOUND
} from '@proxy/server/http-status'

/** A refusal's HTTP status. */
export type RefusalStatus =
  | typeof HTTP_BAD_REQUEST
  | typeof HTTP_FORBIDDEN
  | typeof HTTP_NOT_FOUND
  | typeof HTTP_CONFLICT
  | typeof HTTP_INTERNAL_SERVER_ERROR

/** A refused write: its status, and why. */
export interface Refusal {
  readonly status: RefusalStatus
  readonly body: { readonly error: { readonly code: string; readonly message: string } }
}

/**
 * A write's answer: the page's data after it, or why it was refused.
 *
 * @typeParam Body - the page's data
 */
export type WriteAnswer<Body> = { readonly status: typeof HTTP_OK; readonly body: Body } | Refusal

/** What a write says when `proxy-config.json` could not be written; the log says why. */
const NOT_WRITTEN_MESSAGE = 'Could not write proxy-config.json; nothing changed. The log says why.'

/**
 * Answers a refusal.
 *
 * @param status - its HTTP status
 * @param code - its machine-readable code
 * @param message - what to tell the operator
 * @returns the answer
 */
export function refused(status: RefusalStatus, code: string, message: string): Refusal {
  return { status, body: { error: { code, message } } }
}

/**
 * Refuses a write over a config file that can't be read or parsed, which would lose what the
 * operator had in it, as the console refuses it.
 *
 * @returns the refusal, or `undefined` when the file can be written
 */
export function fileUnusable(): Refusal | undefined {
  const problem = configFileProblem()
  if (problem === undefined) return undefined
  return refused(
    HTTP_CONFLICT,
    'file_unusable',
    `proxy-config.json ${describeConfigFileProblem(problem)}: fix or remove it first; nothing is saved over it.`
  )
}

/**
 * Answers a write the config file refused to take.
 *
 * @returns the refusal
 */
export function notWritten(): Refusal {
  return refused(HTTP_INTERNAL_SERVER_ERROR, 'not_written', NOT_WRITTEN_MESSAGE)
}

/**
 * Answers a write that names nothing the config has.
 *
 * @param code - what was not found (`unknown_alias`, `unknown_login`)
 * @param message - what to tell the operator
 * @returns the refusal
 */
export function notFound(code: string, message: string): Refusal {
  return refused(HTTP_NOT_FOUND, code, message)
}

/**
 * Answers a write whose value the proxy would refuse.
 *
 * @param code - why (`invalid_value`, `invalid_target`, `confirm_required`)
 * @param message - what to tell the operator
 * @returns the refusal
 */
export function badRequest(code: string, message: string): Refusal {
  return refused(HTTP_BAD_REQUEST, code, message)
}
