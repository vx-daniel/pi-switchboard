/**
 * An upstream call whose options fail to build: it throws before pi is called, and is logged as
 * the call's throw, with its text at debug, once (#339). The route logs no upstream failure's text,
 * so a throw `pi.complete` did not log would leave its text unlogged.
 */

import { resetSync } from '@logtape/logtape'
import { configureLogging } from '@proxy/logging'
import { piComplete } from '@proxy/pi/complete'
import { isRecord } from '@proxy/utils/guards'
import { afterAll, beforeEach, expect, test, vi } from 'vite-plus/test'

import { makeModel, parseChatBody } from '../helpers'

/** The thrown text: logged at debug only. */
const THROWN = 'notarealsecret-options-failed'

vi.mock('@proxy/pi/temperature', () => ({
  upstreamTemperature: () => {
    throw new Error(THROWN)
  }
}))

let records: { level: string; logger: string; message: string; line: string }[] = []

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

afterAll(() => {
  resetSync()
})

// Catches a throw while the call's options are built escaping unlogged: the route no longer logs
// an upstream failure's text, so `pi.complete` has to, once and at debug only.
test('logs a throw while building the call options as the call throwing, its text at debug', async () => {
  const request = parseChatBody({
    model: 'p/m',
    temperature: 0.5,
    messages: [{ role: 'user', content: 'Hi' }]
  })

  await expect(piComplete(makeModel('p', 'm'), { messages: [] }, request, {})).rejects.toThrow(
    THROWN
  )

  expect(records).toContainEqual(
    expect.objectContaining({
      logger: 'pi-switchboard.pi.complete',
      level: 'WARN',
      message: expect.stringContaining('threw after') as unknown
    })
  )
  expect(records.filter((record) => record.line.includes(THROWN))).toEqual([
    expect.objectContaining({
      logger: 'pi-switchboard.pi.complete',
      level: 'DEBUG',
      message: expect.stringContaining('Upstream error detail') as unknown
    })
  ])
})
