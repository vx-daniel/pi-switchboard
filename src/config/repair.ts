/**
 * The config's generic repairers: a list or a map that keeps the entries a schema accepts and
 * drops the rest, so one bad entry never costs the operator the whole field. Used by the config
 * schema (`src/config/schema.ts`) for its lists and maps, and by the sections it repairs.
 *
 * @packageDocumentation
 */

import { isRecord } from '@proxy/utils/guards'
import type * as z from 'zod'

/**
 * Returns a repairer that keeps the list entries `schema` accepts.
 *
 * @typeParam T - The entry type.
 * @param schema - The schema each entry must pass.
 * @returns The repairer: the valid entries, empty when the value is not an array.
 */
export function validList<T>(schema: z.ZodType<T>): (value: unknown) => T[] {
  return (value) => {
    if (!Array.isArray(value)) return []
    const result: T[] = []
    for (const candidate of value) {
      const parsed = schema.safeParse(candidate)
      if (parsed.success) result.push(parsed.data)
    }
    return result
  }
}

/**
 * Returns a repairer that keeps the map entries whose key `keys` accepts (any non-empty key by
 * default) and whose value `schema` accepts.
 *
 * @typeParam T - The value type.
 * @param schema - The schema each value must pass.
 * @param keys - The schema each key must pass; any non-empty string when not given.
 * @returns The repairer: the valid entries, empty when the value is not a plain object.
 */
export function validEntries<T>(
  schema: z.ZodType<T>,
  keys?: z.ZodType<string>
): (value: unknown) => Record<string, T> {
  return (value) => {
    if (!isRecord(value)) return {}
    const entries: Record<string, T> = {}
    for (const [key, candidate] of Object.entries(value)) {
      const parsed = schema.safeParse(candidate)
      const keyed = keys === undefined ? key.length > 0 : keys.safeParse(key).success
      if (keyed && parsed.success) entries[key] = parsed.data
    }
    return entries
  }
}
