/**
 * A local mock provider for tests that need a real upstream: pi's real provider code calls it over
 * real HTTP on 127.0.0.1, and each model ID is answered by a reply. The scripted replies below
 * speak OpenAI's chat completions SSE (pi's `openai-completions` API), and `googleSse` speaks
 * Google's (`google-generative-ai`); `replay` from `test/fixtures/recording.ts` serves recorded
 * real traffic of any API, such as `anthropic-messages`. It records every request it receives, so
 * a test can check what pi sent.
 *
 * Point a fixture `models.json` at it with `mock.provider(api)` (see `test/fixtures/agent-dir.ts`).
 *
 * @packageDocumentation
 */

import { once } from 'node:events'
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import { zstdDecompressSync } from 'node:zlib'

import { isRecord } from '@proxy/utils/guards'

import { listenOnLoopback } from './local-server'

/** One request the mock received. */
export interface MockRequest {
  /** The request URL's path and query, as sent. */
  readonly path: string
  readonly headers: IncomingHttpHeaders
  /** The decoded body: parsed JSON, the raw text when not JSON, or `undefined` when empty. */
  readonly body: unknown
}

/** Answers one request. It may write slowly, stop partway, or never write at all. */
export type MockReply = (response: ServerResponse, request: MockRequest) => void | Promise<void>

/** A running mock provider, from {@link startMockProvider}. */
export interface MockProvider {
  /** `http://127.0.0.1:<port>`, without an API path prefix. */
  readonly origin: string
  /** Every request received, in order. */
  readonly requests: readonly MockRequest[]
  /**
   * A `models.json` provider entry pointing at this server, with a literal fake key and one model
   * per scripted reply. `openai-completions` (the default) puts `/v1` in the base URL, as OpenAI
   * clients expect; `anthropic-messages` and `google-generative-ai` do not, because their clients
   * add their own path.
   *
   * @param api - the pi API the entry declares; `openai-completions` when omitted
   * @returns the provider entry, to put under `providers.<name>` in `models.json`
   */
  provider(
    api?: 'openai-completions' | 'anthropic-messages' | 'google-generative-ai'
  ): Record<string, unknown>
  /** Drops open connections and stops the server. */
  close(): Promise<void>
}

/** HTTP 200, for a streamed answer. */
const HTTP_OK = 200
/** HTTP 400, for a request body that is not JSON. */
const HTTP_BAD_REQUEST = 400
/** HTTP 404, for a model the mock has no reply for. */
const HTTP_NOT_FOUND = 404

/**
 * Parses a request body.
 *
 * @param text - the decoded body text
 * @returns the body as JSON, the raw text when it is not JSON, or `undefined` when empty
 */
