/**
 * Shared type guards, error helpers and the lenient JSON parse.
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

/**
 * Returns the error's message, or the thrown value as text when it is not an `Error`.
 *
 * @remarks
 * For a log line's detail or a notification. A message can quote a path, a file's contents or a
 * request; where a line must not, use {@link errorCode}.
 *
 * @param error - A caught value of any type.
 * @returns `error.message` for an `Error`, else `String(error)`.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Parses JSON text, or does not: a text that is not JSON gives `undefined` rather than throwing.
 *
 * @remarks
 * JSON cannot encode `undefined`, so `undefined` always means "not JSON"; `null` and every other
 * value come back as parsed. The parser's message is dropped: it quotes the text, which can be a
 * config file holding a token or a provider body quoting a request.
 *
 * @param text - The text to parse.
 * @returns The parsed value, or `undefined` when `text` is not valid JSON.
 */
export function parseJsonOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
