/**
 * The stats store (#216): per-minute counts of the proxy's chat traffic in a SQLite file, kept
 * across restarts for the console's Stats view.
 *
 * @remarks
 * `node:sqlite` is built into Node 24 and into Bun, which compiles the standalone binary, so the
 * store needs no dependency. Three tables, each keyed by the minute (`floor(ms / 60 000)`):
 *
 * - `request_minutes`: finished chat requests by alias, model, outcome and (for a rejected one)
 *   status, with their total and longest duration and their total time to a stream's first event.
 * - `attempt_minutes`: upstream attempts by alias and served model, with failures, fallbacks,
 *   tokens and cost, as #70's route totals count them.
 * - `failure_minutes`: failed attempts by served model and failure class.
 *
 * Only routes, counts and timings are stored: never message content, the request's `user`, or a
 * credential. Writes come in batches ({@link StatsBatch}) from the recorder, one transaction each;
 * WAL mode lets the console read while a proxy writes, from the same process or another.
 *
 * @packageDocumentation
 */

import { DatabaseSync, type SQLOutputValue, type StatementSync } from 'node:sqlite'

/** The schema version, in SQLite's `user_version`. */
const SCHEMA_VERSION = 1
/**
 * How long a statement waits for another connection's lock, in milliseconds. `node:sqlite` waits
 * synchronously, on the thread that serves requests, so the wait is short: a write that can't get
 * the lock in time is dropped by the recorder rather than stalling every request in flight.
 */
const BUSY_TIMEOUT_MS = 250

/** The statements a store reuses, prepared once when it opens. */
interface Statements {
  readonly upsertRequest: StatementSync
  readonly upsertAttempt: StatementSync
  readonly upsertFailure: StatementSync
  /** One `DELETE … WHERE minute < ?` per table. */
  readonly prunes: readonly StatementSync[]
}

/** The schema, version {@link SCHEMA_VERSION}. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS request_minutes (
  minute INTEGER NOT NULL,
  alias TEXT NOT NULL,
  model TEXT NOT NULL,
  outcome TEXT NOT NULL,
  status INTEGER NOT NULL,
  requests INTEGER NOT NULL,
  duration_ms_total INTEGER NOT NULL,
  duration_ms_max INTEGER NOT NULL,
  first_event_ms_total INTEGER NOT NULL,
  first_event_count INTEGER NOT NULL,
  PRIMARY KEY (minute, alias, model, outcome, status)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS attempt_minutes (
  minute INTEGER NOT NULL,
  alias TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  failures INTEGER NOT NULL,
  fallbacks INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  PRIMARY KEY (minute, alias, model)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS failure_minutes (
  minute INTEGER NOT NULL,
  model TEXT NOT NULL,
  failure_class TEXT NOT NULL,
  failures INTEGER NOT NULL,
  PRIMARY KEY (minute, model, failure_class)
) WITHOUT ROWID;
`

/** Adds a batch row to `request_minutes`, or to the row already there. */
const UPSERT_REQUEST = `
INSERT INTO request_minutes (minute, alias, model, outcome, status, requests, duration_ms_total,
  duration_ms_max, first_event_ms_total, first_event_count)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (minute, alias, model, outcome, status) DO UPDATE SET
  requests = requests + excluded.requests,
  duration_ms_total = duration_ms_total + excluded.duration_ms_total,
  duration_ms_max = max(duration_ms_max, excluded.duration_ms_max),
  first_event_ms_total = first_event_ms_total + excluded.first_event_ms_total,
  first_event_count = first_event_count + excluded.first_event_count`

/** Adds a batch row to `attempt_minutes`, or to the row already there. */
const UPSERT_ATTEMPT = `
INSERT INTO attempt_minutes (minute, alias, provider, model, attempts, failures, fallbacks,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (minute, alias, model) DO UPDATE SET
  attempts = attempts + excluded.attempts,
  failures = failures + excluded.failures,
  fallbacks = fallbacks + excluded.fallbacks,
  input_tokens = input_tokens + excluded.input_tokens,
  output_tokens = output_tokens + excluded.output_tokens,
  cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
  cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
  cost_usd = cost_usd + excluded.cost_usd`

/** Adds a batch row to `failure_minutes`, or to the row already there. */
const UPSERT_FAILURE = `
INSERT INTO failure_minutes (minute, model, failure_class, failures) VALUES (?, ?, ?, ?)
ON CONFLICT (minute, model, failure_class) DO UPDATE SET failures = failures + excluded.failures`

