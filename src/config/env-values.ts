/**
 * Parsers for env var values, shared by the server config (`src/config/env.ts`) and the admin UI's
 * (`src/config/admin.ts`): an invalid value is warned about by name and ignored, never clamped
 * (constitution principle II).
 *
 * @packageDocumentation
 */

import { intBounds, parseIntText } from '@proxy/config/schema'
import { proxyLogger } from '@proxy/logging'
import type * as z from 'zod'

/** Logger for config resolution (`config` category). */
const configLogger = proxyLogger('config')

/**
 * Parses an integer env var against the config file's bounds for the same setting, warning and
 * using `fallback` when it is not one within them.
 *
 * @remarks
 * Warn and fall back, never clamp: an invalid env var is ignored (CONSTITUTION principle II),
 * where an invalid config-file value is repaired to the nearest bound.
 *
 * @param name - The env var's name, for the warning.
 * @param raw - The env var's value, or `undefined` when unset.
 * @param schema - The bounds, in the env var's unit.
 * @param fallback - The value to use when `raw` is unset or invalid.
 * @returns The parsed integer, or `fallback`.
 */
export function parseEnvInt(
  name: string,
  raw: string | undefined,
  schema: z.ZodInt,
  fallback: number
): number {
  if (raw === undefined) return fallback
  const parsed = parseIntText(raw, schema)
  if (parsed === undefined) {
    const { min, max } = intBounds(schema)
    configLogger.warn(
      'Ignoring {name}={value}: not an integer from {min} to {max}; using {fallback}',
      { name, value: raw, min, max, fallback }
    )
    return fallback
  }
  return parsed
}

/**
 * Parses a boolean env var: only `true` is true.
 *
 * @remarks
 * Any value other than `true` or `false` is warned about and treated as false, not as `fallback`.
 *
 * @param name - The env var's name, for the warning.
 * @param raw - The env var's value, or `undefined` when unset.
 * @param fallback - The value to use when `raw` is unset.
 * @returns `fallback` when unset, else whether `raw` is `true`.
 */
export function parseBoolean(name: string, raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback
  if (raw !== 'true' && raw !== 'false') {
    configLogger.warn('{name}={value} is not "true" or "false"; treating it as false', {
      name,
      value: raw
    })
  }
  return raw === 'true'
}
