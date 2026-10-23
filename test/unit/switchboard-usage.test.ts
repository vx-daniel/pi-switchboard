import { createUsageAnswer, type UsageStore } from '@proxy/server/usage'
import { describe, expect, test } from 'vite-plus/test'

/** A moment to read at, in milliseconds since the epoch. */
const NOW = Date.UTC(2026, 4, 10, 12)

/**
 * Builds a store with no traffic that counts its reads and closes.
 *
 * @param fail - whether its reads throw, as a damaged file's would
 * @returns the store and its counts
 */
function emptyStore(fail = false): {
  store: UsageStore
  reads: () => number
  closes: () => number
} {
  let reads = 0
  let closes = 0
  const store: UsageStore = {
    timeline: () => [],
    models: () => {
      reads += 1
      if (fail) throw new Error('database disk image is malformed')
      return []
    },
    aliases: () => [],
    errors: () => ({ failures: [], rejected: [] }),
    close: () => {
      closes += 1
    }
  }
  return { store, reads: () => reads, closes: () => closes }
}

describe('the usage answer', () => {
  // Catches a stats file that can't be opened answered with empty numbers, a 500, or never tried
  // again once it can be.
  test('a file that will not open is a 503, and is opened again on the next request', () => {
    const { store } = emptyStore()
    let opens = 0
    const answer = createUsageAnswer(true, () => {
      opens += 1
      if (opens === 1) throw new Error('database is locked')
      return store
    })

    expect(answer('today', NOW)).toMatchObject({
      status: 503,
      body: { error: { code: 'stats_unavailable' } }
    })
    expect(answer('today', NOW + 1).status).toBe(200)
    expect(opens).toBe(2)
  })

  // Catches a store that failed mid-read kept open (it would fail every request), or its close
  // throwing turning the 503 into a 500.
  test('a store whose read fails is closed and replaced', () => {
    const broken = emptyStore(true)
    broken.store.close = () => {
      throw new Error('close failed too')
    }
    const healthy = emptyStore()
    const stores = [broken.store, healthy.store]
    const answer = createUsageAnswer(true, () => stores.shift() ?? healthy.store)

    expect(answer('week', NOW).status).toBe(503)
    expect(answer('week', NOW + 1).status).toBe(200)
    expect(healthy.reads()).toBe(1)
  })

  // Catches a burst of requests each reading the file synchronously on the request thread, or a
  // stale answer kept past the recorder's next write.
  test('one window is read once per 5 seconds, another at once', () => {
    const { store, reads } = emptyStore()
    const answer = createUsageAnswer(true, () => store)

    answer('today', NOW)
    answer('today', NOW + 4999)
    expect(reads()).toBe(1)
    answer('all', NOW + 4999)
    expect(reads()).toBe(2)
    answer('today', NOW + 5000)
    expect(reads()).toBe(3)
  })

  // Catches a window without traffic answered with missing fields instead of empty lists.
  test('a window without traffic has empty lists and a full timeline', () => {
    const { store } = emptyStore()
    const answer = createUsageAnswer(true, () => ({
      ...store,
      timeline: (range, bucketMinutes) =>
        Array.from(
          { length: Math.ceil((range.toMinute - range.fromMinute) / bucketMinutes) },
          (_, bucketIndex) => ({
            minute: range.fromMinute + bucketIndex * bucketMinutes,
            requests: 0,
            failed: 0,
            rejected: 0
          })
        )
    }))

    const result = answer('all', NOW)

    expect(result).toMatchObject({
      status: 200,
      body: { models: [], aliases: [], failures: [], rejected: [], bucket_minutes: 1440 }
    })
    // All 30 days, by day.
    expect(result.status === 200 ? result.body.timeline.length : 0).toBe(30)
  })
})
