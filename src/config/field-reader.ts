/**
 * The shape of the function that reads one field of a config section, shared by the config schema
 * (`src/config/schema.ts`, which makes them) and the sections it repairs with them
 * (`src/config/admin-schema.ts`). A module of its own, so neither imports the other's.
 *
 * @packageDocumentation
 */

import type * as z from 'zod'

/** Reads one field: its value when the schema accepts it, otherwise `repair(value)`. */
export type FieldReader<Key extends string> = <T>(
  key: Key,
  schema: z.ZodType<T>,
  repair: (value: unknown) => T
) => T

/**
 * Makes the field reader for one object in the config, recording the paths of the fields it
 * repairs in `corrected` (`schema.ts`'s `fieldReader`).
 */
export type FieldReaderFactory = <Key extends string>(
  raw: unknown,
  corrected: string[],
  scope?: string
) => FieldReader<Key>
