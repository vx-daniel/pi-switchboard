/**
 * The two message fields pi has no equivalent for, `name` and `image_url.detail`, are accepted and
 * dropped, as constitution principle I lists them (#146), and the drop is logged at debug, by count.
 */

import { resetSync } from '@logtape/logtape'
import { configureLogging } from '@proxy/logging'
import { convertMessages } from '@proxy/openai/messages'
import { validateChatRequest } from '@proxy/openai/validate'
import { isRecord } from '@proxy/utils/guards'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vite-plus/test'

/** A participant name, which must never reach the log. */
const PARTICIPANT = 'notarealsecret-alice'

/** Every debug record of the drop: its properties. */
const dropRecords: unknown[] = []

beforeAll(() => {
  configureLogging({
    level: 'debug',
    format: 'json',
    write: (line) => {
      const parsed: unknown = JSON.parse(line)
      if (!isRecord(parsed) || typeof parsed['message'] !== 'string') return
      if (parsed['message'].startsWith('Dropped') && parsed['message'].includes('name(s)')) {
        dropRecords.push({ properties: parsed['properties'], line })
      }
    }
  })
})

beforeEach(() => {
  dropRecords.length = 0
})

afterAll(() => {
  resetSync()
})

/**
 * Validates and converts a conversation, as the chat route does.
 *
 * @param messages - the request's messages
 * @returns whether the conversion succeeded
 */
function convert(messages: unknown[]): boolean {
  const validation = validateChatRequest({ model: 'any/model', messages })
  if (!validation.ok) throw new Error(`request did not validate: ${validation.message}`)
  return convertMessages(validation.data.messages).ok
}

describe('message fields pi has no equivalent for', () => {
  // Catches the listed drop happening without a trace, or the participant's name reaching the log.
  test('name and image_url.detail are accepted, and their drop logged by count', () => {
    const converted = convert([
      { role: 'system', content: 'Rules.', name: PARTICIPANT },
      {
        role: 'user',
        name: PARTICIPANT,
        content: [
          { type: 'text', text: 'Look.' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==', detail: 'low' } }
        ]
      }
    ])

    expect(converted).toBe(true)
    expect(dropRecords).toEqual([
      expect.objectContaining({ properties: { nameCount: 2, detailCount: 1 } })
    ])
    expect(JSON.stringify(dropRecords)).not.toContain(PARTICIPANT)
  })

  // Catches a debug line on every request, whether or not anything was dropped.
  test('nothing is logged when neither is sent', () => {
    convert([{ role: 'user', content: 'Hi' }])

    expect(dropRecords).toEqual([])
  })
})
