import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  type AttemptMinute,
  openStatsStore,
  type RequestMinute,
  type StatsStore
} from '@proxy/stats/store'
import { afterEach, describe, expect, test } from 'vite-plus/test'

/** Stores opened by a test, closed after it. */
const opened: StatsStore[] = []
/** Directories made by a test, removed after it. */
const directories: string[] = []

afterEach(() => {
  for (const store of opened.splice(0)) store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/**
 * Opens a store that lives in memory for one test.
 *
 * @returns the store
 */
function memoryStore(): StatsStore {
  const store = openStatsStore(':memory:')
  opened.push(store)
  return store
}

/**
 * Builds one minute's finished requests, zero except for the given fields.
 *
 * @param fields - the minute, route, outcome and any counts
 * @returns the row
 */
function requestRow(
  fields: Partial<RequestMinute> & Pick<RequestMinute, 'minute' | 'model'>
): RequestMinute {
  return {
    alias: '',
    outcome: 'ok',
    status: 0,
    requests: 1,
    durationMsTotal: 0,
    durationMsMax: 0,
    firstEventMsTotal: 0,
    firstEventCount: 0,
    ...fields
  }
}

/**
 * Builds one minute's attempts, zero except for the given fields.
 *
 * @param fields - the minute, route and any counts
 * @returns the row
 */
function attemptRow(
  fields: Partial<AttemptMinute> & Pick<AttemptMinute, 'minute' | 'model'>
): AttemptMinute {
  return {
    alias: '',
    provider: fields.model.split('/')[0] ?? '',
    attempts: 1,
    failures: 0,
    fallbacks: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    ...fields
  }
}

describe('the stats store', () => {
  // Catches a second batch for the same minute and route replacing the first instead of adding to
  // it, or the slowest time being summed instead of kept as the largest.
  test('adds batches for the same minute and route together', () => {
    const store = memoryStore()
    const row = requestRow({ minute: 10, model: 'a/m', durationMsTotal: 100, durationMsMax: 100 })
    store.add({ requests: [row], attempts: [], failures: [] })
    store.add({
      requests: [{ ...row, durationMsTotal: 300, durationMsMax: 300 }],
      attempts: [],
      failures: []
    })

    expect(store.models({ fromMinute: 0, toMinute: 60 })).toEqual([
      expect.objectContaining({ model: 'a/m', requests: 2, averageMs: 200, slowestMs: 300 })
    ])
  })

  // Catches a timeline with gaps where nothing happened (a chart would squash time), buckets on the
  // wrong minutes, or rows outside the range counted.
  test('counts requests per bucket, with empty buckets filled in', () => {
    const store = memoryStore()
    store.add({
      requests: [
        requestRow({ minute: 100, model: 'a/m', requests: 2 }),
        requestRow({ minute: 104, model: 'a/m', outcome: 'failed' }),
        requestRow({ minute: 111, model: '', outcome: 'rejected', status: 401, requests: 3 }),
        requestRow({ minute: 120, model: 'a/m', requests: 9 })
      ],
      attempts: [],
      failures: []
    })

    expect(store.timeline({ fromMinute: 100, toMinute: 120 }, 5)).toEqual([
      { minute: 100, requests: 3, failed: 1, rejected: 0 },
      { minute: 105, requests: 0, failed: 0, rejected: 0 },
      { minute: 110, requests: 3, failed: 0, rejected: 3 },
      { minute: 115, requests: 0, failed: 0, rejected: 0 }
    ])
  })

  // Catches a model's numbers mixing in rejected requests (which never reached it), averages taken
  // over the wrong count, or tokens and cost from its attempts left out or put on another model.
  test('adds up each model: requests, timings, tokens and cost', () => {
    const store = memoryStore()
    store.add({
      requests: [
        requestRow({
          minute: 1,
          model: 'a/fast',
          requests: 4,
          durationMsTotal: 2000,
          durationMsMax: 900,
          firstEventMsTotal: 600,
          firstEventCount: 3
        }),
        requestRow({ minute: 2, model: 'a/fast', outcome: 'left', durationMsTotal: 100 }),
        requestRow({ minute: 2, model: 'a/fast', outcome: 'rejected', status: 404, requests: 7 }),
        requestRow({ minute: 3, model: 'b/slow', outcome: 'failed', durationMsTotal: 5000 })
      ],
      attempts: [
        attemptRow({ minute: 1, model: 'a/fast', attempts: 5, inputTokens: 1000, costUsd: 0.5 }),
        attemptRow({
          minute: 2,
          model: 'a/fast',
          alias: 'coding',
          cacheReadTokens: 40,
          cacheWriteTokens: 15,
          costUsd: 0.25
        }),
        attemptRow({ minute: 3, model: 'b/slow', fallbacks: 1, outputTokens: 7 }),
        attemptRow({ minute: 3, model: 'c/refused', failures: 1 })
      ],
      failures: []
    })

    expect(store.models({ fromMinute: 0, toMinute: 10 })).toEqual([
      {
        model: 'a/fast',
        requests: 5,
        failed: 0,
        left: 1,
        averageMs: 420,
        slowestMs: 900,
        averageFirstEventMs: 200,
        attempts: 6,
        fallbacks: 0,
        inputTokens: 1000,
        outputTokens: 0,
        cacheReadTokens: 40,
        cacheWriteTokens: 15,
        costUsd: 0.75
      },
      expect.objectContaining({
        model: 'b/slow',
        requests: 1,
        failed: 1,
        fallbacks: 1,
        outputTokens: 7
      }),
      // Only attempted (every attempt failed and the chain moved on): no finished request of its own.
      expect.objectContaining({
        model: 'c/refused',
        requests: 0,
        averageMs: undefined,
        attempts: 1
      })
    ])
  })

  // Catches failures by class or rejections by status miscounted, or listed in no useful order.
  test('adds up failures by class and rejected requests by status, most first', () => {
    const store = memoryStore()
    store.add({
      requests: [
        requestRow({ minute: 1, model: '', outcome: 'rejected', status: 401 }),
        requestRow({ minute: 2, model: 'x/y', outcome: 'rejected', status: 404, requests: 3 })
      ],
      attempts: [],
      failures: [
        { minute: 1, model: 'a/m', failureClass: 'timeout', failures: 1 },
        { minute: 1, model: 'a/m', failureClass: 'rate_limit', failures: 2 },
        { minute: 2, model: 'b/m', failureClass: 'rate_limit', failures: 1 }
      ]
    })

    expect(store.errors({ fromMinute: 0, toMinute: 10 })).toEqual({
      failures: [
        { failureClass: 'rate_limit', count: 3 },
        { failureClass: 'timeout', count: 1 }
      ],
      rejected: [
        { status: 404, count: 3 },
        { status: 401, count: 1 }
      ]
    })
  })

  // Catches the retention deleting rows it should keep, or keeping old ones in any table.
  test('prunes every table before a minute, and keeps that minute', () => {
    const store = memoryStore()
    store.add({
      requests: [requestRow({ minute: 5, model: 'a/m' }), requestRow({ minute: 6, model: 'a/m' })],
      attempts: [attemptRow({ minute: 5, model: 'a/m' }), attemptRow({ minute: 6, model: 'a/m' })],
      failures: [
        { minute: 5, model: 'a/m', failureClass: 'timeout', failures: 1 },
        { minute: 6, model: 'a/m', failureClass: 'timeout', failures: 1 }
      ]
    })
    store.prune(6)

    expect(store.models({ fromMinute: 0, toMinute: 10 })).toEqual([
      expect.objectContaining({ requests: 1, attempts: 1 })
    ])
    expect(store.errors({ fromMinute: 0, toMinute: 10 }).failures).toEqual([
      { failureClass: 'timeout', count: 1 }
    ])
  })

  // Catches stats that don't survive a restart (the point of the file), or a file from a newer
  // proxy being written over instead of refused.
  test('keeps its counts across a reopen, and refuses a newer schema', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-switchboard-stats-'))
    directories.push(directory)
    const path = join(directory, 'stats.sqlite')
    const first = openStatsStore(path)
    first.add({ requests: [requestRow({ minute: 1, model: 'a/m' })], attempts: [], failures: [] })
    first.close()

    const second = openStatsStore(path)
    opened.push(second)
    expect(second.models({ fromMinute: 0, toMinute: 10 })).toEqual([
      expect.objectContaining({ model: 'a/m', requests: 1 })
    ])
    second.close()

    const newer = new DatabaseSync(path)
    newer.exec('PRAGMA user_version = 99')
    newer.close()
    expect(() => openStatsStore(path)).toThrow(/newer/)
  })

  // Catches a write that waits seconds for another connection's lock: node:sqlite waits on the
  // thread that serves requests, so a long wait would stall every request in flight.
  test('gives up a write quickly when another connection holds the lock', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-switchboard-stats-'))
    directories.push(directory)
    const path = join(directory, 'stats.sqlite')
    const store = openStatsStore(path)
    opened.push(store)
    const other = new DatabaseSync(path)
    other.exec('BEGIN IMMEDIATE')
    const started = performance.now()

    expect(() => {
      store.add({ requests: [requestRow({ minute: 1, model: 'a/m' })], attempts: [], failures: [] })
    }).toThrow(/locked|busy/i)
    expect(performance.now() - started).toBeLessThan(2000)
    other.exec('ROLLBACK')
    other.close()
  })
})
