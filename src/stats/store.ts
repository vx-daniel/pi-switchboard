/**
 * The stats store (#216): per-minute counts of the proxy's chat traffic in a SQLite file, kept
 * across restarts for the console's Stats view.
 *
 * @remarks
 * `node:sqlite` is built into Node 24 and into Bun, which compiles the standalone binary, so the
 * store needs no dependency. Three tables, each keyed by the minute (`floor(ms / 60 000)`):
 *
 * - `request_minutes`: finished chat requests by alias, model, outcome and (for a rejected one)
 *   status, with their total and longest duration, their total time to a stream's first event,
 *   and how many sent a `prompt_cache_key` (a count only, never the key: #299).
 * - `attempt_minutes`: upstream attempts by alias and served model, with failures, fallbacks,
 *   tokens and cost, as #70's route totals count them.
 * - `failure_minutes`: failed attempts by served model and failure class.
 *
 * Only routes, counts and timings are stored: never message content, the request's `user`, a
 * `prompt_cache_key`, or a credential. Writes come in batches ({@link StatsBatch}) from the
 * recorder, one transaction each; WAL mode lets the console read while a proxy writes, from the
 * same process or another.
 *
 * The schema version is SQLite's `user_version`. A new file gets the current schema; an older one
 * is migrated in place, keeping its rows ({@link MIGRATIONS}); a newer one is refused, since this
 * code cannot know what its columns mean. A read-only store (the doctor's, #299) migrates nothing,
 * so it refuses an older file too.
 *
 * @packageDocumentation
 */