/** One minute's finished requests on one route with one outcome. */
export interface RequestMinute {
  readonly minute: number
  /** The alias the requests named, or `''` for none. */
  readonly alias: string
  /** The served model, or for a rejected request the one it named (`''` when unread). */
  readonly model: string
  readonly outcome: string
  /** A rejected request's HTTP status; 0 for any other. */
  readonly status: number
  readonly requests: number
  readonly durationMsTotal: number
  readonly durationMsMax: number
  readonly firstEventMsTotal: number
  /** How many of the requests streamed and timed a first event. */
  readonly firstEventCount: number
}

/** One minute's upstream attempts on one route. */
export interface AttemptMinute {
  readonly minute: number
  /** The alias the attempts ran under, or `''` for none. */
  readonly alias: string
  readonly provider: string
  readonly model: string
  readonly attempts: number
  readonly failures: number
  readonly fallbacks: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly costUsd: number
}

/** One minute's failed attempts on one model with one failure class. */
export interface FailureMinute {
  readonly minute: number
  readonly model: string
  readonly failureClass: string
  readonly failures: number
}

/** What the recorder writes at once. */
export interface StatsBatch {
  readonly requests: readonly RequestMinute[]
  readonly attempts: readonly AttemptMinute[]
  readonly failures: readonly FailureMinute[]
}

/** A span of minutes: from `fromMinute`, up to but not including `toMinute`. */
export interface MinuteRange {
  readonly fromMinute: number
  readonly toMinute: number
}

/** One bucket of the timeline. */
export interface TimelineBucket {
  /** Its first minute. */
  readonly minute: number
  /** Finished requests, rejected ones included. */
  readonly requests: number
  readonly failed: number
  readonly rejected: number
}

/** One served model's numbers over a range. */
export interface ModelStats {
  readonly model: string
  /** Finished requests it served, not counting rejected ones. */
  readonly requests: number
  readonly failed: number
  readonly left: number
  /** Average time per request, in milliseconds; `undefined` with none. */
  readonly averageMs: number | undefined
  readonly slowestMs: number
  /** Average time to a stream's first event; `undefined` with no stream timed. */
  readonly averageFirstEventMs: number | undefined
  readonly attempts: number
  readonly fallbacks: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheTokens: number
  readonly costUsd: number
}

/** What went wrong over a range. */
export interface ErrorStats {
  /** Failed attempts by failure class, most first. */
  readonly failures: readonly { readonly failureClass: string; readonly count: number }[]
  /** Rejected requests by HTTP status, most first. */
  readonly rejected: readonly { readonly status: number; readonly count: number }[]
}

/** The stats store. */
export interface StatsStore {
  /**
   * Adds a batch to the counts, in one transaction.
   *
   * @param batch - the rows to add
   */
  add(batch: StatsBatch): void
  /**
   * Deletes every row from before a minute.
   *
   * @param beforeMinute - the first minute kept
   */
  prune(beforeMinute: number): void
  /**
   * Counts finished requests per bucket of minutes, with a bucket for every step in the range.
   *
   * @param range - the minutes
   * @param bucketMinutes - minutes per bucket, from 1
   * @returns the buckets, oldest first
   */
  timeline(range: MinuteRange, bucketMinutes: number): TimelineBucket[]
  /**
   * Adds up each served model's numbers.
   *
   * @param range - the minutes
   * @returns one entry per model, most requests first
   */
  models(range: MinuteRange): ModelStats[]
  /**
   * Adds up what went wrong.
   *
   * @param range - the minutes
   * @returns failures by class and rejected requests by status
   */
  errors(range: MinuteRange): ErrorStats
  /** Closes the file; a second call does nothing. */
  close(): void
}

/**
 * Reads a number column, `0` when it is null (an empty `sum`).
 *
 * @param row - the row
 * @param column - the column
 * @returns the number
 */
function numberOf(row: Readonly<Record<string, SQLOutputValue>>, column: string): number {
  const value = row[column]
  if (typeof value === 'number') return value
  return typeof value === 'bigint' ? Number(value) : 0
}

/**
 * Reads a text column, `''` when it is not text.
 *
 * @param row - the row
 * @param column - the column
 * @returns the text
 */
function textOf(row: Readonly<Record<string, SQLOutputValue>>, column: string): string {
  const value = row[column]
  return typeof value === 'string' ? value : ''
}

/**
 * Divides, or gives `undefined` for nothing to divide by.
 *
 * @param total - the total
 * @param count - how many it is over
 * @returns the average
 */
function averageOf(total: number, count: number): number | undefined {
  return count > 0 ? total / count : undefined
}

