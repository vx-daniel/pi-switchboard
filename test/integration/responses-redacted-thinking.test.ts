/**
 * A redacted thinking block on the Responses API (#337). pi keeps a redacted block's thinking as
 * the placeholder `[Reasoning redacted]` (`redacted: true`): the Anthropic adapter puts it in the
 * block when the block starts, Bedrock streams it as a delta. The finished `reasoning` item has an
 * empty summary, so neither a stream event nor the answer may carry the placeholder as summary
 * text. pi's `streamSimple` is stubbed with each adapter's event sequence.
 */

import {
  type AssistantMessage,
  type AssistantMessageEvent,
  createAssistantMessageEventStream,
  type ThinkingContent
} from '@earendil-works/pi-ai'
import { getRuntime } from '@proxy/pi/registry'
import { isRecord } from '@proxy/utils/guards'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir, offlineProvider } from '../fixtures/agent-dir'
import { violations } from '../fixtures/openai-spec/violations'
import { jsonBody, testApp, testConfig } from '../helpers'

/** pi's text for a redacted thinking block (`anthropic-messages.js`, `bedrock-converse-stream.js`). */
const PLACEHOLDER = '[Reasoning redacted]'
/** The one model the fixture serves. */
const MODEL = 'redactor/model'

let agentDir: FixtureAgentDir

beforeAll(async () => {
  agentDir = await loadFixtureAgentDir({
    modelsJson: { providers: { redactor: offlineProvider({ id: 'model', reasoning: true }) } }
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(() => {
  vi.unstubAllEnvs()
  agentDir.remove()
})

/**
 * Builds pi's message with the given content.
 *
 * @param content - the blocks so far
 * @returns the message
 */
function message(content: AssistantMessage['content']): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'redactor',
    model: 'model',
    usage: {
      input: 3,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 5,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: 'stop',
    timestamp: 0
  }
}

/** The redacted block as pi finishes it, from either adapter. */
const REDACTED: ThinkingContent = {
  type: 'thinking',
  thinking: PLACEHOLDER,
  thinkingSignature: 'opaque-payload',
  redacted: true
}

/**
 * Builds the events of a redacted thinking block followed by the text `Done`.
 *
 * @param adapter - whose sequence: Anthropic's has the placeholder from the start, Bedrock's
 *   streams it as a delta once the block is marked redacted
 * @returns the events, `start` to `done`
 */
function redactedEvents(adapter: 'anthropic' | 'bedrock'): AssistantMessageEvent[] {
  const atStart = adapter === 'anthropic' ? REDACTED : { type: 'thinking' as const, thinking: '' }
  const text = { type: 'text' as const, text: 'Done' }
  const final = message([REDACTED, text])
  return [
    { type: 'start', partial: message([]) },
    { type: 'thinking_start', contentIndex: 0, partial: message([atStart]) },
    ...(adapter === 'bedrock'
      ? [
          {
            type: 'thinking_delta' as const,
            contentIndex: 0,
            delta: PLACEHOLDER,
            partial: message([REDACTED])
          }
        ]
      : []),
    { type: 'thinking_end', contentIndex: 0, content: PLACEHOLDER, partial: message([REDACTED]) },
    { type: 'text_start', contentIndex: 1, partial: message([REDACTED, { ...text, text: '' }]) },
    { type: 'text_delta', contentIndex: 1, delta: 'Done', partial: final },
    { type: 'text_end', contentIndex: 1, content: 'Done', partial: final },
    { type: 'done', reason: 'stop', message: final }
  ]
}

/**
 * Makes pi's `streamSimple` answer with the given events.
 *
 * @param script - the events, `start` to `done`
 */
function stubStream(script: AssistantMessageEvent[]): void {
  vi.spyOn(getRuntime(), 'streamSimple').mockImplementation(() => {
    const stream = createAssistantMessageEventStream()
    for (const event of script) stream.push(event)
    return stream
  })
}

/**
 * Sends a Responses request to the app with the API on.
 *
 * @param stream - whether to stream the answer
 * @returns the proxy's response
 */
function create(stream: boolean): Promise<Response> | Response {
  return testApp({ ...testConfig(), responsesApiEnabled: true }).request('/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, input: 'Why?', stream })
  })
}

/**
 * Parses a Responses stream into its events.
 *
 * @param text - the response text
 * @returns each event's JSON payload, in order
 */
function events(text: string): Record<string, unknown>[] {
  return text
    .split('\n\n')
    .map((frame) => frame.split('\n').find((line) => line.startsWith('data: ')))
    .filter((line): line is string => line !== undefined)
    .map((line): unknown => JSON.parse(line.slice('data: '.length)))
    .filter(isRecord)
}

describe.each(['anthropic', 'bedrock'] as const)('a redacted thinking block (%s)', (adapter) => {
  // Catches the stream sending pi's placeholder as the summary text (in the summary's `done`
  // events, or as a delta) while the finished item has no summary, so a streaming client shows
  // "[Reasoning redacted]" as reasoning that the item and the non-streamed answer leave out.
  test('streamed: no summary text, as the finished item has none', async () => {
    stubStream(redactedEvents(adapter))

    const response = await create(true)
    const text = await response.text()
    const streamed = events(text)

    expect(response.status).toBe(200)
    expect(text).not.toContain(PLACEHOLDER)
    for (const event of streamed) expect(violations('ResponseStreamEvent', event)).toEqual([])
    expect(
      streamed.filter((event) => event['type'] === 'response.reasoning_summary_text.delta')
    ).toEqual([])
    expect(
      streamed.find((event) => event['type'] === 'response.reasoning_summary_text.done')
    ).toMatchObject({ text: '' })
    expect(
      streamed.find((event) => event['type'] === 'response.reasoning_summary_part.done')
    ).toMatchObject({ part: { type: 'summary_text', text: '' } })
    expect(
      streamed.find(
        (event) => event['type'] === 'response.output_item.done' && event['output_index'] === 0
      )
    ).toMatchObject({ item: { type: 'reasoning', summary: [] } })
    expect(streamed.at(-1)).toMatchObject({
      type: 'response.completed',
      response: { output: [{ type: 'reasoning', summary: [] }, { type: 'message' }] }
    })
  })

  // Catches the non-streamed answer giving the redacted block a summary: the placeholder as text.
  test('non-streamed: the reasoning item has no summary', async () => {
    stubStream(redactedEvents(adapter))

    const response = await create(false)
    const answer = await jsonBody(response)

    expect(response.status).toBe(200)
    expect(violations('Response', answer)).toEqual([])
    expect(JSON.stringify(answer)).not.toContain(PLACEHOLDER)
    expect(answer).toMatchObject({
      output: [{ type: 'reasoning', summary: [] }, { type: 'message' }]
    })
  })
})
