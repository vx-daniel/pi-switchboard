/**
 * Converts the JSON Schema of OpenAI function tool parameters to TypeBox.
 *
 * @remarks
 * Contract:
 * - Support a documented subset of JSON Schema only
 * - Reject unsupported schema constructs with a {@link SchemaConversionError}
 * - Do not silently downgrade schemas: every keyword is carried over, dropped as meta, or rejected
 *
 * Supported subset:
 * - type: object, string, number, integer, boolean, array, null
 * - properties, required, items
 * - enum (string enums)
 * - nullable via type: [T, "null"]
 * - anyOf for nullable types and simple unions (max 10 branches); a sibling `type` is carried
 * - annotations on any node: description, title, default, examples, deprecated, readOnly, writeOnly
 * - constraints per type, carried over (see TYPE_CONVERTERS), also on a string enum:
 *   string minLength, maxLength, pattern, format, const; number and integer minimum, maximum,
 *   exclusiveMinimum, exclusiveMaximum, multipleOf, const; boolean const; array minItems,
 *   maxItems, uniqueItems; object minProperties, maxProperties, additionalProperties (boolean)
 * - values are checked by kind only: `const` is not checked against the type, nor `pattern`
 *   compiled
 *
 * Dropped, logged at debug: $schema, $id, $comment (they say nothing to the model).
 *
 * Rejected:
 * - $ref, oneOf, allOf, not, if/then/else, patternProperties (so no recursive schemas)
 * - additionalProperties as a schema (boolean true/false allowed)
 * - any other keyword, or a supported keyword with a value of the wrong kind
 *
 * @packageDocumentation
 */

import { type TSchema, Type } from '@earendil-works/pi-ai'
import { proxyLogger } from '@proxy/logging'
import { isRecord } from '@proxy/utils/guards'

/** Successful conversion: the TypeBox schema. */
export interface SchemaConversionSuccess {
  readonly ok: true
  readonly schema: TSchema
}

/** Failed conversion: why, and the path of the offending node. */
export interface SchemaConversionError {
  readonly ok: false
  readonly message: string
  readonly path: string
}

/** Outcome of {@link jsonSchemaToTypebox}, discriminated on `ok`. */
export type SchemaConversionResult = SchemaConversionSuccess | SchemaConversionError

/**
 * Unsupported JSON Schema keywords rejected before anything else on a node.
 *
 * @remarks
 * `anyOf` is not here: it is converted for nullable types and simple unions.
 */
const REJECTED_KEYWORDS = [
  '$ref',
  'oneOf',
  'allOf',
  'if',
  'then',
  'else',
  'patternProperties',
  'not'
] as const

/** Logger for JSON Schema conversion. */
const schemaLogger = proxyLogger('openai', 'schema')

/** Maximum number of `anyOf` branches. */
const MAX_ANY_OF_BRANCHES = 10
/** Length of a nullable type array: `[T, "null"]`. */
const NULLABLE_TYPE_ARRAY_LENGTH = 2

/**
 * What a keyword's value must be. `count` is a non-negative integer, `types` a type name or a
 * list of them, `json` any JSON value.
 */
type KeywordValueKind = 'string' | 'number' | 'count' | 'boolean' | 'array' | 'types' | 'json'

/** For each kind of keyword value: how errors describe it, and whether a value is one. */
const KEYWORD_VALUE_KINDS: Readonly<
  Record<
    KeywordValueKind,
    { readonly description: string; accepts(keywordValue: unknown): boolean }
  >
> = {
  string: { description: 'a string', accepts: (keywordValue) => typeof keywordValue === 'string' },
  number: {
    description: 'a finite number',
    accepts: (keywordValue) => typeof keywordValue === 'number' && Number.isFinite(keywordValue)
  },
  count: {
    description: 'a non-negative integer',
    accepts: (keywordValue) =>
      typeof keywordValue === 'number' && Number.isInteger(keywordValue) && keywordValue >= 0
  },
  boolean: {
    description: 'a boolean',
    accepts: (keywordValue) => typeof keywordValue === 'boolean'
  },
  array: { description: 'an array', accepts: (keywordValue) => Array.isArray(keywordValue) },
  types: {
    description: 'a type name or an array of type names',
    accepts: (keywordValue) =>
      typeof keywordValue === 'string' ||
      (Array.isArray(keywordValue) &&
        keywordValue.every((typeName) => typeof typeName === 'string'))
  },
  json: { description: 'a JSON value', accepts: (keywordValue) => keywordValue !== undefined }
}

