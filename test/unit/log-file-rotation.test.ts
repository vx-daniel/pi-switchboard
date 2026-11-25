/**
 * The console's log file sink (src/logging/rotating-file.ts, #389): bounded on disk, owner-only,
 * and never fatal to the proxy.
 */

import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { LogRecord } from '@logtape/logtape'
import { rotatingFileSink } from '@proxy/logging/rotating-file'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

/** Owner read and write only. */
const OWNER_ONLY = 0o600

let directory = ''

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'pi-switchboard-log-file-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

/**
 * Makes a log record carrying a sequence number.
 *
 * @param sequence - the number, in the message and the properties
 * @returns the record
 */
function recordNumbered(sequence: number): LogRecord {
  return {
    category: ['pi-switchboard', 'server', 'http'],
    level: 'info',
    message: ['Request ', sequence],
    rawMessage: 'Request {sequence}',
    properties: { sequence },
    timestamp: Date.now()
  }
}

/**
 * Reads the sequence numbers a log file holds, in file order.
 *
 * @param path - the file
 * @returns its records' numbers
 */
function sequences(path: string): number[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => {
      const parsed: unknown = JSON.parse(line)
      const properties: unknown =
        typeof parsed === 'object' && parsed !== null && 'properties' in parsed
          ? parsed.properties
          : undefined
      return typeof properties === 'object' && properties !== null && 'sequence' in properties
        ? Number(properties.sequence)
        : Number.NaN
    })
}

describe('rotatingFileSink', () => {
  // Catches a proxy that runs for weeks filling the disk: a missed rollover, or one that keeps
  // every old file instead of only the last.
  test('keeps the file and one previous file, each under the cap, losing only the oldest lines', () => {
    const path = join(directory, 'pi-switchboard.log')
    const maxBytes = 2000
    const sink = rotatingFileSink(path, maxBytes, () => {})
    const written = 200
    for (let sequence = 0; sequence < written; sequence += 1) sink(recordNumbered(sequence))
    sink[Symbol.dispose]()

    expect(readdirSync(directory).toSorted()).toEqual([
      'pi-switchboard.log',
      'pi-switchboard.log.1'
    ])
    expect(statSync(path).size).toBeLessThanOrEqual(maxBytes)
    expect(statSync(`${path}.1`).size).toBeLessThanOrEqual(maxBytes)
    // The two files hold the newest records, without a gap between them.
    const kept = [...sequences(`${path}.1`), ...sequences(path)]
    expect(kept.at(-1)).toBe(written - 1)
    expect(kept).toEqual(kept.map((_, index) => (kept[0] ?? 0) + index))
  })

  // Catches the log (models, logins, projects) readable by other users: a file someone created
  // wider, or the new file a rollover opens with the process's umask.
  test('makes the file owner-only, whether it was there before or a rollover started it', () => {
    const path = join(directory, 'pi-switchboard.log')
    writeFileSync(path, '{"earlier":true}\n')
    chmodSync(path, 0o644)
    const sink = rotatingFileSink(path, 600, () => {})
    sink(recordNumbered(1))
    expect(statSync(path).mode & 0o777).toBe(OWNER_ONLY)
    expect(readFileSync(path, 'utf8')).toMatch(/^\{"earlier":true\}\n/)

    for (let sequence = 2; sequence < 20; sequence += 1) sink(recordNumbered(sequence))
    sink[Symbol.dispose]()
    expect(statSync(`${path}.1`).mode & 0o777).toBe(OWNER_ONLY)
    expect(statSync(path).mode & 0o777).toBe(OWNER_ONLY)
  })

  // Catches a log file that can't be written taking the console down with it, or reporting the
  // same failure on every record.
  test('a file that cannot be opened is reported once and the sink goes quiet', () => {
    const onFailure = vi.fn()
    const sink = rotatingFileSink(join(directory, 'missing', 'pi-switchboard.log'), 1000, onFailure)

    for (let sequence = 0; sequence < 3; sequence += 1) sink(recordNumbered(sequence))

    expect(onFailure).toHaveBeenCalledOnce()
    expect(onFailure.mock.calls[0]?.[0]).toMatchObject({ code: 'ENOENT' })
  })
})
