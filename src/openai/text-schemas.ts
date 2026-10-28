/**
 * The one string schema for request text whose whitespace is data (#145).
 *
 * @remarks
 * Every other request string is `z.string().trim()`, as the `zod/prefer-string-schema-with-trim`
 * lint rule requires: identifiers such as `model`, tool names and IDs. That rule is off for this
 * file only (`vite.config.ts`, "Repo overrides"), because for text the model reads, trimming
 * changes the request: a `"\n"` stop sequence became `""`, and a message lost its leading
 * indentation and trailing newlines. Use {@link textSchema} for message content, text parts,
 * tool results, stop sequences, prediction content, and the `description` of a function tool or a
 * `json_schema` response format (#255): every provider hands those to the model, so they are text
 * it reads, not identifiers. The one other use is a reasoning token's thinking text and
 * signature (`responses-api/reasoning-token.ts`), which go back to the provider as they came.
 * Use it for nothing else.
 *
 * @packageDocumentation
 */

import * as z from 'zod'

/** Request text kept exactly as the client sent it, whitespace included. */
export const textSchema = z.string()
