/**
 * Shared type guards and error helpers.
 *
 * @packageDocumentation
 */

/**
 * Narrows `unknown` to `Record<string, unknown>`.
 *
 * @param value - Any value.
 * @returns Whether `value` is a non-null, non-array object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Returns Node's error code (`ENOENT`, `EACCES`, …) or the error's name, for log lines.
 *
 * @remarks
 * Never the error's message, which can quote paths, file contents or a request.
 *
 * @param error - A caught value of any type.
 * @returns The string `code` property when there is one, else the `Error`'s name, else `'unknown'`.
 */
export function errorCode(error: unknown): string {
  if (isRecord(error) && typeof error['code'] === 'string') return error['code']
  return error instanceof Error ? error.name : 'unknown'
}
