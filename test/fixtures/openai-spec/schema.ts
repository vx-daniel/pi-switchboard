/**
 * OpenAI's pinned spec subset (`openapi-subset.json`, #132) and the proxy's request schema, as JSON
 * Schema, with the helpers the spec checks walk them with: following `$ref`s, collecting an
 * object's properties, and telling a union's branches apart by their discriminator.
 *
 * @packageDocumentation
 */

import { readFileSync } from 'node:fs'

import { createResponseRequestSchema } from '@proxy/openai/responses-api/request-schema'
import { chatCompletionRequestSchema } from '@proxy/openai/schemas'
import { isRecord } from '@proxy/utils/guards'
import * as z from 'zod'

/** The part of the pinned subset the checks read. */
const subsetSchema = z.object({
  'x-source': z.object({ commit: z.string().trim() }),
  'components': z.object({ schemas: z.record(z.string(), z.unknown()) })
})

/** The pinned subset of OpenAI's spec. */
export const subset = subsetSchema.parse(
  JSON.parse(readFileSync(new URL('openapi-subset.json', import.meta.url), 'utf8'))
)

/** OpenAI's schemas, by name. */
export const openaiSchemas = subset.components.schemas

/** OpenAI's chat-completions request schema. */
export const openaiRequestSchema = openaiSchemas['CreateChatCompletionRequest']

/** The proxy's request schema, as JSON Schema, in the shape a client sends it. */
export const proxyRequestSchema: unknown = z.toJSONSchema(chatCompletionRequestSchema, {
  io: 'input'
})

/** OpenAI's Responses API request schema (#140). */
export const openaiResponsesRequestSchema = openaiSchemas['CreateResponse']

/** The proxy's Responses API request schema, as JSON Schema, in the shape a client sends it. */
export const proxyResponsesRequestSchema: unknown = z.toJSONSchema(createResponseRequestSchema, {
  io: 'input'
})

/** How a schema reference to another OpenAI schema starts. */
const SCHEMA_REF_PREFIX = '#/components/schemas/'

/**
 * Follows a `$ref` to an OpenAI schema; any other node is returned as is.
 *
 * @param node - a schema node
 * @returns the node, or the schema it references
 */
export function resolve(node: unknown): Record<string, unknown> {
  if (!isRecord(node)) return {}
  const ref = node['$ref']
  if (typeof ref !== 'string' || !ref.startsWith(SCHEMA_REF_PREFIX)) return node
  return resolve(openaiSchemas[ref.slice(SCHEMA_REF_PREFIX.length)])
}

/**
 * Lists the array items of a schema node's `key`, or nothing.
 *
 * @param node - a schema node
 * @param key - `allOf`, `anyOf` or `oneOf`
 * @returns the branches
 */
function branches(node: Record<string, unknown>, key: string): unknown[] {
  const value = node[key]
  return Array.isArray(value) ? value : []
}

/**
 * Lists a union schema's branches: its `anyOf` and `oneOf`.
 *
 * @param schema - a resolved schema node
 * @returns the branches
 */
function unionBranches(schema: Record<string, unknown>): unknown[] {
  return [...branches(schema, 'anyOf'), ...branches(schema, 'oneOf')]
}

/**
 * Collects an object schema's properties, through `$ref` and `allOf`.
 *
 * @param node - an object schema
 * @returns every property schema, by name
 */
export function propertiesOf(node: unknown): Record<string, unknown> {
  const schema = resolve(node)
  const own = isRecord(schema['properties']) ? schema['properties'] : {}
  const inherited: Record<string, unknown> = {}
  for (const branch of branches(schema, 'allOf')) Object.assign(inherited, propertiesOf(branch))
  return { ...inherited, ...own }
}

/**
 * Collects an object schema's required property names, through `$ref` and `allOf`.
 *
 * @param node - an object schema
 * @returns the required names
 */
export function requiredOf(node: unknown): string[] {
  const schema = resolve(node)
  const own = Array.isArray(schema['required']) ? schema['required'] : []
  return [
    ...branches(schema, 'allOf').flatMap(requiredOf),
    ...own.filter((requiredName): requiredName is string => typeof requiredName === 'string')
  ]
}

/**
 * Lists the string literals a schema node allows directly: its `enum` strings and `const`.
 *
 * @param node - a resolved schema node
 * @returns the literals
 */
function literalsOf(node: Record<string, unknown>): string[] {
  const values = [...branches(node, 'enum'), node['const']]
  return values.filter((literal): literal is string => typeof literal === 'string')
}

/**
 * Lists the alternatives a schema allows: string literals, and for object branches the value of
 * their discriminator property, as `<discriminator>: <value>`.
 *
 * @param node - the schema
 * @param discriminator - the property that tells object branches apart (`type`, `role`)
 * @returns the alternatives, sorted and without repeats
 */
export function alternatives(node: unknown, discriminator: string): string[] {
  const schema = resolve(node)
  const union = unionBranches(schema)
  const found =
    union.length > 0
      ? union.flatMap((branch) => alternatives(branch, discriminator))
      : literalsOf(schema)
  if (found.length > 0 || union.length > 0) return [...new Set(found)].toSorted()
  const tag = propertiesOf(schema)[discriminator]
  return literalsOf(resolve(tag)).map((literal) => `${discriminator}: ${literal}`)
}

/**
 * Maps each object branch of a union schema to its properties, keyed as {@link alternatives} keys
 * them (`role: user`, `type: text`), through nested unions.
 *
 * @param node - the union schema
 * @param discriminator - the property that tells the branches apart
 * @returns each branch's properties, by its key
 */
export function branchProperties(
  node: unknown,
  discriminator: string
): Record<string, Record<string, unknown>> {
  const schema = resolve(node)
  const union = unionBranches(schema)
  if (union.length > 0) {
    const merged: Record<string, Record<string, unknown>> = {}
    for (const branch of union) {
      Object.assign(merged, branchProperties(branch, discriminator))
    }
    return merged
  }
  const properties = propertiesOf(schema)
  return Object.fromEntries(
    literalsOf(resolve(properties[discriminator])).map((literal) => [
      `${discriminator}: ${literal}`,
      properties
    ])
  )
}

/**
 * The items of the array a schema allows, directly or as one branch of a union (a user message's
 * `content` is a string or an array of parts).
 *
 * @param node - the schema
 * @returns the array's items, or an empty schema when it allows no array
 */
export function arrayItems(node: unknown): unknown {
  const schema = resolve(node)
  if (schema['type'] === 'array') return schema['items']
  return unionBranches(schema)
    .map(resolve)
    .find((branch) => branch['type'] === 'array')?.['items']
}

/**
 * The schema of one request field, or of its array items.
 *
 * @param request - the request schema
 * @param field - the top-level field
 * @param items - whether to take the field's `items`
 * @returns the field's (or its items') schema
 */
export function fieldSchema(request: unknown, field: string, items: boolean): unknown {
  const schema = resolve(propertiesOf(request)[field])
  return items ? schema['items'] : schema
}
