/**
 * Where pi's adapters put the provider's HTTP status in an upstream error message, and where the
 * provider's body starts after it.
 *
 * @remarks
 * pi 1.3.0 words an upstream failure as a plain message, with the status in one of these
 * positions. This module is the only place that knows them, so a change in pi's wording is found
 * once. Callers: `mapUpstreamError` and `mapFailedCall` (`@proxy/server/errors`) want the status;
 * `retryWithoutBreakpoints` (`@proxy/pi/cache-breakpoints`) wants the JSON body of a 400.
 *
 * The positions, each with the body it yields:
 * - leading, followed by what only a status is followed by:
 *   - pi's `429: {…}`: the body is what follows `: `, `{…}`;
 *   - the Anthropic SDK's `429 {…}` and the OpenAI SDK's `429 "Too Many Requests"` (a text body):
 *     the body starts at the `{` or `"`, which is not consumed;
 *   - the OpenAI SDK's `429 status code (no body)`: the message carries no body, so it is the
 *     empty string (any other text after `status code` is the body).
 *
 *   A message that merely starts with a number (`429 tokens over…`, `401 messages were sent…`)
 *   does not match;
 * - after a label, from `formatProviderError` with a prefix (Responses, Azure) and Mistral:
 *   `OpenAI API error (429): {…}`, the body being what follows `: `;
 * - Google's SDK mid-stream: `got status: 429. {…}`, the body being what follows `. `.
 *
 * Google's SDK also reports a failure as the error body alone (`{"error":{"code":429,…}}`); that
 * has no prefix to split, and `@proxy/server/errors` reads it.
 *
 * @packageDocumentation
 */

/** An upstream error message, split at the end of its status prefix. */
export interface UpstreamError {
  /** The provider's HTTP status (4xx or 5xx), or `undefined` when the message reports none. */
  readonly status: number | undefined
  /**
   * The text after the status prefix, where the provider's body starts: usually JSON, sometimes
   * plain text, empty for `status code (no body)`. The whole message when it carries no status.
   */
  readonly body: string
}

/**
 * The positions of the status in pi's messages, in the order tried. Each captures the `status` and
 * ends where the body starts: a separator is consumed, a body's first character is only looked
 * ahead at, so the match's end is the body's start.
 */
const STATUS_POSITIONS: readonly RegExp[] = [
  /^(?<status>[45]\d\d)(?::\s+| (?=[{"])| status code\b(?: \(no body\))?\s*)/,
  /^[^\n(]{1,80} \((?<status>[45]\d\d)\):\s*/,
  /^got status: (?<status>[45]\d\d)\b\.?\s*/
]

/**
 * Splits an upstream error message into the provider's HTTP status and the body after it.
 *
 * @remarks
 * Only the positions pi's messages put the status in count ({@link STATUS_POSITIONS}), never a
 * number elsewhere in the text (a token count, an ID, a quoted request).
 *
 * @param message - the upstream error message
 * @returns the status and the body after its prefix; `status` is `undefined` and `body` the whole
 *   message when the message reports none
 */
export function splitUpstreamError(message: string): UpstreamError {
  for (const position of STATUS_POSITIONS) {
    const match = position.exec(message)
    const status = match?.groups?.['status']
    if (match !== null && status !== undefined) {
      return { status: Number(status), body: message.slice(match[0].length) }
    }
  }
  return { status: undefined, body: message }
}