function parseBody(text: string): unknown {
  if (text === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/**
 * Returns the request body as text.
 *
 * @remarks
 * pi's Codex adapter zstd-compresses its bodies, as the Codex backend accepts. A body that does not
 * decompress stays as sent: it is then not JSON, and the mock answers 400 instead of throwing
 * inside the request handler.
 *
 * @param raw - the body bytes as received
 * @param contentEncoding - the request's `content-encoding` header; only `zstd` is decoded
 * @returns the decompressed text, or the raw bytes as text when not zstd or not decompressible
 */
function decodeBody(raw: Buffer, contentEncoding: string | undefined): string {
  if (contentEncoding !== 'zstd') return raw.toString()
  try {
    return zstdDecompressSync(raw).toString()
  } catch {
    return raw.toString()
  }
}

/** Google's request path: `/models/<id>:<method>`, the model ID before the colon. */
const GOOGLE_MODEL_PATH = /\/models\/([^/:?]+):/u

/**
 * Finds the model a request asks for.
 *
 * @remarks
 * OpenAI-style and Anthropic APIs name it in the body's `model` field; Google's names it in the
 * URL path (`/models/<id>:streamGenerateContent`).
 *
 * @param body - the decoded request body
 * @param path - the request path and query
 * @returns the model ID, or `''` when the request names none
 */
function requestedModel(body: unknown, path: string): string {
  if (isRecord(body) && typeof body['model'] === 'string') return body['model']
  return GOOGLE_MODEL_PATH.exec(path)?.[1] ?? ''
}

/**
 * Starts the mock on a free loopback port.
 *
 * @remarks
 * A request is matched on the model it asks for ({@link requestedModel}). A body that is not
 * JSON gets a 400, and a model with no reply gets a 404; every request is recorded in `requests`
 * either way.
 *
 * @param replies - maps a model ID to how requests for it are answered
 * @returns the running mock: its origin, the requests received, a provider entry, and `close()`
 */
export async function startMockProvider(
  replies: Readonly<Record<string, MockReply>>
): Promise<MockProvider> {
  const requests: MockRequest[] = []
  const server: Server = createServer((incoming, response) => {
    const parts: Buffer[] = []
    incoming.on('data', (part: Buffer) => {
      parts.push(part)
    })
    incoming.on('end', () => {
      const body = parseBody(decodeBody(Buffer.concat(parts), incoming.headers['content-encoding']))
      const request: MockRequest = { path: incoming.url ?? '', headers: incoming.headers, body }
      requests.push(request)
      // Recorded either way, so a test can see what pi sent; but a provider would refuse it.
      if (typeof body === 'string') {
        void httpError(HTTP_BAD_REQUEST, {
          error: { message: 'mock got a body that is not JSON' }
        })(response, request)
        return
      }
      const model = requestedModel(body, request.path)
      const reply = replies[model]
      if (reply === undefined) {
        void httpError(HTTP_NOT_FOUND, { error: { message: `mock has no model ${model}` } })(
          response,
          request
        )
        return
      }
      void reply(response, request)
    })
  })
  const origin = await listenOnLoopback(server)

  return {
    origin,
    requests,
    provider: (api = 'openai-completions') => ({
      baseUrl: api === 'openai-completions' ? `${origin}/v1` : origin,
      api,
      apiKey: 'notarealsecret-mock-provider-key',
      models: Object.keys(replies).map((modelId) => ({ id: modelId }))
    }),
    async close() {
      server.closeAllConnections()
      server.close()
      await once(server, 'close')
    }
  }
}

/**
 * Builds one `chat.completion.chunk` with this delta and finish reason.
 *
 * @param delta - the choice's `delta`
 * @param finishReason - the choice's `finish_reason`; `null` (the default) mid-stream
 * @param extra - top-level fields merged into the chunk, such as `usage`
 * @returns the chunk, for choice index 0 of model `mock`
 */
export function chunk(
  delta: Record<string, unknown>,
  finishReason: string | null = null,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'mock',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...extra
  }
}

/**
 * Builds text deltas, one chunk per part; the first also carries `role: 'assistant'`.
 *
 * @param parts - the text pieces, in order
 * @returns one chunk per part
 */
export function textChunks(...parts: string[]): Record<string, unknown>[] {
  return parts.map((content, partIndex) =>
    chunk(partIndex === 0 ? { role: 'assistant', content } : { content })
  )
}

/**
 * Builds one tool call's deltas: its id and name first, then its arguments split across chunks.
 *
 * @param toolIndex - the tool call's `index` in the choice's `tool_calls`
 * @param call - the call's id and name, and its arguments JSON split into parts; the first part
 *   rides on the chunk with the id and name
 * @returns one chunk per argument part (one chunk when there are no parts)
 */
export function toolCallChunks(
  toolIndex: number,
  call: { readonly id: string; readonly name: string; readonly argumentParts: readonly string[] }
): Record<string, unknown>[] {
  const [first = '', ...rest] = call.argumentParts
  return [
    chunk({
      tool_calls: [
        {
          index: toolIndex,
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: first }
        }
      ]
    }),
    ...rest.map((argumentsPart) =>
      chunk({ tool_calls: [{ index: toolIndex, function: { arguments: argumentsPart } }] })
    )
  ]
}

