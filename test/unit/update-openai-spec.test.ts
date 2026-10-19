/**
 * `extractSubset` from `scripts/update-openai-spec.ts`: which of OpenAI's schemas the pinned
 * subset keeps. The download itself is not run offline.
 */

import { describe, expect, test } from 'vite-plus/test'

import { extractSubset } from '../../scripts/update-openai-spec.ts'

/**
 * Builds a schema reference.
 *
 * @param name - the referenced schema
 * @returns `{ $ref: '#/components/schemas/<name>' }`
 */
function ref(name: string): Record<string, string> {
  return { $ref: `#/components/schemas/${name}` }
}

describe('extractSubset', () => {
  // Catches a reference followed one level only, or missed inside an array (`allOf`, `oneOf`):
  // the subset would lack a schema, and validating against it would fail to compile.
  test('keeps every schema reached from the roots, at any depth, and nothing else', () => {
    const schemas = {
      Root: { allOf: [ref('Base'), { properties: { items: { items: ref('Item') } } }] },
      Base: { properties: { tag: ref('Tag') } },
      Item: { oneOf: [ref('Tag'), { type: 'null' }] },
      Tag: { type: 'string' },
      Unrelated: { properties: { tag: ref('Tag') } }
    }

    expect(Object.keys(extractSubset(schemas, ['Root']))).toEqual(['Base', 'Item', 'Root', 'Tag'])
  })

  // Catches a dangling reference written out silently: the pinned file would look complete.
  test('refuses a reference to a schema the spec does not have', () => {
    expect(() => extractSubset({ Root: ref('Missing') }, ['Root'])).toThrow(
      "Schema 'Missing' is not in the spec"
    )
  })

  // Catches a schema that references itself looping forever.
  test('handles a schema that references itself', () => {
    const schemas = { Node: { properties: { children: { items: ref('Node') } } } }

    expect(extractSubset(schemas, ['Node'])).toEqual(schemas)
  })
})
