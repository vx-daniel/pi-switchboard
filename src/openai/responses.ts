/**
 * Builds OpenAI-compatible non-streaming responses from pi results.
 *
 * @remarks
 * - finish_reason: stop -> stop, length -> length, toolUse -> tool_calls; everything else -> stop
 * - No synthesized finish reasons pi cannot distinguish (e.g. content_filter)
 * - Usage maps pi Usage to OpenAI usage, cache reads/writes in `prompt_tokens_details`; cost and
 *   cache counts also go under `x_pi`
 * - Each choice carries `logprobs: null`, which OpenAI's spec requires; there is no
 *   `system_fingerprint`, which the spec types as a string and pi has no value for (#132)
 *
 * @packageDocumentation
 */

import type {
  AssistantMessage,
  StopReason,
  TextContent,
  ToolCall,
  Usage
} from '@earendil-works/pi-ai'
import { proxyLogger } from '@proxy/logging'

/** Logger for non-streaming response building. */
const responsesLogger = proxyLogger('openai', 'responses')

/** Milliseconds per second, to turn `Date.now()` into a Unix timestamp. */
const MS_PER_SECOND = 1000

/** OpenAI `usage` object, with pi's cache write count added to `prompt_tokens_details`. */
export interface OpenAIUsage {
  readonly prompt_tokens: number
  readonly completion_tokens: number
  readonly total_tokens: number
  readonly prompt_tokens_details: {
    readonly cached_tokens: number
    readonly cache_write_tokens: number
  }
}

/** A non-streaming `chat.completion` response, with pi cost and cache data under `x_pi`. */
export interface OpenAIChatCompletion {
  readonly id: string
  readonly object: 'chat.completion'
  readonly created: number
  readonly model: string
  readonly choices: OpenAIChatCompletionChoice[]
  readonly usage: OpenAIUsage
  readonly x_pi?: {
    readonly cost: Usage['cost']
    readonly cache_read_tokens: number
    readonly cache_write_tokens: number
  }
}

/** One choice of a {@link OpenAIChatCompletion}. */
export interface OpenAIChatCompletionChoice {
  readonly index: number
  readonly message: {
    readonly role: 'assistant'
    readonly content: string | null
    readonly tool_calls?: OpenAIToolCall[] | undefined
  }
  readonly finish_reason: string
  /** Always `null`: pi returns no token probabilities, and `logprobs` requests are rejected. */
  readonly logprobs: null
}

/** An OpenAI function tool call in an assistant message. */
export interface OpenAIToolCall {
  readonly id: string
  readonly type: 'function'
  readonly function: {
    readonly name: string
    readonly arguments: string
  }
}

/**
 * Pi StopReason to OpenAI finish_reason.
 *
 * @remarks
 * `pending` is a response still in flight and `deferred` one the provider continues
 * asynchronously; pi only returns `deferred` when the caller sets `deferred` in the request
 * options, which this proxy never does, so neither reaches a client. They map like `error` and
 * `aborted` (a finish_reason is required, and OpenAI has no better fit).
 */
const FINISH_REASON_MAP: Record<StopReason, string> = {
  pending: 'stop',
  stop: 'stop',
  length: 'length',
  toolUse: 'tool_calls',
  error: 'stop',
  aborted: 'stop',
  deferred: 'stop'
}

/**
 * Maps a pi StopReason to an OpenAI finish_reason.
 *
 * @param reason - the pi stop reason
 * @returns the finish_reason from {@link FINISH_REASON_MAP}
 */
export function mapFinishReason(reason: StopReason): string {
  return FINISH_REASON_MAP[reason]
}

/**
 * Maps pi Usage to OpenAI usage.
 *
 * @remarks
 * Pi's `input` is only the uncached input: for Anthropic with prompt caching, cache reads and
 * writes arrive separately as `cacheRead` and `cacheWrite`. OpenAI clients expect
 * `prompt_tokens` to be the whole prompt, with the cached part broken out in
 * `prompt_tokens_details`. Reporting `input` alone made a 9,650-token prompt come back as
 * `prompt_tokens: 4`, so a client that sizes its context or triggers compaction from it (Docker
 * Agent does) saw about 0.04% of the real context.
 *
 * @param usage - pi's usage for the response
 * @returns OpenAI usage; `prompt_tokens` is input plus cache reads plus cache writes, and
 *   `total_tokens` is pi's `totalTokens`
 */
export function mapUsage(usage: Usage): OpenAIUsage {
  const cacheReadTokens = usage.cacheRead
  const cacheWriteTokens = usage.cacheWrite
  return {
    prompt_tokens: usage.input + cacheReadTokens + cacheWriteTokens,
    completion_tokens: usage.output,
    total_tokens: usage.totalTokens,
    prompt_tokens_details: {
      cached_tokens: cacheReadTokens,
      cache_write_tokens: cacheWriteTokens
    }
  }
}

/**
 * Builds a complete non-streaming OpenAI response from a pi AssistantMessage.
 *
 * @remarks
 * Text parts are concatenated (`content` is `null` when there are none); thinking parts are
 * dropped. Tool call arguments are JSON-encoded.
 *
 * @param requestId - the response `id`
 * @param canonicalModelId - the model ID reported as `model`
 * @param message - pi's final assistant message
 * @returns the `chat.completion` object with a single choice
 */
export function buildChatCompletion(
  requestId: string,
  canonicalModelId: string,
  message: AssistantMessage
): OpenAIChatCompletion {
  // Concatenate text content
  const textParts = message.content.filter((part): part is TextContent => part.type === 'text')
  const textContent =
    textParts.length > 0 ? textParts.map((textPart) => textPart.text).join('') : null

  // Convert tool calls
  const toolCallParts = message.content.filter((part): part is ToolCall => part.type === 'toolCall')
  const toolCalls: OpenAIToolCall[] = toolCallParts.map((tc) => ({
    id: tc.id,
    type: 'function' as const,
    function: {
      name: tc.name,
      arguments: JSON.stringify(tc.arguments)
    }
  }))

  const finishReason = mapFinishReason(message.stopReason)
  const usage = mapUsage(message.usage)
  responsesLogger.debug('Built chat completion: {finishReason}, {totalTokens} tokens', {
    model: canonicalModelId,
    finishReason,
    stopReason: message.stopReason,
    textChars: textContent?.length ?? 0,
    toolCallCount: toolCalls.length,
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    cacheReadTokens: message.usage.cacheRead,
    cacheWriteTokens: message.usage.cacheWrite
  })

  const messageBody: OpenAIChatCompletionChoice['message'] =
    toolCalls.length > 0
      ? { role: 'assistant', content: textContent, tool_calls: toolCalls }
      : { role: 'assistant', content: textContent }

  return {
    id: requestId,
    object: 'chat.completion',
    created: Math.floor(Date.now() / MS_PER_SECOND),
    model: canonicalModelId,
    choices: [
      {
        index: 0,
        message: messageBody,
        finish_reason: finishReason,
        logprobs: null
      }
    ],
    usage,
    x_pi: {
      cost: message.usage.cost,
      cache_read_tokens: message.usage.cacheRead,
      cache_write_tokens: message.usage.cacheWrite
    }
  }
}