/** Annotations: allowed on any node, carried into the converted schema. */
const ANNOTATION_KEYWORDS: ReadonlyMap<string, KeywordValueKind> = new Map([
  ['description', 'string'],
  ['title', 'string'],
  ['default', 'json'],
  ['examples', 'array'],
  ['deprecated', 'boolean'],
  ['readOnly', 'boolean'],
  ['writeOnly', 'boolean']
])

/** Meta declarations: they say nothing to the model, so they are dropped (logged at debug). */
const META_KEYWORDS: ReadonlySet<string> = new Set(['$schema', '$id', '$comment'])

/** The constraint set of a node that takes no constraints. */
const NO_CONSTRAINTS: ReadonlyMap<string, KeywordValueKind> = new Map()

/** Constraints carried on a `string` node or a string enum. */
const STRING_CONSTRAINTS: ReadonlyMap<string, KeywordValueKind> = new Map([
  ['minLength', 'count'],
  ['maxLength', 'count'],
  ['pattern', 'string'],
  ['format', 'string'],
  ['const', 'json']
])

/** Constraints carried on a `number` or `integer` node. */
const NUMBER_CONSTRAINTS: ReadonlyMap<string, KeywordValueKind> = new Map([
  ['minimum', 'number'],
  ['maximum', 'number'],
  ['exclusiveMinimum', 'number'],
  ['exclusiveMaximum', 'number'],
  ['multipleOf', 'number'],
  ['const', 'json']
])

/** On an `anyOf` node: a sibling `type`, which some generators emit, carried as written. */
const ANY_OF_CONSTRAINTS: ReadonlyMap<string, KeywordValueKind> = new Map([['type', 'types']])

/** How one supported `type` converts. */
interface TypeConverter {
  /** Validation keywords, carried into the converted schema. */
  readonly constraints: ReadonlyMap<string, KeywordValueKind>
  /** Keywords `convert` reads itself, besides `type`. */
  readonly structural: readonly string[]
  convert(
    opts: Record<string, unknown>,
    schema: Record<string, unknown>,
    path: string
  ): SchemaConversionResult
}

/** The converter for each supported `type`. */
const TYPE_CONVERTERS: ReadonlyMap<string, TypeConverter> = new Map<string, TypeConverter>([
  [
    'string',
    {
      constraints: STRING_CONSTRAINTS,
      structural: [],
      convert: (opts) => ({ ok: true, schema: Type.String(opts) })
    }
  ],
  [
    'number',
    {
      constraints: NUMBER_CONSTRAINTS,
      structural: [],
      convert: (opts) => ({ ok: true, schema: Type.Number(opts) })
    }
  ],
  [
    'integer',
    {
      constraints: NUMBER_CONSTRAINTS,
      structural: [],
      convert: (opts) => ({ ok: true, schema: Type.Integer(opts) })
    }
  ],
  [
    'boolean',
    {
      constraints: new Map([['const', 'json']]),
      structural: [],
      convert: (opts) => ({ ok: true, schema: Type.Boolean(opts) })
    }
  ],
  [
    'null',
    {
      constraints: NO_CONSTRAINTS,
      structural: [],
      convert: (opts) => ({ ok: true, schema: Type.Null(opts) })
    }
  ],
  [
    'array',
    {
      constraints: new Map([
        ['minItems', 'count'],
        ['maxItems', 'count'],
        ['uniqueItems', 'boolean']
      ]),
      structural: ['items'],
      convert: (opts, schema, path) => convertArray(schema, path, opts)
    }
  ],
  [
    'object',
    {
      constraints: new Map([
        ['minProperties', 'count'],
        ['maxProperties', 'count'],
        ['additionalProperties', 'boolean']
      ]),
      structural: ['properties', 'required'],
      convert: (opts, schema, path) => convertObject(schema, path, opts)
    }
  ]
])

