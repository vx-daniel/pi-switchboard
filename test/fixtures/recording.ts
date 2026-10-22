/**
 * Record and replay real provider traffic.
 *
 * Recording (`pnpm run test:live:record`, on demand only) puts a pass-through server between pi
 * and the real provider: pi's `models.json` points the provider's `baseUrl` at it, it forwards each
 * request unchanged and saves the response, chunk by chunk, with the request pi sent minus its
 * credentials. Replay (offline, the default) serves a saved response from the mock provider
 * (`test/fixtures/mock-provider.ts`), so a test drives pi's real client over real HTTP with
 * real-shaped provider output, without a login or a network.
 *
 * Relative imports only, with their `.ts` extension: `scripts/record-fixtures.ts` runs this under
 * Node directly, where the `@proxy/*` aliases do not resolve and Node does not add extensions.
 *
 * @packageDocumentation
 */

import { once } from 'node:events'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'

import * as z from 'zod'

import { decodeBody, listenOnLoopback, onRequestBody } from './local-server.ts'

/** Where recordings live: `<api>/<scenario>.json`. */
export const RECORDINGS_DIR = join(import.meta.dirname, 'recordings')

/** The recording format version; {@link loadRecording} rejects any other. */
const RECORDING_VERSION = 1
/** Recordings are committed and reviewed: pretty-printed, so a re-recording diffs readably. */
const JSON_INDENT = 2

/** Request headers worth keeping: a pi upgrade that changes them shows up as a diff. */
const KEPT_REQUEST_HEADERS = new Set([
  'anthropic-beta',
  'anthropic-version',
  'content-type',
  'user-agent',
  'x-app'
])

/**
 * Response headers worth keeping: the quota a subscription reports (#69, PLAN "Quota"), each by
 * its exact name. Never a prefix: the same responses carry `anthropic-organization-id`,
 * `anthropic-workspace-id`, `set-cookie`, request IDs and `x-codex-turn-state`, an opaque token.
 */
const KEPT_RESPONSE_HEADER = new RegExp(
  `^(?:${[
    'anthropic-ratelimit-unified-(?:5h|7d)-(?:utilization|reset|status)',
    'anthropic-ratelimit-unified-(?:status|reset|representative-claim)',
    'x-codex-(?:primary|secondary)-(?:used-percent|reset-at|reset-after-seconds|window-minutes)',
    'x-codex-(?:plan-type|active-limit)'
  ].join('|')})$`
)

/**
 * One body chunk, verbatim. Not `z.string().trim()`: SSE framing is whitespace, and trimming would
 * merge events.
 */
const RawChunkSchema = z.custom<string>((value) => typeof value === 'string', 'expected a string')

/** The shape of a saved recording file. */
const RecordingSchema = z.object({
  version: z.literal(RECORDING_VERSION),
  api: z.string().trim(),
  scenario: z.string().trim(),
  model: z.string().trim(),
  recordedAt: z.string().trim(),
  piVersion: z.string().trim(),
  request: z.object({
    path: z.string().trim(),
    headers: z.record(z.string().trim(), z.string().trim()),
    body: z.unknown()
  }),
  response: z.object({
    status: z.int(),
    contentType: z.string().trim(),
    /** The quota headers the provider sent (#69), by name; none in recordings made before. */
    headers: z.record(z.string().trim(), z.string().trim()).optional(),
    /** The body as the provider sent it, split where it arrived, so replay keeps the boundaries. */
    chunks: z.array(RawChunkSchema)
  })
})

/** One saved recording: what pi sent, and what the provider answered, chunk by chunk. */
export type Recording = z.infer<typeof RecordingSchema>

/** What the recorder captured for one request, before it is named and saved. */
export type CapturedExchange = Pick<Recording, 'request' | 'response'>

/**
 * Returns where a recording lives.
 *
 * @param api - the pi API the recording speaks, such as `anthropic-messages`
 * @param scenario - the scenario's name
 * @param directory - the recordings root; {@link RECORDINGS_DIR} by default
 * @returns `<directory>/<api>/<scenario>.json`
 */
export function recordingPath(api: string, scenario: string, directory = RECORDINGS_DIR): string {
  return join(directory, api, `${scenario}.json`)
}

/**
 * Reads and validates a saved recording.
 *
 * @param api - the pi API the recording speaks
 * @param scenario - the scenario's name
 * @param directory - the recordings root; {@link RECORDINGS_DIR} by default
 * @returns the recording
 * @throws Error when the recording does not match the recording schema; the file system's error
 *   when it cannot be read, and a `SyntaxError` when it is not JSON
 */
