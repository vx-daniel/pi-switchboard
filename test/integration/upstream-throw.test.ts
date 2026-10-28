/**
 * A provider that throws instead of reporting a failed call: what the client gets, what is logged,
 * and what is counted. pi's adapters report failures as an `error` event, so every other failure
 * test goes that way; these make pi's `streamSimple` throw, when the call starts and once its
 * stream has started.
 */

import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai'
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import { resetSync } from '@logtape/logtape'
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

describe('a provider that throws when the call starts', () => {
  // Catches a throw from pi's `streamSimple` escaping as the proxy's own 500, mapped apart from an
  // error event, or quoting the provider's text to the client; and the throw going unlogged
  // (`logUpstreamThrow`), or its text logged above debug.
  test.each([
    ['non-streaming', false],
    ['streaming', true]
  ])('%s: answers the mapped error, and logs the throw', async (_mode, stream) => {
    vi.spyOn(getRuntime(), 'streamSimple').mockImplementation(() => {
      throw new Error(`OpenAI API error (429): Rate limit reached for "${QUOTED}"`)
    })

    const response = await testApp().request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, stream, messages: [{ role: 'user', content: 'Hi' }] })
    })
    const text = await response.text()

    expect(response.status).toBe(429)
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
    expect(records.some((record) => record.level === 'DEBUG' && record.line.includes(QUOTED))).toBe(
      true
    )
  })
})

describe('a provider whose stream throws once it has started', () => {
  // Catches a throw out of a started stream (`reportThrownFailure`) leaving the client a stream
  // with no error frame and no `[DONE]`, quoting the provider's text, going unlogged, or not
  // counted as the attempt's failure in the route totals. Dispatched without an idle timeout, as
  // `CompletionOptions` allows: with one, pi's stream is relayed and a throw becomes an error event.
  test('ends the stream with the mapped error frame, logs it, and counts the failure', async () => {
    vi.spyOn(getRuntime(), 'streamSimple').mockImplementation(() => new ThrowingAfterStart())
    const request = parseChatBody({
      model: MODEL,
      stream: true,
      messages: [{ role: 'user', content: 'Hi' }]
    })
    const conversion = convertMessages(request.messages)
    if (!conversion.ok) throw new Error('messages did not convert')
    const requestId = 'chatcmpl-thrown'
    const app = new Hono<ProxyEnv>().post('/', (context) =>
      dispatchChat(context, {
        requestId,
        alias: undefined,
        candidates: [exposed('thrower', 'model')],
        fallbackOn: new Set(),
        loginFallbackOn: new Set(),
        reserve: {},
        attempts: [],
        context: conversion.context,
        request,
        format: chatFormat(requestId, request),
        options: { signal: new AbortController().signal },
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
    const text = await response.text()

    expect(response.status).toBe(200)
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
    expect(records.some((record) => record.level === 'DEBUG' && record.line.includes(QUOTED))).toBe(
      true
    )
    expect(routeTotals()).toEqual([
      expect.objectContaining({
        model: MODEL,
        requests: 1,
        failures: 1,
        failuresByClass: { unavailable: 1 }
      })
    ])
  })
})