/**
 * Converts a JSON Schema object to a TypeBox schema.
 *
 * @param schema - the JSON Schema, of any shape
 * @param path - the request path of the schema, prefixed to error paths; `''` for the root
 * @returns the TypeBox schema, or the error for the first unsupported construct
 */
export function jsonSchemaToTypebox(schema: unknown, path = ''): SchemaConversionResult {
  const result = convertSchema(schema, path)
  if (result.ok) {
    schemaLogger.trace('Converted JSON Schema at {path}', { path: path || 'root' })
  } else {
    schemaLogger.debug('Rejected JSON Schema at {path}: {reason}', {
      path: result.path || 'root',
      reason: result.message
    })
  }
  return result
}

/**
 * Converts one schema node, dispatching on `anyOf`, `enum`, a `type` array, a `type` name or no
 * type.
 *
 * @param schema - the node, of any shape
 * @param path - the node's path, for errors
 * @returns the TypeBox schema, or the error for the first unsupported construct
 */
function convertSchema(schema: unknown, path: string): SchemaConversionResult {
  if (!isRecord(schema)) {
    return {
      ok: false,
      message: 'Schema must be an object',
      path
    }
  }

  const rejected = findRejectedKeyword(schema, path)
  if (rejected !== undefined) {
    return rejected
  }

  // anyOf: nullable types and simple type unions.
  // Example: anyOf: [{type: "string"}, {type: "null"}] -> Union(String, Null)
  const anyOf = schema['anyOf']
  if (Array.isArray(anyOf)) {
    const keywords = collectKeywords(schema, path, {
      structural: ['anyOf'],
      constraints: ANY_OF_CONSTRAINTS
    })
    return keywords.ok ? convertAnyOf(anyOf, path, keywords.opts) : keywords
  }

  // enum: a string enum may also carry its type's constraints (e.g. `format`)
  const enumValues = schema['enum']
  if (Array.isArray(enumValues)) {
    const enumType = schema['type']
    const keywords = collectKeywords(schema, path, {
      structural: ['enum', 'type'],
      constraints:
        typeof enumType === 'string'
          ? (TYPE_CONVERTERS.get(enumType)?.constraints ?? NO_CONSTRAINTS)
          : NO_CONSTRAINTS,
      ...(typeof enumType === 'string' ? { typeName: enumType } : {})
    })
    return keywords.ok ? convertEnum(enumValues, path, keywords.opts) : keywords
  }

  // The node's type
  const rawType = schema['type']

  // Nullable via type: [T, "null"]
  if (Array.isArray(rawType)) {
    return convertNullableType(rawType, schema, path)
  }

  if (typeof rawType !== 'string') {
    return convertUntyped(schema, path)
  }

  return convertTyped(rawType, schema, path)
}

/**
 * Finds the first {@link REJECTED_KEYWORDS} entry present on a node.
 *
 * @param schema - the node
 * @param path - the node's path, for the error
 * @returns the error for the first rejected keyword, or `undefined`
 */
function findRejectedKeyword(
  schema: Record<string, unknown>,
  path: string
): SchemaConversionResult | undefined {
  for (const keyword of REJECTED_KEYWORDS) {
    if (schema[keyword] !== undefined) {
      schemaLogger.debug('Unsupported JSON Schema keyword {keyword} at {path}', {
        keyword,
        path: path || 'root'
      })
      return {
        ok: false,
        message: `Unsupported JSON Schema keyword '${keyword}' at ${path || 'root'}`,
        path
      }
    }
  }
  return undefined
}

/** Outcome of {@link collectKeywords}: the TypeBox options, or the error. */
type KeywordCollection =
  | { readonly ok: true; readonly opts: Record<string, unknown> }
  | SchemaConversionError