/**
 * Runs writes in one transaction, rolled back if one throws.
 *
 * @remarks
 * Some errors (a full disk, an I/O error) roll the transaction back themselves; a second `ROLLBACK`
 * would then throw "no transaction is active" in place of the error that says what went wrong.
 *
 * @param db - the database
 * @param writes - the writes
 */
function inTransaction(db: DatabaseSync, writes: () => void): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    writes()
    db.exec('COMMIT')
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw error
  }
}

/**
 * Writes a batch's rows.
 *
 * @param statements - the store's prepared upserts
 * @param batch - the rows
 */
function writeBatch(statements: Statements, batch: StatsBatch): void {
  for (const row of batch.requests) {
    statements.upsertRequest.run(
      row.minute,
      row.alias,
      row.model,
      row.outcome,
      row.status,
      row.requests,
      row.durationMsTotal,
      row.durationMsMax,
      row.firstEventMsTotal,
      row.firstEventCount
    )
  }
  for (const row of batch.attempts) {
    statements.upsertAttempt.run(
      row.minute,
      row.alias,
      row.provider,
      row.model,
      row.attempts,
      row.failures,
      row.fallbacks,
      row.inputTokens,
      row.outputTokens,
      row.cacheReadTokens,
      row.cacheWriteTokens,
      row.costUsd
    )
  }
  for (const row of batch.failures) {
    statements.upsertFailure.run(row.minute, row.model, row.failureClass, row.failures)
  }
}

/**
 * Counts finished requests per bucket, with empty buckets filled in.
 *
 * @param db - the database
 * @param range - the minutes
 * @param bucketMinutes - minutes per bucket
 * @returns the buckets, oldest first
 */
function timelineOf(db: DatabaseSync, range: MinuteRange, bucketMinutes: number): TimelineBucket[] {
  const step = Math.max(1, Math.floor(bucketMinutes))
  const rows = db
    .prepare(
      // node:sqlite binds a JS number as a REAL, which would make this a fractional division: the
      // casts keep it whole, so a minute lands in its bucket.
      `SELECT (minute - CAST(? AS INTEGER)) / CAST(? AS INTEGER) AS bucket,
        sum(requests) AS requests,
        sum(CASE outcome WHEN 'failed' THEN requests ELSE 0 END) AS failed,
        sum(CASE outcome WHEN 'rejected' THEN requests ELSE 0 END) AS rejected
      FROM request_minutes WHERE minute >= ? AND minute < ? GROUP BY bucket`
    )
    .all(range.fromMinute, step, range.fromMinute, range.toMinute)
  const byBucket = new Map(rows.map((row) => [numberOf(row, 'bucket'), row]))
  const count = Math.max(0, Math.ceil((range.toMinute - range.fromMinute) / step))
  return Array.from({ length: count }, (_, index) => {
    const row = byBucket.get(index)
    return {
      minute: range.fromMinute + index * step,
      requests: row === undefined ? 0 : numberOf(row, 'requests'),
      failed: row === undefined ? 0 : numberOf(row, 'failed'),
      rejected: row === undefined ? 0 : numberOf(row, 'rejected')
    }
  })
}

/**
 * Adds up each served model's requests and timings, then its attempts, tokens and cost.
 *
 * @param db - the database
 * @param range - the minutes
 * @returns one entry per model, most requests first
 */
function modelsOf(db: DatabaseSync, range: MinuteRange): ModelStats[] {
  const requests = db
    .prepare(
      `SELECT model, sum(requests) AS requests,
        sum(CASE outcome WHEN 'failed' THEN requests ELSE 0 END) AS failed,
        sum(CASE outcome WHEN 'left' THEN requests ELSE 0 END) AS left_count,
        sum(duration_ms_total) AS duration_total, max(duration_ms_max) AS duration_max,
        sum(first_event_ms_total) AS first_total, sum(first_event_count) AS first_count
      FROM request_minutes WHERE minute >= ? AND minute < ? AND outcome != 'rejected'
      GROUP BY model`
    )
    .all(range.fromMinute, range.toMinute)
  const attempts = db
    .prepare(
      `SELECT model, sum(attempts) AS attempts, sum(fallbacks) AS fallbacks,
        sum(input_tokens) AS input, sum(output_tokens) AS output,
        sum(cache_read_tokens) + sum(cache_write_tokens) AS cache, sum(cost_usd) AS cost
      FROM attempt_minutes WHERE minute >= ? AND minute < ? GROUP BY model`
    )
    .all(range.fromMinute, range.toMinute)
  const attemptsByModel = new Map(attempts.map((row) => [textOf(row, 'model'), row]))
  const models = new Set([...requests, ...attempts].map((row) => textOf(row, 'model')))
  const requestsByModel = new Map(requests.map((row) => [textOf(row, 'model'), row]))
  return [...models]
    .map((model) =>
      modelStats(model, requestsByModel.get(model) ?? {}, attemptsByModel.get(model) ?? {})
    )
    .toSorted(
      (left, right) => right.requests - left.requests || left.model.localeCompare(right.model)
    )
}

