/**
 * The prompt and its cache hit rate, from the token counts the stats and the route totals keep
 * (#297).
 *
 * @remarks
 * pi reports a call's input in three parts: `input` (uncached), `cacheRead` and `cacheWrite`. The
 * whole prompt is their sum, as `prompt_tokens` in a chat completion's `usage` is. The hit rate is
 * the share of the prompt read from the cache; writes count against it, since a written token was
 * not read. Every view that shows a hit rate takes it from here, so they cannot disagree.
 *
 * @packageDocumentation
 */

/** The input token counts a prompt is made of. */
export interface InputTokens {
  /** Uncached input tokens. */
  readonly inputTokens: number
  /** Input tokens read from the provider's prompt cache. */
  readonly cacheReadTokens: number
  /** Input tokens written to the provider's prompt cache. */
  readonly cacheWriteTokens: number
}

/**
 * Adds up the whole prompt: uncached input, cache reads and cache writes.
 *
 * @param tokens - the input token counts
 * @returns the prompt's tokens
 */
export function promptTokens(tokens: InputTokens): number {
  return tokens.inputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens
}

/**
 * Reads the share of the prompt that came from the provider's cache.
 *
 * @param tokens - the input token counts
 * @returns the share, from 0 to 1; `undefined` with no prompt tokens at all
 */
export function cacheHitRate(tokens: InputTokens): number | undefined {
  const prompt = promptTokens(tokens)
  return prompt === 0 ? undefined : tokens.cacheReadTokens / prompt
}