/** What a node may carry besides annotations and meta keywords. */
interface AllowedKeywords {
  /** Keywords the node's converter reads itself. */
  readonly structural: readonly string[]
  /** Validation keywords carried into the converted schema. */
  readonly constraints: ReadonlyMap<string, KeywordValueKind>
  /** The node's `type`, named in the error for a keyword it does not support. */
  readonly typeName?: string
}

/** Allowed keywords of a node that takes annotations only. */
const ANNOTATIONS_ONLY: AllowedKeywords = { structural: [], constraints: NO_CONSTRAINTS }

/**
 * Checks that every keyword of a node is allowed on it, and collects its annotations and
 * constraints as TypeBox options.
 *
 * @remarks
 * Meta keywords are dropped (logged at debug); anything else not allowed is rejected, so nothing
 * is lost silently.
 *
 * @param schema - the node
 * @param path - the node's path, for errors
 * @param allowed - the structural keywords and constraints the node may carry
 * @returns the TypeBox options, or the error for the first keyword not allowed
 */
function collectKeywords(
  schema: Record<string, unknown>,
  path: string,
  allowed: AllowedKeywords
): KeywordCollection {
  const opts: Record<string, unknown> = {}
  for (const [keyword, keywordValue] of Object.entries(schema)) {
    if (allowed.structural.includes(keyword)) {
      continue
    }
    if (META_KEYWORDS.has(keyword)) {
      schemaLogger.debug('Dropped meta keyword {keyword} at {path}', {
        keyword,
        path: path || 'root'
      })
      continue
    }
    const error = checkCarriedKeyword(keyword, keywordValue, path, allowed)
    if (error !== undefined) {
      return error
    }
    opts[keyword] = keywordValue
  }
  return { ok: true, opts }
}

/**
 * Checks that a non-structural, non-meta keyword is an annotation or a constraint allowed on the
 * node, and that its value has the right kind.
 *
 * @param keyword - the keyword
 * @param keywordValue - its value
 * @param path - the node's path, for the error
 * @param allowed - the constraints and type name of the node
 * @returns the error, or `undefined` when the keyword is carried
 */
function checkCarriedKeyword(
  keyword: string,
  keywordValue: unknown,
  path: string,
  allowed: AllowedKeywords
): SchemaConversionError | undefined {
  const kind = ANNOTATION_KEYWORDS.get(keyword) ?? allowed.constraints.get(keyword)
  if (kind === undefined) {
    const forType = allowed.typeName === undefined ? '' : ` for type '${allowed.typeName}'`
    return {
      ok: false,
      message: `Unsupported JSON Schema keyword '${keyword}'${forType} at ${path || 'root'}`,
      path
    }
  }
  const valueKind = KEYWORD_VALUE_KINDS[kind]
  if (!valueKind.accepts(keywordValue)) {
    return {
      ok: false,
      message: `'${keyword}' must be ${valueKind.description} at ${path || 'root'}`,
      path
    }
  }
  return undefined
}

/**
 * Converts a node without a type to an unconstrained schema.
 *
 * @remarks
 * Allowed only when the node carries nothing but annotations and meta keywords (e.g. `{}` or
 * `{ description }`).
 *
 * @param schema - the node
 * @param path - the node's path, for errors
 * @returns `Type.Unknown` with the annotations, or the error for any other keyword
 */
function convertUntyped(schema: Record<string, unknown>, path: string): SchemaConversionResult {
  const onlyAnnotations = Object.keys(schema).every(
    (keyword) => ANNOTATION_KEYWORDS.has(keyword) || META_KEYWORDS.has(keyword)
  )
  if (!onlyAnnotations) {
    return {
      ok: false,
      message: `Missing or invalid 'type' at ${path || 'root'}`,
      path
    }
  }
  const keywords = collectKeywords(schema, path, ANNOTATIONS_ONLY)
  return keywords.ok ? { ok: true, schema: Type.Unknown(keywords.opts) } : keywords
}

/**
 * Converts a node with a single `type` name through its {@link TYPE_CONVERTERS} entry.
 *
 * @param rawType - the `type` value
 * @param schema - the node
 * @param path - the node's path, for errors
 * @returns the TypeBox schema, or the error for an unsupported type or keyword
 */