/**
 * Builds the closing chunk: a finish reason, and usage when given (as
 * `stream_options.include_usage`).
 *
 * @param finishReason - the choice's `finish_reason`
 * @param usage - prompt and completion token counts; `total_tokens` is their sum. Omitted: no
 *   `usage` field
 * @returns the chunk, with an empty delta
 */
export function finishChunk(
  finishReason: string,
  usage?: { readonly prompt_tokens: number; readonly completion_tokens: number }
): Record<string, unknown> {
  return chunk(
    {},
    finishReason,
    usage === undefined
      ? {}
      : { usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens } }
  )
}

/**
 * Builds a complete SSE answer: status 200, each chunk as a `data:` event, then `[DONE]`.
 *
 * @param chunks - the chunks to send, in order
 * @param options - `intervalMs` to wait between chunks; omitted, they are sent back to back
 * @returns the reply
 */
export function sse(
  chunks: readonly Record<string, unknown>[],
  options: { readonly intervalMs?: number } = {}
): MockReply {
  return async (response) => {
    response.writeHead(HTTP_OK, { 'content-type': 'text/event-stream' })
    for (const [chunkIndex, event] of chunks.entries()) {
      if (chunkIndex > 0 && options.intervalMs !== undefined) await sleep(options.intervalMs)
      response.write(`data: ${JSON.stringify(event)}\n\n`)
    }
    response.end('data: [DONE]\n\n')
  }
}

/**
 * Builds a complete Google answer for pi's `google-generative-ai` API: status 200, then one SSE
 * `data:` event per text part, the last with `finishReason: STOP` and token counts. Google's
 * stream has no `[DONE]` marker; the response just ends.
 *
 * @param parts - the text parts, in order
 * @returns the reply
 */
export function googleSse(...parts: string[]): MockReply {
  return (response) => {
    response.writeHead(HTTP_OK, { 'content-type': 'text/event-stream' })
    for (const [partIndex, partText] of parts.entries()) {
      const last = partIndex === parts.length - 1
      const event = {
        candidates: [
          {
            content: { role: 'model', parts: [{ text: partText }] },
            index: 0,
            ...(last ? { finishReason: 'STOP' } : {})
          }
        ],
        ...(last
          ? { usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } }
          : {})
      }
      response.write(`data: ${JSON.stringify(event)}\n\n`)
    }
    response.end()
  }
}

/**
 * Builds a reply that starts answering, sends these chunks, then goes quiet without ending the
 * response.
 *
 * @param chunks - the chunks to send before going quiet
 * @returns the reply
 */
export function stall(chunks: readonly Record<string, unknown>[]): MockReply {
  return (response) => {
    response.writeHead(HTTP_OK, { 'content-type': 'text/event-stream' })
    for (const event of chunks) response.write(`data: ${JSON.stringify(event)}\n\n`)
  }
}

/**
 * Builds a reply that starts a stream, sends these text deltas, then drops the connection.
 *
 * @remarks
 * No finish chunk and no `[DONE]` are sent.
 *
 * @param parts - the text of each delta, in order
 * @returns the reply
 */
export function cutOff(...parts: string[]): MockReply {
  return (response) => {
    response.writeHead(HTTP_OK, { 'content-type': 'text/event-stream' })
    const events = textChunks(...parts)
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join('')
    // Destroyed once written: destroying right after `write` can drop the data unsent.
    response.write(events, () => response.destroy())
  }
}

/**
 * Builds a reply that never answers: no status, no headers, no body.
 *
 * @returns the reply
 */
export function silent(): MockReply {
  return () => undefined
}

/**
 * Builds a reply that answers with this HTTP status and JSON body.
 *
 * @param status - the HTTP status code
 * @param body - the body, serialized as JSON
 * @returns the reply
 */
export function httpError(status: number, body: unknown): MockReply {
  return (response) => {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  }
}
