import type { AssistantMessage, Context } from '@earendil-works/pi-ai'
import type { ReasoningToken } from '@proxy/openai/responses-api/reasoning-token'
import { withReplayedReasoning } from '@proxy/openai/responses-api/request'
import { describe, expect, test } from 'vite-plus/test'

/** A reasoning token from the `mock/thinker` model. */
const TOKEN: ReasoningToken = {
  provider: 'mock',
  api: 'openai-completions',
  model: 'thinker',
  thinking: { type: 'thinking', thinking: 'Hm.', thinkingSignature: 'reasoning_content' }
}

/**
 * Builds a history assistant message, as message conversion does.
 *
 * @param text - its text
 * @returns the message
 */
function assistant(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'proxy',
    model: 'history',
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

/** A conversation with one user message and one assistant reply. */
const CONTEXT: Context = {
  messages: [{ role: 'user', content: 'Why?', timestamp: 0 }, assistant('Because.')]
}

describe('replaying reasoning onto assistant turns', () => {
  // Catches reasoning placed on a turn without telling the model which produced it: pi replays a
  // thinking block only to a message of that same model.
  test("puts a turn's reasoning first, under the model that produced it", () => {
    const [, replayed] = withReplayedReasoning(CONTEXT, [[TOKEN]]).messages

    expect(replayed).toMatchObject({
      provider: 'mock',
      api: 'openai-completions',
      model: 'thinker',
      content: [TOKEN.thinking, { type: 'text', text: 'Because.' }]
    })
  })

  // Catches reasoning landing on another turn when the turns and the assistant messages don't line
  // up: the request fails (before anything is sent or streamed) instead.
  test('fails when the turns and the assistant messages do not line up', () => {
    expect(() => withReplayedReasoning(CONTEXT, [[TOKEN], [TOKEN]])).toThrow(
      'Reasoning for 2 assistant turns, but 1 assistant messages'
    )
  })
})