function convertTyped(
  rawType: string,
  schema: Record<string, unknown>,
  path: string
): SchemaConversionResult {
  const converter = TYPE_CONVERTERS.get(rawType)
  if (converter === undefined) {
    return {
      ok: false,
      message: `Unsupported type '${rawType}' at ${path || 'root'}`,
      path
    }
  }
  const keywords = collectKeywords(schema, path, {
    structural: ['type', ...converter.structural],
    constraints: converter.constraints,
    typeName: rawType
  })
  return keywords.ok ? converter.convert(keywords.opts, schema, path) : keywords
}

/**
 * Converts `anyOf` to a TypeBox Union.
 *
 * @remarks
 * Supports nullable types (`anyOf: [{type: T}, {type: "null"}]`) and unions of supported
 * schemas, up to {@link MAX_ANY_OF_BRANCHES} branches. Branch paths are
 * `<path or root>.anyOf[i]`.
 *
 * @param branches - the `anyOf` array
 * @param path - the node's path, for errors
 * @param opts - the node's collected annotations and sibling `type`
 * @returns the union, or the error for an empty or too long array or a failing branch
 */
function convertAnyOf(
  branches: unknown[],
  path: string,
  opts: Record<string, unknown>
): SchemaConversionResult {
  if (branches.length === 0) {
    return { ok: false, message: `Empty 'anyOf' at ${path || 'root'}`, path }
  }
  if (branches.length > MAX_ANY_OF_BRANCHES) {
    return {
      ok: false,
      message: `'anyOf' with more than 10 branches is not supported at ${path || 'root'}`,
      path
    }
  }

  const converted: TSchema[] = []
  for (let branchIndex = 0; branchIndex < branches.length; branchIndex++) {
    // Same form as a property path: no `root` segment when the node is the root.
    const branchSegment = `anyOf[${String(branchIndex)}]`
    const branchPath = path.length > 0 ? `${path}.${branchSegment}` : branchSegment
    const result = convertSchema(branches[branchIndex], branchPath)
    if (!result.ok) {
      return result
    }
    converted.push(result.schema)
  }

  return { ok: true, schema: Type.Union(converted, opts) }
}

/**
 * Converts a string `enum` to a union of string literals.
 *
 * @param values - the `enum` array
 * @param path - the node's path, for errors
 * @param opts - the node's collected annotations and constraints
 * @returns the union, or the error for a non-string value or an empty enum
 */
function convertEnum(
  values: unknown[],
  path: string,
  opts: Record<string, unknown>
): SchemaConversionResult {
  const stringValues: string[] = []
  for (const enumValue of values) {
    if (typeof enumValue !== 'string') {
      return {
        ok: false,
        message: `Only string enums are supported at ${path || 'root'}`,
        path
      }
    }
    stringValues.push(enumValue)
  }
  if (stringValues.length === 0) {
    return {
      ok: false,
      message: `Empty enum at ${path || 'root'}`,
      path
    }
  }
  // A union of literals for the string enum
  const literals = stringValues.map((enumValue) => Type.Literal(enumValue))
  return { ok: true, schema: Type.Union(literals, opts) }
}

/**
 * Converts `type: [T, "null"]` to a union of `T` and null.
 *
 * @remarks
 * The annotations go on the union, everything else on the `T` branch, which is converted (and
 * checked) as if `type` were `T`.
 *
 * @param typeArray - the `type` array
 * @param schema - the node
 * @param path - the node's path, for errors
 * @returns the union, or the error for any other type array or a failing `T` branch
 */
