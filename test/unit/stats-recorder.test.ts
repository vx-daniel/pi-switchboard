import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { Usage } from '@earendil-works/pi-ai'
import { beginActiveRequest, recordRejectedRequest } from '@proxy/server/active-requests'
import {
  recordRouteAttempt,
  recordRouteFailure,
  recordRouteFallback,
  recordRouteUsage
} from '@proxy/server/route-totals'
import { recordStatsToFile, startStatsRecorder } from '@proxy/stats/recorder'
import { openStatsStore, type StatsBatch, type StatsStore } from '@proxy/stats/store'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

/** The clock the recorder runs on: minute 1000 and a bit. */
const NOW = 1000 * 60_000 + 5000
/** Wide enough for every row the tests write. */
const ALL = { fromMinute: 0, toMinute: 10_000 }

/** Directories made by a test, removed after it. */
const directories: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/**
 * Builds one upstream call's usage.
 *
 * @param input - uncached input tokens
 * @param cost - its cost in US dollars
 * @returns the usage, as pi reports it
 */
function usage(input: number, cost: number): Usage {
  return {
    input,
    output: 10,
    cacheRead: 5,
    cacheWrite: 0,
    totalTokens: input + 15,
    cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost }
  }
}

describe('the stats recorder', () => {
  // Catches events lost between the proxy and the file: an attempt, a failure and its class, a
  // fallback, an upstream call's tokens and cost, a finished request's timings, and a rejected
  // request, all landing on the right minute and model once the recorder stops.
  test('writes route events and finished requests, by minute, when it stops', () => {
    const store = openStatsStore(':memory:')
    const reads = { models: store.models, errors: store.errors, timeline: store.timeline }
    // Closing is the recorder's job; keep the store readable after it.
    const stop = startStatsRecorder({ ...store, close: () => undefined }, { now: () => NOW })
    const key = { alias: 'coding', provider: 'alpha', model: 'alpha/one' }
    recordRouteAttempt(key)
    recordRouteFailure(key, 'rate_limit')
    recordRouteFallback(key)
    const next = { alias: 'coding', provider: 'beta', model: 'beta/two' }
    recordRouteAttempt(next)
    recordRouteUsage(next, usage(100, 0.5))
    const request = beginActiveRequest(
      { requestId: 'r1', alias: 'coding', model: 'alpha/one', stream: true },
      NOW - 2000
    )
    request.attempt('beta/two', 2)
    request.streaming(NOW - 1500)
    request.end('ok', NOW)
    recordRejectedRequest({ requestId: 'r2', model: undefined, status: 401, startedAt: NOW }, NOW)
    stop()

    expect(reads.models(ALL)).toEqual([
      expect.objectContaining({
        model: 'beta/two',
        requests: 1,
        averageMs: 2000,
        averageFirstEventMs: 500,
        attempts: 1,
        inputTokens: 100,
        cacheTokens: 5,
        costUsd: 0.5
      }),
      expect.objectContaining({ model: 'alpha/one', requests: 0, attempts: 1, fallbacks: 1 })
    ])
    expect(reads.errors(ALL)).toEqual({
      failures: [{ failureClass: 'rate_limit', count: 1 }],
      rejected: [{ status: 401, count: 1 }]
    })
    expect(reads.timeline({ fromMinute: 1000, toMinute: 1001 }, 1)).toEqual([
      { minute: 1000, requests: 2, failed: 0, rejected: 1 }
    ])
    store.close()
  })

  // Catches a store that fails a write failing the request that caused it, stopping the recorder
  // for good, or the batch being kept and written twice later.
  test('drops a batch the store refuses, and keeps recording on the next flush', () => {
    vi.useFakeTimers()
    const store = openStatsStore(':memory:')
    let refuse = true
    const flaky: StatsStore = {
      ...store,
      add: (batch: StatsBatch) => {
        if (refuse) throw new Error('disk full')
        store.add(batch)
      },
      close: () => undefined
    }
    const stop = startStatsRecorder(flaky, { now: () => NOW, flushMs: 1000 })
    recordRouteAttempt({ alias: null, provider: 'alpha', model: 'alpha/dropped' })
    vi.advanceTimersByTime(1000)
    refuse = false
    recordRouteAttempt({ alias: null, provider: 'alpha', model: 'alpha/kept' })
    vi.advanceTimersByTime(1000)

    // Written by the timer, before the stop.
    expect(store.models(ALL).map((model) => model.model)).toEqual(['alpha/kept'])
    stop()
    vi.useRealTimers()
    store.close()
  })

  // Catches a client flooding the file through rejected requests: any string it sends as the model
  // used to be kept whole, one row per distinct name per minute.
  test('cuts long rejected model names and files names past the limit as (other)', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-switchboard-stats-'))
    directories.push(directory)
    const path = join(directory, 'stats.sqlite')
    const stop = startStatsRecorder(openStatsStore(path), { now: () => NOW })
    const rejected = (requestId: string, model: string): void => {
      recordRejectedRequest({ requestId, model, status: 404, startedAt: NOW }, NOW)
    }
    rejected('long', 'x'.repeat(5000))
    for (let nameIndex = 0; nameIndex < 30; nameIndex += 1) {
      rejected(`r${String(nameIndex)}`, `junk/${String(nameIndex)}`)
    }
    stop()

    const db = new DatabaseSync(path)
    const rows = db
      .prepare("SELECT model, requests FROM request_minutes WHERE outcome = 'rejected'")
      .all()
    db.close()
    const models = rows.map((row) => String(row['model']))
    // 20 names kept (the long one cut to 128), and the other 11 requests under one row.
    expect(models).toHaveLength(21)
    expect(models.every((model) => model.length <= 128)).toBe(true)
    expect(rows.find((row) => row['model'] === '(other)')?.['requests']).toBe(11)
  })

  // Catches the retention never running, so the file grows for ever, or running on the wrong
  // side and deleting the rows it should keep.
  test('prunes rows past the retention when it starts', () => {
    const store = openStatsStore(':memory:')
    const keep = { ...store, close: () => undefined }
    const row = (minute: number): StatsBatch => ({
      requests: [],
      attempts: [
        {
          minute,
          alias: '',
          provider: 'alpha',
          model: `alpha/${String(minute)}`,
          attempts: 1,
          failures: 0,
          fallbacks: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0
        }
      ],
      failures: []
    })
    // One day of retention, at minute 5000: minute 5000 - 1440 is the first kept.
    store.add(row(5000 - 1441))
    store.add(row(5000 - 1440))
    startStatsRecorder(keep, { now: () => 5000 * 60_000, retentionDays: 1 })()

    expect(store.models(ALL).map((model) => model.model)).toEqual([`alpha/${String(5000 - 1440)}`])
    store.close()
  })

  // Catches an agent dir the proxy can't write to stopping the proxy, instead of running it
  // without stats.
  test('runs without stats when the file cannot be opened', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-switchboard-stats-'))
    directories.push(directory)
    const notADirectory = join(directory, 'file')
    writeFileSync(notADirectory, '')
    vi.stubEnv('PI_CODING_AGENT_DIR', join(notADirectory, 'agent'))

    expect(recordStatsToFile()).toBeUndefined()
  })
})
