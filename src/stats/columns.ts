/**
 * Reading the stats file's query rows: a number or a text column, with SQLite's empty results
 * (`null` from a `sum` over no rows) read as nothing.
 *
 * @packageDocumentation
 */

import type { SQLOutputValue } from 'node:sqlite'

/**
 * Reads a number column, `0` when it is null (an empty `sum`).
 *
 * @param row - the row
 * @param column - the column
 * @returns the number
 */
export function numberOf(row: Readonly<Record<string, SQLOutputValue>>, column: string): number {
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
export function textOf(row: Readonly<Record<string, SQLOutputValue>>, column: string): string {
  const value = row[column]
  return typeof value === 'string' ? value : ''
}