function convertNullableType(
  typeArray: unknown[],
  schema: Record<string, unknown>,
  path: string
): SchemaConversionResult {
  const nonNullTypes = typeArray.filter((typeName) => typeName !== 'null')
  if (nonNullTypes.length !== 1 || typeArray.length !== NULLABLE_TYPE_ARRAY_LENGTH) {
    return {
      ok: false,
      message: `Only [type, "null"] nullable types are supported at ${path || 'root'}`,
      path
    }
  }

  const innerType = nonNullTypes[0]
  if (typeof innerType !== 'string') {
    return {
      ok: false,
      message: `Invalid nullable type at ${path || 'root'}`,
      path
    }
  }

  const annotationSchema: Record<string, unknown> = {}
  const innerSchema: Record<string, unknown> = {}
  for (const [keyword, keywordValue] of Object.entries(schema)) {
    if (ANNOTATION_KEYWORDS.has(keyword)) {
      annotationSchema[keyword] = keywordValue
    } else {
      innerSchema[keyword] = keywordValue
    }
  }
  innerSchema['type'] = innerType

  const annotations = collectKeywords(annotationSchema, path, ANNOTATIONS_ONLY)
  if (!annotations.ok) {
    return annotations
  }
  const innerResult = convertSchema(innerSchema, path)
  if (!innerResult.ok) {
    return innerResult
  }

  return {
    ok: true,
    schema: Type.Union([innerResult.schema, Type.Null()], annotations.opts)
  }
}

/**
 * Reads an object's `required` list.
 *
 * @param rawRequired - the `required` value, or `undefined` when the node has none
 * @returns the required property names (empty without `required`), or `undefined` when `required`
 *   is not an array of strings, which JSON Schema does not allow
 */
function collectRequiredNames(rawRequired: unknown): Set<string> | undefined {
  if (rawRequired === undefined) return new Set()
  if (!Array.isArray(rawRequired)) return undefined
  const requiredSet = new Set<string>()
  for (const requiredName of rawRequired) {
    if (typeof requiredName !== 'string') return undefined
    requiredSet.add(requiredName)
  }
  return requiredSet
}

/**
 * Converts an `object` node; properties not in `required` become optional.
 *
 * @remarks
 * Property paths are `<path>.<name>`, without a `properties` segment. A `required` that is not an
 * array of strings is refused rather than ignored: ignoring it would make every property optional,
 * a silent downgrade of the client's schema.
 *
 * @param schema - the node
 * @param path - the node's path, for errors
 * @param opts - the node's collected annotations and constraints
 * @returns the object schema (empty without `properties`), or the error for a non-object
 *   `properties`, a malformed `required` or a failing property
 */
function convertObject(
  schema: Record<string, unknown>,
  path: string,
  opts: Record<string, unknown>
): SchemaConversionResult {
  const requiredSet = collectRequiredNames(schema['required'])
  if (requiredSet === undefined) {
    return {
      ok: false,
      message: `'required' must be an array of property names at ${path || 'root'}`,
      path
    }
  }

  const rawProperties = schema['properties']

  // No properties: an empty object type
  if (rawProperties === undefined) {
    return { ok: true, schema: Type.Object({}, opts) }
  }

  if (!isRecord(rawProperties)) {
    return {
      ok: false,
      message: `'properties' must be an object at ${path || 'root'}`,
      path
    }
  }

  const typeboxProperties: Record<string, TSchema> = {}

  for (const [key, propSchema] of Object.entries(rawProperties)) {
    const propPath = path.length > 0 ? `${path}.${key}` : key
    const result = convertSchema(propSchema, propPath)
    if (!result.ok) {
      return result
    }
    typeboxProperties[key] = requiredSet.has(key) ? result.schema : Type.Optional(result.schema)
  }

  return { ok: true, schema: Type.Object(typeboxProperties, opts) }
}

/**
 * Converts an `array` node.
 *
 * @param schema - the node
 * @param path - the node's path, for errors; the item path is `<path>.items`
 * @param opts - the node's collected annotations and constraints
 * @returns the array schema (of unknown items without `items`), or the error for a failing
 *   `items` schema
 */
function convertArray(
  schema: Record<string, unknown>,
  path: string,
  opts: Record<string, unknown>
): SchemaConversionResult {
  const items = schema['items']
  if (items === undefined) {
    // No items schema: allow any items
    return { ok: true, schema: Type.Array(Type.Unknown(), opts) }
  }

  const itemPath = path.length > 0 ? `${path}.items` : 'items'
  const itemResult = convertSchema(items, itemPath)
  if (!itemResult.ok) {
    return itemResult
  }

  return { ok: true, schema: Type.Array(itemResult.schema, opts) }
}
