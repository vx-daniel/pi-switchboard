import { checkToolSchema } from '@proxy/openai/tool-schema'
import { describe, expect, test } from 'vite-plus/test'

/**
 * Checks a schema at path `p` and returns it as it goes to pi, after a JSON round trip.
 *
 * @param schema - the client's JSON Schema
 * @returns the accepted schema as JSON, or the failure result unchanged
 */
function acceptedJson(schema: unknown): unknown {
  const result = checkToolSchema(schema, 'p')
  return result.ok ? JSON.parse(JSON.stringify(result.schema)) : result
}

describe('checkToolSchema', () => {
  // Catches a supported schema rewritten on its way to pi (#360): before pi 1.5 the proxy rebuilt
  // every schema as TypeBox, which sent `enum` and `type: [T, "null"]` as `anyOf` unions and
  // dropped the `type` of a string enum. Each schema here goes to pi exactly as written.
  test.each([
    ['a string', { type: 'string', description: 'A name' }],
    ['a number', { type: 'number' }],
    ['an integer', { type: 'integer' }],
    ['a boolean', { type: 'boolean' }],
    ['null', { type: 'null' }],
    ['an object without properties', { type: 'object' }],
    [
      'an object with an optional property',
      {
        type: 'object',
        properties: { name: { type: 'string' }, nickname: { type: 'string' } },
        required: ['name']
      }
    ],
    ['an array without items', { type: 'array' }],
    [
      'a nested array of objects',
      {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            tags: { type: 'array', items: { type: 'string' } }
          },
          required: ['id']
        }
      }
    ],
    ['a string enum', { enum: ['red', 'green', 'blue'] }],
    [
      'a typed string enum with constraints',
      { type: 'string', enum: ['2026-01-01'], format: 'date', maxLength: 10 }
    ],
    [
      'a nullable type with constraints and annotations',
      { type: ['string', 'null'], maxLength: 3, description: 'zone', default: null }
    ],
    [
      'a nullable object',
      { type: ['object', 'null'], properties: { city: { type: 'string' } }, required: ['city'] }
    ],
    ['a nullable anyOf', { anyOf: [{ type: 'string' }, { type: 'null' }] }],
    [
      'an anyOf with an object branch and a description',
      {
        description: 'A place or null',
        anyOf: [
          { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
          { type: 'null' }
        ]
      }
    ],
    [
      'an anyOf with a sibling type',
      { type: 'string', anyOf: [{ type: 'string', format: 'date' }, { type: 'string' }] }
    ],
    ['an unconstrained node', {}],
    ['an annotated unconstrained node', { description: 'anything' }]
  ])('%s goes to pi as written', (_label, schema) => {
    expect(acceptedJson(schema)).toEqual(schema)
  })

  // Catches a constraint or annotation dropped, renamed or moved for its type (#37).
  test.each([
    { type: 'string', minLength: 1, maxLength: 5, pattern: '^a', format: 'date-time', const: 'a' },
    {
      type: 'number',
      minimum: 0,
      maximum: 1.5,
      exclusiveMinimum: -1,
      exclusiveMaximum: 2,
      multipleOf: 0.5
    },
    { type: 'integer', minimum: 1, maximum: 9, multipleOf: 1, const: 3 },
    { type: 'boolean', const: true },
    { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3, uniqueItems: true },
    {
      type: 'object',
      properties: {},
      minProperties: 1,
      maxProperties: 4,
      additionalProperties: true
    },
    {
      type: 'null',
      description: 'nothing',
      title: 'Nothing',
      default: null,
      examples: [null],
      deprecated: true,
      readOnly: true,
      writeOnly: false
    }
  ])('$type keeps its keywords', (schema) => {
    expect(acceptedJson(schema)).toEqual(schema)
  })

  // Catches key order changed on the way to pi: a provider's prompt cache keys on the exact bytes,
  // so a reordered tool schema would miss the cache a client's own order would hit.
  test('keeps the order of keys', () => {
    const result = checkToolSchema({
      required: ['zone'],
      properties: { zone: { description: 'Zone', type: 'string' }, days: { type: 'integer' } },
      type: 'object'
    })

    expect(result.ok && JSON.stringify(result.schema)).toBe(
      '{"required":["zone"],"properties":{"zone":{"description":"Zone","type":"string"},"days":{"type":"integer"}},"type":"object"}'
    )
  })

  // Catches meta declarations forwarded upstream or refused: they mean nothing to the model. A
  // property *named* like a meta keyword is data, not a keyword, and is kept.
  test('$schema, $id and $comment are dropped at every node, but not as property names', () => {
    expect(
      acceptedJson({
        $schema: 'http://json-schema.org/draft-07/schema#',
        $id: 'urn:weather',
        $comment: 'internal',
        type: 'object',
        properties: {
          city: { type: 'string', $comment: 'free text' },
          $id: { type: ['string', 'null'], $comment: 'record id' },
          tags: { type: 'array', items: { type: 'string', $comment: 'tag' } },
          zone: { anyOf: [{ type: 'string', $comment: 'IANA' }, { type: 'null' }] }
        }
      })
    ).toEqual({
      type: 'object',
      properties: {
        city: { type: 'string' },
        $id: { type: ['string', 'null'] },
        tags: { type: 'array', items: { type: 'string' } },
        zone: { anyOf: [{ type: 'string' }, { type: 'null' }] }
      }
    })
  })

  // Catches the client's schema modified in place (meta keywords deleted from it): the Responses
  // API echoes the request's own `tools[].parameters` back to the client (`toolsEcho`).
  test('leaves the client schema unchanged', () => {
    const schema = { $comment: 'x', type: 'object', properties: { city: { type: 'string' } } }
    const before = structuredClone(schema)

    checkToolSchema(schema)

    expect(schema).toEqual(before)
  })

  // Catches a malformed `required` passed on, which a provider ignoring it would read as every
  // property optional: a silent downgrade of the client's schema (#111). Refused with or without
  // `properties`.
  test.each([
    { required: 'name', properties: { name: { type: 'string' } } },
    { required: ['name', 1], properties: { name: { type: 'string' } } },
    { required: { name: true }, properties: { name: { type: 'string' } } },
    { required: true, properties: undefined }
  ])('rejects required $required', ({ required, properties }) => {
    const result = checkToolSchema({
      type: 'object',
      ...(properties === undefined ? {} : { properties }),
      required
    })

    expect(result).toEqual({
      ok: false,
      message: "'required' must be an array of property names at root",
      path: ''
    })
  })

  // Catches a construct outside the subset sent upstream to fail there, or dropped.
  test.each([
    [{ enum: [1, 2, 3] }, 'Only string enums are supported at p'],
    [{ enum: [] }, 'Empty enum at p'],
    [
      { type: ['string', 'number', 'null'] },
      'Only [type, "null"] nullable types are supported at p'
    ],
    [{ $ref: '#/definitions/Foo' }, "Unsupported JSON Schema keyword '$ref' at p"],
    [
      { oneOf: [{ type: 'string' }, { type: 'number' }] },
      "Unsupported JSON Schema keyword 'oneOf' at p"
    ],
    [{ allOf: [{ type: 'object' }] }, "Unsupported JSON Schema keyword 'allOf' at p"],
    [
      { type: 'object', patternProperties: { '^S_': { type: 'string' } } },
      "Unsupported JSON Schema keyword 'patternProperties' at p"
    ],
    ['not an object', 'Schema must be an object'],
    [{ type: 'date' }, "Unsupported type 'date' at p"],
    [{ anyOf: [] }, "Empty 'anyOf' at p"],
    [
      { anyOf: Array.from({ length: 11 }, () => ({ type: 'string' })) },
      "'anyOf' with more than 10 branches is not supported at p"
    ],
    [{ type: 'object', properties: [] }, "'properties' must be an object at p"]
  ])('%j is refused', (schema, message) => {
    expect(checkToolSchema(schema, 'p')).toMatchObject({ ok: false, message })
  })

  // Catches a keyword outside the supported subset silently dropped instead of refused, a
  // keyword accepted on a type it does not apply to, a value of the wrong kind sent upstream to
  // fail there, or an inherited property name (`toString`) mistaken for a supported keyword.
  test.each([
    [
      { 'type': 'string', 'x-display': 'City' },
      "Unsupported JSON Schema keyword 'x-display' for type 'string' at p"
    ],
    [
      { type: 'integer', maxLength: 3 },
      "Unsupported JSON Schema keyword 'maxLength' for type 'integer' at p"
    ],
    [
      { type: 'string', toString: 'x' },
      "Unsupported JSON Schema keyword 'toString' for type 'string' at p"
    ],
    [
      { type: 'string', nullable: true },
      "Unsupported JSON Schema keyword 'nullable' for type 'string' at p"
    ],
    [
      { anyOf: [{ type: 'string' }], minLength: 1 },
      "Unsupported JSON Schema keyword 'minLength' at p"
    ],
    [
      { type: 'string', enum: ['a'], minimum: 1 },
      "Unsupported JSON Schema keyword 'minimum' for type 'string' at p"
    ],
    [
      { type: 7, anyOf: [{ type: 'string' }] },
      "'type' must be a type name or an array of type names at p"
    ],
    [{ minimum: 1 }, "Missing or invalid 'type' at p"],
    [{ type: 'string', minLength: -1 }, "'minLength' must be a non-negative integer at p"],
    [{ type: 'array', maxItems: 1.5 }, "'maxItems' must be a non-negative integer at p"],
    [{ type: 'number', exclusiveMinimum: true }, "'exclusiveMinimum' must be a finite number at p"],
    [{ type: 'string', pattern: 1 }, "'pattern' must be a string at p"],
    [{ type: 'array', uniqueItems: 'yes' }, "'uniqueItems' must be a boolean at p"],
    [{ type: 'string', examples: 'a' }, "'examples' must be an array at p"],
    [{ type: 'string', description: 1 }, "'description' must be a string at p"],
    [
      { type: 'object', additionalProperties: { type: 'string' } },
      "'additionalProperties' must be a boolean at p"
    ]
  ])('%j is refused with its keyword named', (schema, message) => {
    expect(checkToolSchema(schema, 'p')).toEqual({ ok: false, message, path: 'p' })
  })

  // Catches a failing node reported at the wrong path: property paths have no `properties`
  // segment, and an anyOf branch reads like a property path (#111), at the root and below it.
  test.each([
    {
      at: 'a nested property',
      schema: {
        type: 'object',
        properties: {
          nested: { type: 'object', properties: { bad: { $ref: '#/definitions/Bad' } } }
        }
      },
      path: undefined,
      expected: 'nested.bad'
    },
    {
      at: 'an array item',
      schema: { type: 'array', items: { type: 'date' } },
      path: undefined,
      expected: 'items'
    },
    {
      at: 'a root anyOf branch',
      schema: { anyOf: [{ type: 'string' }, { $ref: '#/bad' }] },
      path: undefined,
      expected: 'anyOf[1]'
    },
    {
      at: 'a nested anyOf branch',
      schema: { anyOf: [{ type: 'string' }, { $ref: '#/bad' }] },
      path: 'tools[0].function.parameters',
      expected: 'tools[0].function.parameters.anyOf[1]'
    }
  ])('names a failure in $at by its path', ({ schema, path, expected }) => {
    const result = checkToolSchema(schema, path)

    expect(result.ok ? undefined : result.path).toBe(expected)
  })
})