export function loadRecording(
  api: string,
  scenario: string,
  directory = RECORDINGS_DIR
): Recording {
  const parsed = RecordingSchema.safeParse(
    JSON.parse(readFileSync(recordingPath(api, scenario, directory), 'utf8'))
  )
  if (!parsed.success) {
    throw new Error(`Recording ${api}/${scenario} is malformed: ${parsed.error.message}`)
  }
  return parsed.data
}

/** Credential-shaped text a recording must never contain, whatever the request headers held. */
const CREDENTIAL_PATTERN = /sk-ant-[a-z]{3}\d{2}-|Bearer\s+\S{20,}/

/**
 * Saves a recording, unless it contains a credential: any of `secrets` (the values the request's
 * auth headers carried) or anything shaped like one.
 *
 * @remarks
 * Refuses rather than redacts, so a leak is noticed instead of silently patched.
 *
 * @param recording - the recording to save
 * @param secrets - credential values that must not appear in it; empty strings are ignored
 * @param directory - the recordings root; {@link RECORDINGS_DIR} by default
 * @returns the path the recording was written to
 * @throws Error when the recording contains a credential
 */
export function saveRecording(
  recording: Recording,
  secrets: readonly string[],
  directory = RECORDINGS_DIR
): string {
  const text = `${JSON.stringify(recording, null, JSON_INDENT)}\n`
  const leaked = secrets.filter((secret) => secret !== '' && text.includes(secret))
  if (leaked.length > 0 || CREDENTIAL_PATTERN.test(text)) {
    throw new Error(
      `Refusing to save ${recording.api}/${recording.scenario}: it contains a credential`
    )
  }
  const path = recordingPath(recording.api, recording.scenario, directory)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  return path
}

/**
 * Collects the values a request carried that its recording must not contain: its credentials, and
 * the ChatGPT account ID Codex requests name the login by.
 *
 * @param headers - the request headers; `authorization`, `x-api-key`, `cookie` and
 *   `chatgpt-account-id` are read
 * @returns each such header's value, and the value again without a `Bearer ` prefix
 */
export function credentialsIn(headers: IncomingHttpHeaders): string[] {
  const values: string[] = []
  for (const headerName of ['authorization', 'x-api-key', 'cookie', 'chatgpt-account-id']) {
    const headerValue = headers[headerName]
    if (typeof headerValue === 'string') {
      values.push(headerValue, headerValue.replace(/^Bearer\s+/i, ''))
    }
  }
  return values
}

/**
 * Keeps the request headers worth recording ({@link KEPT_REQUEST_HEADERS}).
 *
 * @param headers - the request headers
 * @returns the kept headers that have a single string value
 */
function keptHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const kept: Record<string, string> = {}
  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (KEPT_REQUEST_HEADERS.has(headerName) && typeof headerValue === 'string') {
      kept[headerName] = headerValue
    }
  }
  return kept
}

/**
 * Keeps the response headers worth recording: the quota ones ({@link KEPT_RESPONSE_HEADER}).
 *
 * @param headers - the upstream response's headers
 * @returns the kept headers, by lower-case name
 */
function keptResponseHeaders(headers: Headers): Record<string, string> {
  const kept: Record<string, string> = {}
  for (const [headerName, headerValue] of headers) {
    if (KEPT_RESPONSE_HEADER.test(headerName)) kept[headerName] = headerValue
  }
  return kept
}

/**
 * Parses a request body.
 *
 * @param text - the body text
 * @returns the body as JSON, or the text itself when it is not JSON
 */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** A running recorder, from {@link startRecorder}. */
export interface Recorder {
  /** The recorder's origin, `http://127.0.0.1:<port>`. */
  readonly baseUrl: string
  /** Every exchange so far, in order, with the credentials each request carried. */
  readonly exchanges: readonly { readonly exchange: CapturedExchange; readonly secrets: string[] }[]
  /** Drops open connections and stops the server. */
  close(): Promise<void>
}

/**
 * Starts a pass-through server on 127.0.0.1 that forwards every request to `upstreamOrigin` and
 * keeps what came back.
 *
 * @remarks
 * Point a provider's `baseUrl` at `recorder.baseUrl` plus the provider's own path prefix, if it has
 * one.
 *
 * @param upstreamOrigin - the real provider's origin, for example `https://api.anthropic.com`
 * @returns the running recorder: its base URL, the exchanges so far, and `close()`
 */
