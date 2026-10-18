/**
 * Shared helpers for the payload passthrough unit tests.
 *
 * @packageDocumentation
 */

import type { ChatCompletionRequest } from '@proxy/openai/schemas'

/**
 * Builds a minimal valid chat completion request for the payload field collector tests.
 *
 * @param overrides - request fields to set or replace
 * @returns a request for `openai/gpt-4o` with one user message, plus `overrides`
 */
export function minimalRequest(
  overrides: Partial<ChatCompletionRequest> = {}
): ChatCompletionRequest {
  return {
    model: 'openai/gpt-4o',
    messages: [{ role: 'user', content: 'Hello' }],
    ...overrides
  }
}
