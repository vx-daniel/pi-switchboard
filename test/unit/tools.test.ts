import { convertTools } from '@proxy/openai/tools'
import { assert, describe, expect, test } from 'vite-plus/test'

describe('convertTools', () => {
  /**
   * Round-trips a value through JSON, giving the schema as pi sends it upstream.
   *
   * @param schema - the converted value: a schema or a whole conversion result
   * @returns the JSON-parsed copy
   */
  function asJson(schema: unknown): unknown {
    return JSON.parse(JSON.stringify(schema))
  }

  // Catches a converter that ignores `parameters` (an empty object schema would pass a type check),
  // drops `required` or descriptions, or rewrites the client's schema, as the TypeBox conversion
  // before #360 sent an enum as `anyOf` const branches. Constraint keywords are locked per type in
  // tool-schema.test.ts.
  test('converts a function tool into exactly the schema sent upstream', () => {
    const result = convertTools([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get the weather for a city',
          parameters: {
            type: 'object',
            properties: {
              city: { type: 'string', description: 'The city name' },
              unit: { type: 'string', enum: ['celsius', 'fahrenheit'] },
              days: { type: 'integer' },
              tags: { type: 'array', items: { type: 'string' } }
            },
            required: ['city']
          }
        }
      }
    ])
    assert(result.ok, 'expected the tool to convert')
    const [tool] = result.tools

    expect(tool?.name).toBe('get_weather')
    expect(tool?.description).toBe('Get the weather for a city')
    expect(asJson(tool?.parameters)).toEqual({
      type: 'object',
      properties: {
        city: { type: 'string', description: 'The city name' },
        unit: { type: 'string', enum: ['celsius', 'fahrenheit'] },
        days: { type: 'integer' },
        tags: { type: 'array', items: { type: 'string' } }
      },
      required: ['city']
    })
  })

  // Catches a tool without `parameters` sent with no schema, which providers reject.
  test('gives a tool without parameters an empty object schema', () => {
    const result = convertTools([
      { type: 'function', function: { name: 'list_all', description: 'List everything' } }
    ])
    assert(result.ok, 'expected the tool to convert')

    expect(asJson(result.tools[0]?.parameters)).toEqual({ type: 'object', properties: {} })
  })

  // Catches a converter that drops, reorders, or merges tools when several are sent.
  test('converts multiple tools', () => {
    const result = convertTools([
      {
        type: 'function',
        function: {
          name: 'tool_a',
          description: 'Tool A',
          parameters: { type: 'object', properties: {} }
        }
      },
      {
        type: 'function',
        function: {
          name: 'tool_b',
          description: 'Tool B',
          parameters: { type: 'object', properties: { amount: { type: 'number' } } }
        }
      }
    ])
    assert(result.ok, 'expected the tools to convert')

    expect(asJson(result)).toEqual({
      ok: true,
      tools: [
        {
          name: 'tool_a',
          description: 'Tool A',
          parameters: { type: 'object', properties: {} }
        },
        {
          name: 'tool_b',
          description: 'Tool B',
          parameters: { type: 'object', properties: { amount: { type: 'number' } } }
        }
      ]
    })
  })

  // Catches an unsupported `$ref` slipping through to the provider, or an error that no longer
  // names the offending tool parameter.
  test('rejects tools with unsupported JSON Schema', () => {
    const result = convertTools([
      {
        type: 'function',
        function: {
          name: 'bad_tool',
          description: 'Bad tool',
          parameters: {
            type: 'object',
            properties: {
              data: { $ref: '#/definitions/Data' }
            }
          }
        }
      }
    ])

    expect(result).toEqual({
      ok: false,
      message: "Unsupported JSON Schema keyword '$ref' at tools[0].function.parameters.data",
      param: 'tools[0].function.parameters.data'
    })
  })

  // Catches a missing description sent as undefined (some providers reject it) instead of '', or
  // the client's `parameters` rewritten.
  test('handles tool with empty description', () => {
    const result = convertTools([
      {
        type: 'function',
        function: {
          name: 'no_desc',
          parameters: { type: 'object' }
        }
      }
    ])

    expect(asJson(result)).toEqual({
      ok: true,
      tools: [{ name: 'no_desc', description: '', parameters: { type: 'object' } }]
    })
  })

  // Catches nested object properties or their `required` list being flattened or dropped.
  test('converts tools with nested object parameters', () => {
    const result = convertTools([
      {
        type: 'function',
        function: {
          name: 'create_user',
          description: 'Create a user',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              address: {
                type: 'object',
                properties: {
                  street: { type: 'string' },
                  city: { type: 'string' },
                  zip: { type: 'string' }
                },
                required: ['street', 'city']
              }
            },
            required: ['name']
          }
        }
      }
    ])

    expect(asJson(result)).toEqual({
      ok: true,
      tools: [
        {
          name: 'create_user',
          description: 'Create a user',
          parameters: {
            type: 'object',
            required: ['name'],
            properties: {
              name: { type: 'string' },
              address: {
                type: 'object',
                required: ['street', 'city'],
                properties: {
                  street: { type: 'string' },
                  city: { type: 'string' },
                  zip: { type: 'string' }
                }
              }
            }
          }
        }
      ]
    })
  })

  // Catches array item types or array descriptions lost in conversion.
  test('converts tools with array parameters', () => {
    const result = convertTools([
      {
        type: 'function',
        function: {
          name: 'process_items',
          description: 'Process items',
          parameters: {
            type: 'object',
            properties: {
              items: {
                type: 'array',
                items: { type: 'string' },
                description: 'List of items to process'
              }
            },
            required: ['items']
          }
        }
      }
    ])

    expect(asJson(result)).toEqual({
      ok: true,
      tools: [
        {
          name: 'process_items',
          description: 'Process items',
          parameters: {
            type: 'object',
            required: ['items'],
            properties: {
              items: {
                type: 'array',
                items: { type: 'string' },
                description: 'List of items to process'
              }
            }
          }
        }
      ]
    })
  })
})
