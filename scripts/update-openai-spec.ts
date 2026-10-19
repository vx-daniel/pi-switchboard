/**
 * Vendors the part of OpenAI's published OpenAPI spec that the stable surface is checked against
 * (#132): `test/integration/openai-spec.test.ts` validates the proxy's real responses, and the
 * fields and enums its request schema accepts, against it.
 *
 * USAGE: `pnpm run openai-spec:update <commit>`, with a full 40-character commit SHA of
 * [`openai/openai-openapi`](https://github.com/openai/openai-openapi). The spec changes almost
 * daily, so it is pinned: tests never fetch it, and moving the pin is a deliberate change that
 * shows up in review as a diff of the subset file.
 *
 * OUTPUT: `test/fixtures/openai-spec/openapi-subset.json`, holding {@link ROOT_SCHEMAS} and every
 * schema they reference, descriptions included, under `components.schemas`; `x-source` records
 * the commit. The file is formatted with `vp fmt` after writing, so the gate's format check
 * passes.
 *
 * Runs under Node directly (`node scripts/update-openai-spec.ts`), so imports are relative.
 *
 * @packageDocumentation
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as z from 'zod'

/** The schemas the stable surface is checked against; each brings every schema it references. */
export const ROOT_SCHEMAS = [
  'CreateChatCompletionRequest',
  'CreateChatCompletionResponse',
  'CreateChatCompletionStreamResponse',
  'ListModelsResponse',
  'Model',
  'ErrorResponse'
] as const

/** The repository OpenAI publishes the spec in. */
const REPOSITORY = 'openai/openai-openapi'
/** A full commit SHA: a branch name or short SHA would not pin the spec. */
const COMMIT_PATTERN = /^[0-9a-f]{40}$/
/** How a schema reference starts; the rest is the schema's name. */
const SCHEMA_REF_PREFIX = '#/components/schemas/'
/** Where the subset is written. */
const SUBSET_PATH = fileURLToPath(
  new URL('../test/fixtures/openai-spec/openapi-subset.json', import.meta.url)
)
/** Indentation of the written JSON, before `vp fmt` formats it. */
const JSON_INDENT = 2

/** The part of the downloaded spec this script reads. */
const specSchema = z.object({
  openapi: z.string().trim(),
  info: z.object({ version: z.string().trim() }),
  components: z.object({ schemas: z.record(z.string(), z.unknown()) })
})

/**
 * Collects the names of every schema a value references through `$ref`, at any depth.
 *
 * @param value - a schema, or any part of one
 * @param into - the set the names are added to
 */
export function collectSchemaRefs(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const schemaPart of value) collectSchemaRefs(schemaPart, into)
    return
  }
  if (value === null || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (key === '$ref' && typeof child === 'string' && child.startsWith(SCHEMA_REF_PREFIX)) {
      into.add(child.slice(SCHEMA_REF_PREFIX.length))
    } else {
      collectSchemaRefs(child, into)
    }
  }
}

/**
 * Picks the root schemas and every schema they reach through `$ref`, sorted by name.
 *
 * @param schemas - every schema in the spec, by name
 * @param roots - the schemas to start from
 * @returns the reached schemas, by name, in name order so a spec bump diffs cleanly
 * @throws Error when a root or a referenced schema is not in `schemas`
 */
export function extractSubset(
  schemas: Readonly<Record<string, unknown>>,
  roots: readonly string[]
): Record<string, unknown> {
  const reached = new Set<string>()
  const pending = [...roots]
  for (let schemaName = pending.pop(); schemaName !== undefined; schemaName = pending.pop()) {
    if (reached.has(schemaName)) continue
    const schema = schemas[schemaName]
    if (schema === undefined) throw new Error(`Schema '${schemaName}' is not in the spec`)
    reached.add(schemaName)
    const refs = new Set<string>()
    collectSchemaRefs(schema, refs)
    pending.push(...refs)
  }
  return Object.fromEntries(
    [...reached]
      .toSorted()
      .map((schemaName): [string, unknown] => [schemaName, schemas[schemaName]])
  )
}

/** Downloads the spec at the commit given on the command line and writes the subset. */
async function main(): Promise<void> {
  const commit = process.argv[2] ?? ''
  if (!COMMIT_PATTERN.test(commit)) {
    throw new Error(`Usage: pnpm run openai-spec:update <40-character commit SHA of ${REPOSITORY}>`)
  }
  const url = `https://raw.githubusercontent.com/${REPOSITORY}/${commit}/openapi.json`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`GET ${url} answered ${String(response.status)}`)
  const spec = specSchema.parse(await response.json())
  const subset = {
    'x-source': {
      repository: REPOSITORY,
      commit,
      file: 'openapi.json',
      version: spec.info.version
    },
    'openapi': spec.openapi,
    'components': { schemas: extractSubset(spec.components.schemas, ROOT_SCHEMAS) }
  }
  mkdirSync(dirname(SUBSET_PATH), { recursive: true })
  writeFileSync(SUBSET_PATH, `${JSON.stringify(subset, null, JSON_INDENT)}\n`)
  execFileSync('pnpm', ['exec', 'vp', 'fmt', SUBSET_PATH], { stdio: 'inherit' })
  process.stdout.write(
    `wrote ${String(Object.keys(subset.components.schemas).length)} schemas from ${REPOSITORY}@${commit} to ${SUBSET_PATH}\n`
  )
}

if (import.meta.main) await main()
