/**
 * A provider whose call fails: what the client gets, what is logged, and what is counted. pi's
 * adapters report failures as an `error` event, so every other failure test goes that way; most of
 * these make pi's `streamSimple` throw, when the call starts and once its stream has started. The
 * provider's raw text is logged once per failure, at debug, whichever way it failed (#339).
 */

import type { AssistantMessage, AssistantMessageEvent, Context } from '@earendil-works/pi-ai'
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import { resetSync } from '@logtape/logtape'
import type { FailureClass } from '@proxy/config/schema'
import { configureLogging } from '@proxy/logging'
import { convertMessages } from '@proxy/openai/messages'
import { clearAllCooldowns } from '@proxy/pi/cooldowns'
import { getRuntime } from '@proxy/pi/registry'
import { beginActiveRequest } from '@proxy/server/active-requests'
import { chatFormat } from '@proxy/server/answer-formats'
import { dispatchChat } from '@proxy/server/chat-dispatch'
import { clearRouteTotals, routeTotals } from '@proxy/server/route-totals'
import type { ProxyEnv } from '@proxy/server/types'
import { isRecord } from '@proxy/utils/guards'
import { Hono } from 'hono'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi
} from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir, offlineProvider } from '../fixtures/agent-dir'
import { exposed, parseChatBody, testApp } from '../helpers'

/** What the provider's error quotes back: it must reach the log at debug only, and never the client. */
const QUOTED = 'notarealsecret-quoted-by-provider'
const BELOW_DEFAULT_LEVEL = new Set(['TRACE', 'DEBUG'])
/** The one model the fixture serves. */
const MODEL = 'thrower/model'

let agentDir: FixtureAgentDir
let records: { level: string; logger: string; message: string; line: string }[] = []

beforeAll(async () => {
  agentDir = await loadFixtureAgentDir({
    modelsJson: { providers: { thrower: offlineProvider('model') } }
  })
})

beforeEach(() => {
  records = []
  configureLogging({
    level: 'trace',
    format: 'json',
    write: (line) => {
      const parsed: unknown = JSON.parse(line)
      const field = (name: string): string =>
        isRecord(parsed) && typeof parsed[name] === 'string' ? parsed[name] : ''
      records.push({
        level: field('level'),
        logger: field('logger'),
        message: field('message'),
        line
      })
    }
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  clearAllCooldowns()
  clearRouteTotals()
})

afterAll(() => {
  resetSync()
  vi.unstubAllEnvs()
  agentDir.remove()
})

/**
 * Lists the log records at the default level (info) and above.
 *
 * @returns those records
 */
function atDefaultLevel(): typeof records {
  return records.filter((record) => !BELOW_DEFAULT_LEVEL.has(record.level))
}

/**
 * Lists the log records that quote the provider's text.
 *
 * @returns those records
 */
function quoting(): typeof records {
  return records.filter((record) => record.line.includes(QUOTED))
}

/** The record a failed call's provider text must be logged as, once: `pi.complete` at debug. */
const LOGGED_DETAIL = {
  logger: 'pi-switchboard.pi.complete',
  level: 'DEBUG',
  message: expect.stringContaining('Upstream error detail') as unknown
}

/**
 * Builds the partial message a stream's `start` event carries: nothing generated yet.
 *
 * @returns the message
 */
function emptyPartial(): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: 'openai-completions',
    provider: 'thrower',
    model: 'model',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: 'stop',
    timestamp: 0
  }
}

/** A pi event stream that starts, then throws while it is read, as a broken provider could. */
class ThrowingAfterStart extends AssistantMessageEventStream {
  /**
   * Yields the `start` event, then throws.
   *
   * @returns the stream's events: `start` only
   * @throws Error with an upstream 503 message that quotes {@link QUOTED}
   */
  override async *[Symbol.asyncIterator](): AsyncGenerator<AssistantMessageEvent> {
    yield { type: 'start', partial: emptyPartial() }
    await Promise.resolve()
    throw new Error(`OpenAI API error (503): overloaded while answering "${QUOTED}"`)
  }
}

/**
 * Builds a pi event stream that ends with a provider's `error` event quoting {@link QUOTED}, as
 * pi's adapters report a failed call.
 *
 * @param started - whether a `start` event comes first, as when the failure is mid-stream
 * @returns the stream, with all its events pushed
 */
function failingStream(started: boolean): AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream()
  if (started) stream.push({ type: 'start', partial: emptyPartial() })
  stream.push({
    type: 'error',
    reason: 'error',
    error: {
      ...emptyPartial(),
      stopReason: 'error',
      errorMessage: `OpenAI API error (503): overloaded while answering "${QUOTED}"`
    }
  })
  return stream
}

