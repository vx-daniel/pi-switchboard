/**
 * Numbers read from text a provider or an operator wrote.
 *
 * @packageDocumentation
 */

/** A plain non-negative decimal number, as `retry-after` and the rate-limit headers write one. */
const PLAIN_NUMBER = /^\s*\d+(?:\.\d+)?\s*$/

/**
 * Reads a plain non-negative number: digits, an optional fraction, and nothing else but
 * surrounding whitespace.
 *
 * @remarks
 * Stricter than `Number.parseFloat`, which reads `12abc` as 12, and than `Number`, which reads
 * `0x10`, `1e3` and `Infinity`. Header values and JSON fields that mean a number write it plainly.
 *
 * @param text - the text, such as a header value
 * @returns the number, or `undefined` when the text is not one
 */
export function parsePlainNumber(text: string): number | undefined {
  if (!PLAIN_NUMBER.test(text)) return undefined
  return Number.parseFloat(text)
}
