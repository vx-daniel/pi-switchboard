/**
 * Shared helpers for the payload passthrough unit tests.
 */

import type { ChatCompletionRequest } from '@proxy/openai/schemas'

/** Minimal valid request for collectPayloadFields tests. */
export function minimalRequest(
  overrides: Partial<ChatCompletionRequest> = {}
): ChatCompletionRequest {
  return {
    model: 'openai/gpt-4o',
    messages: [{ role: 'user', content: 'Hello' }],
    ...overrides
  }
}
