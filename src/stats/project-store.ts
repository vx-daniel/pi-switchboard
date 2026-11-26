/**
 * The stats file's projects (#366): per minute, each project's finished requests, failures,
 * tokens and cost, for `GET /v1/switchboard/usage`, the console and the budgets.
 *
 * @remarks
 * A project is the label a request sent in `X-Switchboard-Project`, read only with proxy auth on;
 * a request without one is in no project row. The recorder bounds how many distinct projects a
 * minute adds ({@link OTHER_PROJECT}), so a client can't grow the table without limit. Requests
 * come from the finished requests, tokens and cost from each upstream call, as for the routes.
 *
 * @packageDocumentation
 */

import type { DatabaseSync, StatementSync } from 'node:sqlite'

import type { Budgets } from '@proxy/config/projects'
import { numberOf, textOf } from '@proxy/stats/columns'
import type { StatsWindow } from '@proxy/stats/windows'

/** What requests past the recorder's cap of distinct projects a minute are filed under. */
export const OTHER_PROJECT = '(other)'

/** The projects table, as a new file gets it and as migration 2 → 3 adds it. */
export const PROJECT_TABLE = `
CREATE TABLE IF NOT EXISTS project_minutes (
  minute INTEGER NOT NULL,
  project TEXT NOT NULL,
  requests INTEGER NOT NULL,
  failed INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  PRIMARY KEY (minute, project)
) WITHOUT ROWID;
`

/** Adds a batch row to `project_minutes`, or to the row already there. */
export const UPSERT_PROJECT = `
INSERT INTO project_minutes (minute, project, requests, failed, input_tokens, output_tokens,
  cache_read_tokens, cache_write_tokens, cost_usd)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (minute, project) DO UPDATE SET
  requests = requests + excluded.requests,
  failed = failed + excluded.failed,
  input_tokens = input_tokens + excluded.input_tokens,
  output_tokens = output_tokens + excluded.output_tokens,
  cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
  cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
  cost_usd = cost_usd + excluded.cost_usd`

/** A project's tokens and cost. */
interface ProjectSpend {
  /** Uncached input tokens. */
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly costUsd: number
}

/** One minute of one project. */
export interface ProjectMinute extends ProjectSpend {
  readonly minute: number
  readonly project: string
  /** Finished requests that reached a model. */
  readonly requests: number
  /** Of those, how many failed. */
  readonly failed: number
}

/** One project's numbers over a range. */
export interface ProjectStats extends ProjectSpend {
  readonly project: string
  readonly requests: number
  readonly failed: number
}

/** One project's numbers over a window, with its budget for that window. */
export interface BudgetedProject extends ProjectStats {
  /** Its budget for the window (`budgets`), in US dollars; `null` without one. */
  readonly budgetUsd: number | null
}

/**
 * Puts each project's budget for the window beside its numbers, and lists a project with a
 * budget but no traffic in the window at zero, after the others, so its budget shows.
 *
 * @param projects - each project's numbers over the window, as {@link projectsOf} reads them
 * @param budgets - the budgets in the config file now
 * @param window - the window the numbers cover
 * @returns the projects with their budgets
 */
export function budgetedProjects(
  projects: readonly ProjectStats[],
  budgets: Budgets,
  window: StatsWindow
): BudgetedProject[] {
  const budgetOf = (project: string): number | null => budgets[project]?.[window] ?? null
  const used = new Set(projects.map((project) => project.project))
  const idle = Object.keys(budgets)
    .filter((project) => !used.has(project) && budgetOf(project) !== null)
    .toSorted()
    .map((project) => ({
      project,
      requests: 0,
      failed: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0
    }))
  return [...projects, ...idle].map((project) => ({
    ...project,
    budgetUsd: budgetOf(project.project)
  }))
}

/**
 * Writes a batch's project rows.
 *
 * @param upsert - the prepared statement
 * @param rows - the rows
 */
export function writeProjectRows(upsert: StatementSync, rows: readonly ProjectMinute[]): void {
  for (const row of rows) {
    upsert.run(
      row.minute,
      row.project,
      row.requests,
      row.failed,
      row.inputTokens,
      row.outputTokens,
      row.cacheReadTokens,
      row.cacheWriteTokens,
      row.costUsd
    )
  }
}

/**
 * Adds up each project's numbers over a range.
 *
 * @param db - the database
 * @param range - the minutes: from `fromMinute`, up to but not including `toMinute`
 * @param range.fromMinute - the first minute
 * @param range.toMinute - the minute after the last
 * @returns one entry per project, most spent first
 */
export function projectsOf(
  db: DatabaseSync,
  range: { readonly fromMinute: number; readonly toMinute: number }
): ProjectStats[] {
  return db
    .prepare(
      `SELECT project, sum(requests) AS requests, sum(failed) AS failed,
        sum(input_tokens) AS input, sum(output_tokens) AS output,
        sum(cache_read_tokens) AS cache_read, sum(cache_write_tokens) AS cache_write,
        sum(cost_usd) AS cost
      FROM project_minutes WHERE minute >= ? AND minute < ?
      GROUP BY project ORDER BY cost DESC, requests DESC, project`
    )
    .all(range.fromMinute, range.toMinute)
    .map((row) => ({
      project: textOf(row, 'project'),
      requests: numberOf(row, 'requests'),
      failed: numberOf(row, 'failed'),
      inputTokens: numberOf(row, 'input'),
      outputTokens: numberOf(row, 'output'),
      cacheReadTokens: numberOf(row, 'cache_read'),
      cacheWriteTokens: numberOf(row, 'cache_write'),
      costUsd: numberOf(row, 'cost')
    }))
}
