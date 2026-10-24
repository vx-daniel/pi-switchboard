/**
 * The logging helpers beside `proxyLogger`: `resolveLogLevel`'s precedence (flag, env var,
 * fallback, an invalid value skipped) and `firstTimeInfoLog`'s per-key level (info once, then
 * debug). Their callers' tests see the lines; this pins the rules.
 */

import { resetSync } from '@logtape/logtape'
import { configureLogging, firstTimeInfoLog, proxyLogger, resolveLogLevel } from '@proxy/logging'
import { isRecord } from '@proxy/utils/guards'
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test'

let lines: string[] = []

/**
 * Reads the level and message of each JSON log line written so far.
 *
 * @returns `[level, message]` per line, in write order
 */
function written(): [unknown, unknown][] {
  return lines.map((line) => {
    const record: unknown = JSON.parse(line)
    return isRecord(record) ? [record['level'], record['message']] : [undefined, undefined]
  })
}

beforeEach(() => {
  lines = []
  configureLogging({ level: 'debug', format: 'json', write: (line) => lines.push(line) })
})

afterEach(() => {
  resetSync()
})

describe('resolveLogLevel', () => {
  // Catches the flag losing to the env var, an invalid value being used as a level, or the
  // fallback being skipped.
  test.each([
    ['the flag wins over the env var', 'error', 'debug', 'error'],
    ['an invalid flag is skipped for the env var', 'loud', 'debug', 'debug'],
    ['both invalid falls back', 'loud', 'quiet', 'info'],
    ['neither set falls back', undefined, undefined, 'info']
  ])('%s', (_label, flag, env, expected) => {
    expect(resolveLogLevel(flag, env, 'info')).toBe(expected)
  })
})

describe('firstTimeInfoLog', () => {
  // Catches the first line per key going out at debug (invisible at the default level), or every
  // line going out at info (one per request for a listed drop).
  test('info the first time per key, debug after, each key on its own', () => {
    const log = firstTimeInfoLog(proxyLogger('test'))

    log('a', 'Dropped for {key}', { key: 'a' })
    log('a', 'Dropped for {key}', { key: 'a' })
    log('b', 'Dropped for {key}', { key: 'b' })
    log('a', 'Dropped for {key}', { key: 'a' })

    expect(written()).toEqual([
      ['INFO', 'Dropped for "a"'],
      ['DEBUG', 'Dropped for "a"'],
      ['INFO', 'Dropped for "b"'],
      ['DEBUG', 'Dropped for "a"']
    ])
  })

  // Catches two helpers made from one logger sharing their seen keys.
  test('each helper remembers its own keys', () => {
    const logger = proxyLogger('test')
    const first = firstTimeInfoLog(logger)
    const second = firstTimeInfoLog(logger)

    first('a', 'first {key}', { key: 'a' })
    second('a', 'second {key}', { key: 'a' })

    expect(written().map(([level]) => level)).toEqual(['INFO', 'INFO'])
  })
})