import { existsSync } from 'node:fs'
import { DatabaseSync, type SQLOutputValue, type StatementSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

/**
 * The steps that bring an older stats file up to date, in order: the step at index `n` takes a
 * file from version `n + 1` to `n + 2`. A step only adds; existing rows keep their counts, and a
 * column it adds reads 0 on them.
 */
const MIGRATIONS: readonly string[] = [
  // 1 → 2 (#299): how many finished requests sent a `prompt_cache_key`.
  'ALTER TABLE request_minutes ADD COLUMN prompt_cache_key_requests INTEGER NOT NULL DEFAULT 0'
]
/** The schema version, in SQLite's `user_version`: 1, plus one per migration. */
const SCHEMA_VERSION = 1 + MIGRATIONS.length
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
  prompt_cache_key_requests INTEGER NOT NULL DEFAULT 0,
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
  duration_ms_max, first_event_ms_total, first_event_count, prompt_cache_key_requests)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (minute, alias, model, outcome, status) DO UPDATE SET
  requests = requests + excluded.requests,
  duration_ms_total = duration_ms_total + excluded.duration_ms_total,
  duration_ms_max = max(duration_ms_max, excluded.duration_ms_max),
  first_event_ms_total = first_event_ms_total + excluded.first_event_ms_total,
  first_event_count = first_event_count + excluded.first_event_count,
  prompt_cache_key_requests = prompt_cache_key_requests + excluded.prompt_cache_key_requests`

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
  /** How many of the requests sent a `prompt_cache_key`; never the key itself. */
  readonly promptCacheKeyRequests: number
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

/** Requests, timings, attempts, tokens and cost over a range, for one model or one alias. */
export interface UsageStats {
  /** Finished requests, not counting rejected ones. */
  readonly requests: number
  /** How many of {@link UsageStats.requests} sent a `prompt_cache_key`. */
  readonly promptCacheKeyRequests: number
  readonly failed: number
  readonly left: number
  /** Average time per request, in milliseconds; `undefined` with none. */
  readonly averageMs: number | undefined
  readonly slowestMs: number
  /** Average time to a stream's first event; `undefined` with no stream timed. */
  readonly averageFirstEventMs: number | undefined
  readonly attempts: number
  readonly fallbacks: number
  /** Uncached input tokens: the prompt is these plus the cache reads and writes. */
  readonly inputTokens: number
  readonly outputTokens: number
  /** Input tokens read from the provider's prompt cache. */
  readonly cacheReadTokens: number
  /** Input tokens written to the provider's prompt cache. */
  readonly cacheWriteTokens: number
  /**
   * The cache writes made in minutes where a route (alias and model) wrote more than it read:
   * `docs/caching.md`'s `cold_pct` is these over {@link UsageStats.cacheWriteTokens}, a rough
   * share of writes that re-wrote an expired cache or a changed prefix.
   */
  readonly coldCacheWriteTokens: number
  readonly costUsd: number
}

/** One served model's numbers over a range. */
export interface ModelStats extends UsageStats {
  readonly model: string
}

/** One alias's numbers over a range: every model that served it, fallbacks included. */
export interface AliasStats extends UsageStats {
  /** The alias the requests named; '' for requests that named a model directly. */
  readonly alias: string
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
   * Adds up each alias's numbers, with requests that named a model directly under ''.
   *
   * @param range - the minutes
   * @returns one entry per alias, most requests first
   */
  aliases(range: MinuteRange): AliasStats[]
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
      row.firstEventCount,
      row.promptCacheKeyRequests
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
 * Adds up requests and timings, then attempts, tokens and cost, grouped by served model or by
 * alias.
 *
 * @remarks
 * `column` is one of two fixed names, never input, so it is written into the SQL; both tables
 * have both columns. By alias, a request counts once under the alias it named, and its attempts
 * count under that alias whichever model in a fallback chain made them.
 *
 * @param db - the database
 * @param range - the minutes
 * @param column - what to group by
 * @returns each model or alias with its numbers, most requests first
 */
function usageBy(
  db: DatabaseSync,
  range: MinuteRange,
  column: 'model' | 'alias'
): [string, UsageStats][] {
  const requests = db
    .prepare(
      `SELECT ${column} AS name, sum(requests) AS requests,
        sum(prompt_cache_key_requests) AS keyed,
        sum(CASE outcome WHEN 'failed' THEN requests ELSE 0 END) AS failed,
        sum(CASE outcome WHEN 'left' THEN requests ELSE 0 END) AS left_count,
        sum(duration_ms_total) AS duration_total, max(duration_ms_max) AS duration_max,
        sum(first_event_ms_total) AS first_total, sum(first_event_count) AS first_count
      FROM request_minutes WHERE minute >= ? AND minute < ? AND outcome != 'rejected'
      GROUP BY ${column}`
    )
    .all(range.fromMinute, range.toMinute)
  const attempts = db
    .prepare(
      `SELECT ${column} AS name, sum(attempts) AS attempts, sum(fallbacks) AS fallbacks,
        sum(input_tokens) AS input, sum(output_tokens) AS output,
        sum(cache_read_tokens) AS cache_read, sum(cache_write_tokens) AS cache_write,
        sum(CASE WHEN cache_write_tokens > cache_read_tokens THEN cache_write_tokens ELSE 0 END)
          AS cold_write,
        sum(cost_usd) AS cost
      FROM attempt_minutes WHERE minute >= ? AND minute < ? GROUP BY ${column}`
    )
    .all(range.fromMinute, range.toMinute)
  const attemptsByName = new Map(attempts.map((row) => [textOf(row, 'name'), row]))
  const requestsByName = new Map(requests.map((row) => [textOf(row, 'name'), row]))
  const groups = new Set([...requestsByName.keys(), ...attemptsByName.keys()])
  return [...groups]
    .map((group): [string, UsageStats] => [
      group,
      usageStats(requestsByName.get(group) ?? {}, attemptsByName.get(group) ?? {})
    ])
    .toSorted(
      ([leftName, left], [rightName, right]) =>
        right.requests - left.requests || leftName.localeCompare(rightName)
    )
}

/**
 * Builds one model's or alias's numbers from its two query rows.
 *
 * @param requests - its row of finished requests, or `{}` for none
 * @param attempts - its row of attempts, or `{}` for none
 * @returns the numbers
 */
function usageStats(
  requests: Readonly<Record<string, SQLOutputValue>>,
  attempts: Readonly<Record<string, SQLOutputValue>>
): UsageStats {
  const served = numberOf(requests, 'requests')
  return {
    requests: served,
    promptCacheKeyRequests: numberOf(requests, 'keyed'),
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
    cacheReadTokens: numberOf(attempts, 'cache_read'),
    cacheWriteTokens: numberOf(attempts, 'cache_write'),
    coldCacheWriteTokens: numberOf(attempts, 'cold_write'),
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

/** How a store opens its file. */
export interface OpenStatsOptions {
  /**
   * Open the file read-only: no table is created, nothing migrated, nothing written, and a file
   * that is not at the current schema version is refused. `add` and `prune` then throw.
   */
  readonly readOnly?: boolean
}

/**
 * Names the file for a read-only connection.
 *
 * @remarks
 * A file a proxy has open has its `-wal` and `-shm` files beside it, which a reader shares. With
 * no `-wal` file (no proxy has it open, and the last one checkpointed it), a read-only connection
 * would still create both and leave them behind; opened `immutable`, it creates nothing. A proxy
 * that starts between the check and the open can write pages the `immutable` reader doesn't see:
 * the doctor's read is then a moment stale, which is fine for advice.
 *
 * @param path - the file
 * @returns the path, or an `immutable` file URL
 */
function readOnlyLocation(path: string): string | URL {
  if (existsSync(`${path}-wal`)) return path
  const url = pathToFileURL(path)
  url.searchParams.set('immutable', '1')
  return url
}

/**
 * Reads a file's schema version.
 *
 * @param db - the database
 * @returns its `user_version`; 0 for a new file
 */
function userVersion(db: DatabaseSync): number {
  return numberOf(db.prepare('PRAGMA user_version').get() ?? {}, 'user_version')
}

/**
 * Brings a file opened for writing to the current schema, in one transaction: the tables for a new
 * file, or the {@link MIGRATIONS} an older one has not had yet.
 *
 * @remarks
 * The version is read again inside the transaction, which holds the write lock: two proxies that
 * start on the same older file both saw that version before either locked it, and the second
 * would otherwise run a migration the first has already committed (`duplicate column`) and lose
 * its stats.
 *
 * @param db - the database
 * @param version - the file's `user_version` when it was opened; 0 for a new file
 */
function migrate(db: DatabaseSync, version: number): void {
  if (version === SCHEMA_VERSION) return
  inTransaction(db, () => {
    const current = userVersion(db)
    if (current >= SCHEMA_VERSION) return
    if (current === 0) db.exec(SCHEMA)
    else for (const step of MIGRATIONS.slice(current - 1)) db.exec(step)
    db.exec(`PRAGMA user_version = ${String(SCHEMA_VERSION)}`)
  })
}

/**
 * Checks a file's schema version, and brings a writable one up to date.
 *
 * @param db - the database, just opened
 * @param readOnly - whether it was opened read-only
 * @throws Error when the file is newer than this code's schema, or older and read-only
 */
function prepareSchema(db: DatabaseSync, readOnly: boolean): void {
  db.exec(`PRAGMA busy_timeout = ${String(BUSY_TIMEOUT_MS)}`)
  const version = userVersion(db)
  if (version > SCHEMA_VERSION) {
    throw new Error(
      `The stats file is schema version ${String(version)}, newer than this pi-switchboard's ` +
        `(${String(SCHEMA_VERSION)}): upgrade pi-switchboard to use it`
    )
  }
  if (readOnly) {
    if (version < SCHEMA_VERSION) {
      throw new Error(
        `The stats file is schema version ${String(version)}, older than this pi-switchboard's ` +
          `(${String(SCHEMA_VERSION)}): start the proxy once to migrate it`
      )
    }
    return
  }
  db.exec('PRAGMA journal_mode = WAL')
  migrate(db, version)
}

/**
 * Opens the stats file, creating it and its tables the first time, and migrating an older one in
 * place.
 *
 * @param path - the file, or `:memory:` for a store that lives until it closes
 * @param options - whether to open it read-only
 * @returns the store
 * @throws Error when the file can't be opened or created (a read-only directory, say), was
 *   written by a newer version of the proxy, or (read-only) by an older one
 */
export function openStatsStore(path: string, options: OpenStatsOptions = {}): StatsStore {
  const readOnly = options.readOnly === true
  const db = new DatabaseSync(readOnly ? readOnlyLocation(path) : path, { readOnly })
  try {
    prepareSchema(db, readOnly)
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
    models: (range) => usageBy(db, range, 'model').map(([model, usage]) => ({ model, ...usage })),
    aliases: (range) => usageBy(db, range, 'alias').map(([alias, usage]) => ({ alias, ...usage })),
    errors: (range) => errorsOf(db, range),
    close: () => {
      if (!open) return
      open = false
      db.close()
    }
  }
}