export async function startRecorder(upstreamOrigin: string): Promise<Recorder> {
  const exchanges: { exchange: CapturedExchange; secrets: string[] }[] = []
  const server: Server = createServer((incoming, response) => {
    onRequestBody(incoming, (body) => {
      const request = { path: incoming.url ?? '/', headers: incoming.headers, body }
      void record(upstreamOrigin, request, response, exchanges)
    })
  })
  const baseUrl = await listenOnLoopback(server)
  return {
    baseUrl,
    exchanges,
    async close() {
      server.closeAllConnections()
      server.close()
      await once(server, 'close')
    }
  }
}

/** Headers that describe the hop to the recorder, not the request: never forwarded. */
const HOP_HEADERS = new Set(['host', 'connection', 'content-length', 'accept-encoding'])
/** HTTP 502, sent to pi when the recorder cannot reach the upstream. */
const HTTP_BAD_GATEWAY = 502

/** One request pi sent to the recorder. */
interface IncomingRequest {
  readonly path: string
  readonly headers: IncomingHttpHeaders
  /** The body's bytes, as sent. */
  readonly body: Buffer
}

/**
 * Forwards one request upstream as a POST, streams the answer back to pi, and captures both.
 *
 * @param upstreamOrigin - the real provider's origin
 * @param request - the request pi sent to the recorder
 * @param response - the response to pi
 * @returns the captured exchange (kept headers only) and the credentials the request carried
 * @throws TypeError when the upstream body yields something other than bytes; `fetch` errors
 *   when the upstream cannot be reached
 */
async function forward(
  upstreamOrigin: string,
  { path, headers, body }: IncomingRequest,
  response: ServerResponse
): Promise<{ exchange: CapturedExchange; secrets: string[] }> {
  const forwarded = new Headers()
  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (!HOP_HEADERS.has(headerName) && typeof headerValue === 'string') {
      forwarded.set(headerName, headerValue)
    }
  }
  const upstream = await fetch(`${upstreamOrigin}${path}`, {
    method: 'POST',
    headers: forwarded,
    // As sent: pi's Codex adapter zstd-compresses its bodies (`content-encoding` is forwarded).
    body
  })
  const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream'
  response.writeHead(upstream.status, { 'content-type': contentType })
  const chunks: string[] = []
  if (upstream.body !== null) {
    const decoder = new TextDecoder()
    const reader = upstream.body.getReader()
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      const part: unknown = read.value
      if (!(part instanceof Uint8Array)) throw new TypeError('upstream body yielded non-bytes')
      const decoded = decoder.decode(part, { stream: true })
      chunks.push(decoded)
      response.write(decoded)
    }
  }
  response.end()
  return {
    exchange: {
      request: {
        path,
        headers: keptHeaders(headers),
        // Decoded: pi's Codex adapter zstd-compresses its bodies, and a recording keeps the JSON.
        body: parseJson(decodeBody(body, headers['content-encoding']))
      },
      response: {
        status: upstream.status,
        contentType,
        headers: keptResponseHeaders(upstream.headers),
        chunks
      }
    },
    secrets: credentialsIn(headers)
  }
}

/**
 * Forwards one request and keeps the exchange; if the upstream fails, says so to pi.
 *
 * @remarks
 * Before the upstream answered, pi gets a 502 with the reason. Once the status line has gone out
 * a 502 can no longer be sent, so the response is cut, as a dropped upstream connection looks to
 * pi; writing a second status there threw `ERR_HTTP_HEADERS_SENT` into an unhandled rejection
 * (#111). Either way, no exchange is kept.
 *
 * @param upstreamOrigin - the real provider's origin
 * @param request - the request pi sent to the recorder
 * @param response - the response to pi
 * @param exchanges - the recorder's exchange list, appended to on success
 */
async function record(
  upstreamOrigin: string,
  request: IncomingRequest,
  response: ServerResponse,
  exchanges: { exchange: CapturedExchange; secrets: string[] }[]
): Promise<void> {
  try {
    exchanges.push(await forward(upstreamOrigin, request, response))
  } catch (error) {
    if (response.headersSent) {
      response.destroy()
      return
    }
    response.writeHead(HTTP_BAD_GATEWAY, { 'content-type': 'text/plain' })
    response.end(`recorder could not reach ${upstreamOrigin}: ${String(error)}`)
  }
}

/**
 * Builds a mock reply that serves a recording: its status, content type, kept headers (the quota
 * ones, #69) and body chunks, in the order they arrived.
 *
 * @param recording - the recording to serve
 * @returns the reply, for {@link startMockProvider}
 */
export function replay(recording: Recording): (response: ServerResponse) => void {
  return (response) => {
    response.writeHead(recording.response.status, {
      ...recording.response.headers,
      'content-type': recording.response.contentType
    })
    for (const part of recording.response.chunks) response.write(part)
    response.end()
  }
}
