/**
 * How a dispatched request is answered: as a chat completion, or as a Responses API response
 * (#140). Everything before the answer, from model resolution to the upstream call and its
 * fallback, is the same for both (`chat-dispatch.ts`).
 *
 * @packageDocumentation
 */

import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai'
import { buildChatCompletion, type ResponseRoute } from '@proxy/openai/responses'
import { buildResponse, type ResponseFrame } from '@proxy/openai/responses-api/output'
import { streamResponses } from '@proxy/openai/responses-api/stream'
import type { ChatCompletionRequest } from '@proxy/openai/schemas'
import { streamToSSE } from '@proxy/openai/sse'
import type { OpenAIError } from '@proxy/server/errors'

/** A started stream's frames, and the frames that end it on a failure thrown mid-stream. */
export interface FormattedStream {
  readonly frames: AsyncIterable<string>
  /**
   * Ends the stream for a failure the dispatch caught.
   *
   * @param body - the mapped OpenAI error
   * @returns the frames to send
   */
  fail(body: OpenAIError): string[]
}

/** How the model's answer is written to the client. */
export interface AnswerFormat {
  /**
   * Builds the body of a non-streamed answer.
   *
   * @param message - pi's answer
   * @param route - how the request got to the model that answered
   * @returns the JSON body
   */
  complete(message: AssistantMessage, route: ResponseRoute): object
  /**
   * Turns pi's events into server-sent events.
   *
   * @param events - pi's events, from the first
   * @param route - how the request got to the model answering
   * @returns the frames
   */
  stream(events: AsyncIterable<AssistantMessageEvent>, route: ResponseRoute): FormattedStream
}

/**
 * Answers as chat completions: a `chat.completion` body, or `chat.completion.chunk` frames ending
 * in `[DONE]`.
 *
 * @param requestId - the proxy's request ID, the completion's `id`
 * @param request - the validated chat request; `stream_options.include_usage` is read
 * @returns the format
 */
export function chatFormat(requestId: string, request: ChatCompletionRequest): AnswerFormat {
  const includeUsage = request.stream_options?.include_usage === true
  return {
    complete: (message, route) => buildChatCompletion(requestId, message, route),
    stream: (events, route) => ({
      frames: streamToSSE(events, { requestId, route }, includeUsage),
      fail: (body) => [`data: ${JSON.stringify(body)}\n\n`, 'data: [DONE]\n\n']
    })
  }
}

/**
 * Answers as the Responses API: a `response` object, or `response.*` events.
 *
 * @param frame - the response's ID, time and the request's settings it echoes
 * @returns the format
 */
export function responsesFormat(frame: ResponseFrame): AnswerFormat {
  return {
    complete: (message, route) => buildResponse(frame, message, route),
    stream: (events, route) => streamResponses(events, frame, route)
  }
}