/**
 * Builds one model's numbers from its two query rows.
 *
 * @param model - the model
 * @param requests - its row of finished requests, or `{}` for none
 * @param attempts - its row of attempts, or `{}` for none
 * @returns the numbers
 */
function modelStats(
  model: string,
  requests: Readonly<Record<string, SQLOutputValue>>,
  attempts: Readonly<Record<string, SQLOutputValue>>
): ModelStats {
  const served = numberOf(requests, 'requests')
  return {
    model,
    requests: served,
    failed: numberOf(requests, 'failed'),
    left: numberOf(requests, 'left_count'),
    averageMs: averageOf(numberOf(requests, 'duration_total'), served),
    slowestMs: numberOf(requests, 'duration_max'),
    averageFirstEventMs: averageOf(
      numberOf(requests, 'first_total'),
      numberOf(requests, 'first_count')
    ),
    attempts: numberOf(attempts, 'attempts'),
    fallbacks: numberOf(attempts, 'fallbacks'),
    inputTokens: numberOf(attempts, 'input'),
    outputTokens: numberOf(attempts, 'output'),
    cacheTokens: numberOf(attempts, 'cache'),
    costUsd: numberOf(attempts, 'cost')
  }
}

/**
 * Adds up failures by class and rejected requests by status.
 *
 * @param db - the database
 * @param range - the minutes
 * @returns both, most first
 */
function errorsOf(db: DatabaseSync, range: MinuteRange): ErrorStats {
  const failures = db
    .prepare(
      `SELECT failure_class, sum(failures) AS count FROM failure_minutes
      WHERE minute >= ? AND minute < ? GROUP BY failure_class ORDER BY count DESC, failure_class`
    )
    .all(range.fromMinute, range.toMinute)
  const rejected = db
    .prepare(
      `SELECT status, sum(requests) AS count FROM request_minutes
      WHERE minute >= ? AND minute < ? AND outcome = 'rejected'
      GROUP BY status ORDER BY count DESC, status`
    )
    .all(range.fromMinute, range.toMinute)
  return {
    failures: failures.map((row) => ({
      failureClass: textOf(row, 'failure_class'),
      count: numberOf(row, 'count')
    })),
    rejected: rejected.map((row) => ({
      status: numberOf(row, 'status'),
      count: numberOf(row, 'count')
    }))
  }
}

/**
 * Opens the stats file, creating it and its tables the first time.
 *
 * @param path - the file, or `:memory:` for a store that lives as long as the process
 * @returns the store
 * @throws Error when the file can't be opened or created (a read-only directory, say), or it was
 *   written by a newer version of the proxy
 */
export function openStatsStore(path: string): StatsStore {
  const db = new DatabaseSync(path)
  try {
    db.exec(`PRAGMA busy_timeout = ${String(BUSY_TIMEOUT_MS)}`)
    db.exec('PRAGMA journal_mode = WAL')
    const version = numberOf(db.prepare('PRAGMA user_version').get() ?? {}, 'user_version')
    if (version > SCHEMA_VERSION) {
      throw new Error(
        `The stats file is schema version ${String(version)}, newer than this proxy's`
      )
    }
    db.exec(SCHEMA)
    db.exec(`PRAGMA user_version = ${String(SCHEMA_VERSION)}`)
  } catch (error) {
    db.close()
    throw error
  }
  const statements: Statements = {
    upsertRequest: db.prepare(UPSERT_REQUEST),
    upsertAttempt: db.prepare(UPSERT_ATTEMPT),
    upsertFailure: db.prepare(UPSERT_FAILURE),
    prunes: ['request_minutes', 'attempt_minutes', 'failure_minutes'].map((table) =>
      db.prepare(`DELETE FROM ${table} WHERE minute < ?`)
    )
  }
  let open = true
  return {
    add: (batch) => {
      inTransaction(db, () => {
        writeBatch(statements, batch)
      })
    },
    prune: (beforeMinute) => {
      inTransaction(db, () => {
        for (const prune of statements.prunes) prune.run(beforeMinute)
      })
    },
    timeline: (range, bucketMinutes) => timelineOf(db, range, bucketMinutes),
    models: (range) => modelsOf(db, range),
    errors: (range) => errorsOf(db, range),
    close: () => {
      if (!open) return
      open = false
      db.close()
    }
  }
}