/**
 * Posts a chat request to the full app.
 *
 * @param stream - whether to ask for a stream
 * @returns the response's status and body
 */
async function postChat(stream: boolean): Promise<{ status: number; text: string }> {
  const response = await testApp().request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, stream, messages: [{ role: 'user', content: 'Hi' }] })
  })
  return { status: response.status, text: await response.text() }
}

/** A streamed chat request dispatched straight to its candidates, without the route before it. */
interface DirectDispatch {
  /** The models to try, in order. */
  readonly candidates: readonly { readonly provider: string; readonly id: string }[]
  /** The failure classes that move on to the next candidate. */
  readonly fallbackOn: ReadonlySet<FailureClass>
  /** A per-request upstream key: the candidates after the first need no credential check. */
  readonly upstreamApiKey?: string
}

/**
 * Dispatches a streamed chat request with no idle timeout, as `CompletionOptions` allows: with
 * one, pi's stream is relayed and a throw becomes an error event.
 *
 * @param dispatch - the candidates, fallback classes and upstream key
 * @returns the response's status and body
 */
async function dispatchDirect(dispatch: DirectDispatch): Promise<{ status: number; text: string }> {
  const request = parseChatBody({
    model: MODEL,
    stream: true,
    messages: [{ role: 'user', content: 'Hi' }]
  })
  const conversion = convertMessages(request.messages)
  if (!conversion.ok) throw new Error('messages did not convert')
  const context: Context = conversion.context
  const requestId = 'chatcmpl-thrown'
  const app = new Hono<ProxyEnv>().post('/', (honoContext) =>
    dispatchChat(honoContext, {
      requestId,
      alias: undefined,
      candidates: dispatch.candidates.map(({ provider, id }) => exposed(provider, id)),
      fallbackOn: dispatch.fallbackOn,
      loginFallbackOn: new Set(),
      reserve: {},
      attempts: [],
      context,
      request,
      format: chatFormat(requestId, request),
      options: {
        signal: new AbortController().signal,
        ...(dispatch.upstreamApiKey === undefined
          ? {}
          : { upstreamApiKey: dispatch.upstreamApiKey })
      },
      active: beginActiveRequest({
        requestId,
        alias: null,
        model: MODEL,
        stream: true,
        promptCacheKey: false
      })
    })
  )
  const response = await app.request('/', { method: 'POST' })
  return { status: response.status, text: await response.text() }
}

describe('a provider that throws when the call starts', () => {
  // error event, or quoting the provider's text to the client; the throw going unlogged
  // (`logUpstreamThrow`), or its text logged above debug; and its text logged twice, by the call
  // and again by the route (#339).
  test.each([
    ['non-streaming', false],
    ['streaming', true]
  ])('%s: answers the mapped error, and logs the throw', async (_mode, stream) => {
    vi.spyOn(getRuntime(), 'streamSimple').mockImplementation(() => {
      throw new Error(`OpenAI API error (429): Rate limit reached for "${QUOTED}"`)
    })

    const { status, text } = await postChat(stream)

    expect(status).toBe(429)
    expect(JSON.parse(text)).toEqual({
      error: {
        message: 'Upstream rate limit exceeded',
        type: 'server_error',
        param: null,
        code: 'rate_limit'
      }
    })
    expect(text).not.toContain(QUOTED)
    expect(atDefaultLevel()).toContainEqual(
      expect.objectContaining({
        logger: 'pi-switchboard.pi.complete',
        level: 'WARN',
        message: expect.stringContaining('threw after') as unknown
      })
    )
    for (const record of atDefaultLevel()) expect(record.line).not.toContain(QUOTED)
    expect(quoting()).toEqual([expect.objectContaining(LOGGED_DETAIL)])
  })
})

