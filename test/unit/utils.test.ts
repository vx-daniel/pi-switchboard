/**
 * The shared helpers in `src/utils/`: what each reads, and what it refuses. Their callers test the
 * behaviour they build; this pins the helpers' own edges, so a change to one is caught here first.
 */

import { errorMessage, parseJsonOrUndefined } from '@proxy/utils/guards'
import { parsePlainNumber } from '@proxy/utils/numbers'
import { MS_PER_SECOND, unixSecondsNow } from '@proxy/utils/time'
import { describe, expect, test, vi } from 'vite-plus/test'

const FIXED_NOW_MS = 1_700_000_000_999
const FIXED_NOW_SECONDS = 1_700_000_000

describe('errorMessage', () => {
  // Catches a thrown non-Error (a string, an object) logged as `[object Object]` or crashing the
  // log line, and an Error's message being lost.
  test.each([
    ['an Error', new Error('disk full'), 'disk full'],
    ['a string', 'plain text', 'plain text'],
    ['a number', 42, '42'],
    ['undefined', undefined, 'undefined']
  ])('%s: its text', (_label, thrown, expected) => {
    expect(errorMessage(thrown)).toBe(expected)
  })
})

describe('parseJsonOrUndefined', () => {
  // Catches a body that is not JSON throwing out of a caller that only wanted to look, and a
  // valid `null` or `false` being mistaken for "not JSON".
  test.each([
    ['an object', '{"error":{"code":429}}', { error: { code: 429 } }],
    ['null', 'null', null],
    ['false', 'false', false],
    ['a number', '12', 12]
  ])('%s parses', (_label, text, expected) => {
    expect(parseJsonOrUndefined(text)).toEqual(expected)
  })

  test.each([
    ['truncated', '{"authToken": "notarealsecret-fi'],
    ['empty', ''],
    ['prose', 'Too Many Requests']
  ])('%s is undefined', (_label, text) => {
    expect(parseJsonOrUndefined(text)).toBeUndefined()
  })
})

describe('parsePlainNumber', () => {
  // Catches `parseFloat` leniency (`12abc` as 12) and `Number` forms (hex, exponent, Infinity)
  // being read from a header that only ever writes a plain number.
  test.each([
    ['an integer', '30', 30],
    ['a fraction', '0.5', 0.5],
    ['surrounded by whitespace', ' 7 ', 7]
  ])('%s reads', (_label, text, expected) => {
    expect(parsePlainNumber(text)).toBe(expected)
  })

  test.each([
    ['digits then letters', '12abc'],
    ['a negative', '-1'],
    ['hex', '0x10'],
    ['an exponent', '1e3'],
    ['Infinity', 'Infinity'],
    ['empty', '']
  ])('%s is undefined', (_label, text) => {
    expect(parsePlainNumber(text)).toBeUndefined()
  })
})

describe('unixSecondsNow', () => {
  // Catches the clock being read in milliseconds, or rounded up: OpenAI's `created` is whole
  // seconds, rounded down.
  test('is Date.now() in whole seconds, rounded down', () => {
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW_MS)

    expect(unixSecondsNow()).toBe(FIXED_NOW_SECONDS)
    expect(unixSecondsNow() * MS_PER_SECOND).toBeLessThanOrEqual(FIXED_NOW_MS)

    vi.restoreAllMocks()
  })
})