describe('a provider that reports a failure before the stream starts', () => {
  // Catches the provider's text for a failed call logged twice at debug, by the call (`pi.complete`)
  // and again by the route (`server.chat`) as it answers the failure (#339); or logged above debug.
  test.each([
    ['non-streaming', false],
    ['streaming', true]
  ])('%s: logs the provider text once, at debug', async (_mode, stream) => {
    vi.spyOn(getRuntime(), 'streamSimple').mockImplementation(() => failingStream(false))

    const { status, text } = await postChat(stream)

    expect(status).toBe(503)
    expect(text).not.toContain(QUOTED)
    for (const record of atDefaultLevel()) expect(record.line).not.toContain(QUOTED)
    expect(quoting()).toEqual([expect.objectContaining(LOGGED_DETAIL)])
  })

  // Catches the provider's text for an attempt a chain moves on from logged twice, by the call and
  // again beside the fallback warning (#339): each attempt's text is logged once, by its call.
  test('logs each failed attempt of a chain once, with its attempt number', async () => {
    vi.spyOn(getRuntime(), 'streamSimple').mockImplementation(() => failingStream(false))

    const { status } = await dispatchDirect({
      candidates: [
        { provider: 'thrower', id: 'model' },
        { provider: 'thrower', id: 'other' }
      ],
      fallbackOn: new Set(['unavailable']),
      upstreamApiKey: 'notarealsecret-client-upstream-key'
    })

    expect(status).toBe(503)
    const logged = quoting()
    expect(logged).toEqual([
      expect.objectContaining(LOGGED_DETAIL),
      expect.objectContaining(LOGGED_DETAIL)
    ])
    expect(logged.map((record) => JSON.parse(record.line) as unknown)).toEqual([
      expect.objectContaining({ properties: expect.objectContaining({ attempt: 1 }) as unknown }),
      expect.objectContaining({ properties: expect.objectContaining({ attempt: 2 }) as unknown })
    ])
  })
})

describe('a provider that reports a failure once the stream has started', () => {
  // Catches the provider's text for a mid-stream error event logged twice at debug, by the call
  // (`pi.complete`) and again by the SSE writer (`openai.sse`) (#339); or logged above debug.
  test('ends the stream with the error frame, and logs the provider text once', async () => {
    vi.spyOn(getRuntime(), 'streamSimple').mockImplementation(() => failingStream(true))

    const { status, text } = await postChat(true)

    expect(status).toBe(200)
    expect(text).toContain('provider_unavailable')
    expect(text).not.toContain(QUOTED)
    for (const record of atDefaultLevel()) expect(record.line).not.toContain(QUOTED)
    expect(quoting()).toEqual([expect.objectContaining(LOGGED_DETAIL)])
  })
})

describe('a provider whose stream throws once it has started', () => {
  // Catches a throw out of a started stream (`reportThrownFailure`) leaving the client a stream
  // with no error frame and no `[DONE]`, quoting the provider's text, going unlogged or logged
  // more than once, or not counted as the attempt's failure in the route totals. pi's call never
  // ends, so the route is the one that logs the text.
  test('ends the stream with the mapped error frame, logs it, and counts the failure', async () => {
    vi.spyOn(getRuntime(), 'streamSimple').mockImplementation(() => new ThrowingAfterStart())

    const { status, text } = await dispatchDirect({
      candidates: [{ provider: 'thrower', id: 'model' }],
      fallbackOn: new Set()
    })

    expect(status).toBe(200)
    const frames = text.split('\n\n').filter((frame) => frame !== '')
    expect(frames.slice(-2)).toEqual([
      `data: ${JSON.stringify({
        error: {
          message: 'Upstream provider is unavailable',
          type: 'server_error',
          param: null,
          code: 'provider_unavailable'
        }
      })}`,
      'data: [DONE]'
    ])
    expect(text).not.toContain(QUOTED)
    expect(atDefaultLevel()).toContainEqual(
      expect.objectContaining({
        logger: 'pi-switchboard.server.chat',
        level: 'ERROR',
        message: expect.stringContaining('Upstream call failed with 503') as unknown
      })
    )
    for (const record of atDefaultLevel()) expect(record.line).not.toContain(QUOTED)
    expect(quoting()).toEqual([
      expect.objectContaining({
        logger: 'pi-switchboard.server.chat',
        level: 'DEBUG',
        message: expect.stringContaining('Upstream error detail') as unknown
      })
    ])
    expect(routeTotals()).toEqual([
      expect.objectContaining({
        model: MODEL,
        requests: 1,
        failures: 1,
        failuresByClass: { unavailable: 1 }
      })
    ])
  })

  // Catches the provider's text for a stream that throws once started logged more than once when
  // the idle timeout relays the stream (as the server always does): the relay logs the text, and
  // the error event it sends on carries only fixed wording, so nothing logs the text again (#339).
  test('relayed by the idle timeout: logs the provider text once, at debug', async () => {
    vi.spyOn(getRuntime(), 'streamSimple').mockImplementation(() => new ThrowingAfterStart())

    const { status, text } = await postChat(true)

    expect(status).toBe(200)
    expect(text).not.toContain(QUOTED)
    for (const record of atDefaultLevel()) expect(record.line).not.toContain(QUOTED)
    expect(quoting()).toEqual([
      expect.objectContaining({
        logger: 'pi-switchboard.pi.complete',
        level: 'DEBUG',
        message: expect.stringContaining('Upstream stream failure detail') as unknown
      })
    ])
  })
})
