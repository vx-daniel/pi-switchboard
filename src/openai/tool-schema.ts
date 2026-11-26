/**
 * Checks the JSON Schema of OpenAI function tool parameters against the subset the proxy supports.
 *
 * @remarks
 * pi takes tool parameters as plain JSON Schema (pi 1.5: `Tool.parameters`, validated by pi with
 * `@earendil-works/pi-schema` where it validates at all; #360). So the client's schema goes to pi as
 * written, once it is checked here.
 *
 * Contract:
 * - Support a documented subset of JSON Schema only
 * - Reject unsupported schema constructs with a {@link ToolSchemaError}
 * - Do not silently downgrade schemas: every keyword is carried over, dropped as meta, or rejected
 * - Carry the schema as the client wrote it: no keyword is rewritten, and keys keep their order
 *
 * Supported subset:
 * - type: object, string, number, integer, boolean, array, null
 * - properties, required, items
 * - enum (string enums)
 * - nullable via type: [T, "null"]
 * - anyOf for nullable types and simple unions (max 10 branches); a sibling `type` is carried
 * - annotations on any node: description, title, default, examples, deprecated, readOnly, writeOnly
 * - constraints per type, carried over (see TYPE_RULES), also on a string enum:
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

import { proxyLogger } from '@proxy/logging'
import { isRecord } from '@proxy/utils/guards'

/** Accepted schema: the client's, without its meta keywords. */
export interface ToolSchemaSuccess {
  readonly ok: true
  readonly schema: Record<string, unknown>
}

/** Refused schema: why, and the path of the offending node. */
export interface ToolSchemaError {
  readonly ok: false
  readonly message: string
  readonly path: string
}

/** Outcome of {@link checkToolSchema}, discriminated on `ok`. */
export type ToolSchemaResult = ToolSchemaSuccess | ToolSchemaError

/**
 * Unsupported JSON Schema keywords rejected before anything else on a node.
 *
 * @remarks
 * `anyOf` is not here: it is supported for nullable types and simple unions.
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

/** Logger for JSON Schema checks. */
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

/** Annotations: allowed on any node, carried over. */
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

/** How one supported `type` is checked. */
interface TypeRule {
  /** Validation keywords, carried over. */
  readonly constraints: ReadonlyMap<string, KeywordValueKind>
  /** Keywords `check` reads itself, besides `type`. */
  readonly structural: readonly string[]
  /**
   * Checks the node's structural keywords.
   *
   * @param schema - the node, its other keywords already checked
   * @param path - the node's path, for errors
   * @returns the node as carried, or the error for the first unsupported construct below it
   */
  check(schema: Record<string, unknown>, path: string): ToolSchemaResult
}

/**
 * Checks a node of a type without children: nothing below it to check, so it is carried as
 * written.
 *
 * @param schema - the node, its keywords already checked
 * @returns the node as carried
 */
function checkLeaf(schema: Record<string, unknown>): ToolSchemaResult {
  return { ok: true, schema: carried(schema, {}) }
}

/** The rule for each supported `type`. */
const TYPE_RULES: ReadonlyMap<string, TypeRule> = new Map<string, TypeRule>([
  ['string', { constraints: STRING_CONSTRAINTS, structural: [], check: checkLeaf }],
  ['number', { constraints: NUMBER_CONSTRAINTS, structural: [], check: checkLeaf }],
  ['integer', { constraints: NUMBER_CONSTRAINTS, structural: [], check: checkLeaf }],
  ['boolean', { constraints: new Map([['const', 'json']]), structural: [], check: checkLeaf }],
  ['null', { constraints: NO_CONSTRAINTS, structural: [], check: checkLeaf }],
  [
    'array',
    {
      constraints: new Map([
        ['minItems', 'count'],
        ['maxItems', 'count'],
        ['uniqueItems', 'boolean']
      ]),
      structural: ['items'],
      check: checkArray
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
      check: checkObject
    }
  ]
])

/**
 * Checks a JSON Schema against the supported subset.
 *
 * @param schema - the JSON Schema, of any shape
 * @param path - the request path of the schema, prefixed to error paths; `''` for the root
 * @returns the schema as it goes to pi, or the error for the first unsupported construct
 */
export function checkToolSchema(schema: unknown, path = ''): ToolSchemaResult {
  const result = checkNode(schema, path)
  if (result.ok) {
    schemaLogger.trace('Accepted JSON Schema at {path}', { path: path || 'root' })
  } else {
    schemaLogger.debug('Rejected JSON Schema at {path}: {reason}', {
      path: result.path || 'root',
      reason: result.message
    })
  }
  return result
}

/**
 * Copies a node as the client wrote it, keys in their order, without its meta keywords.
 *
 * @param schema - the node
 * @param children - its checked structural keywords (`properties`, `items`, `anyOf`), by keyword,
 *   which replace the client's values
 * @returns the node as carried to pi
 */
function carried(
  schema: Record<string, unknown>,
  children: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  const node: Record<string, unknown> = {}
  for (const [keyword, keywordValue] of Object.entries(schema)) {
    if (META_KEYWORDS.has(keyword)) continue
    node[keyword] = Object.hasOwn(children, keyword) ? children[keyword] : keywordValue
  }
  return node
}

/**
 * Checks one schema node, dispatching on `anyOf`, `enum`, a `type` array, a `type` name or no
 * type.
 *
 * @param schema - the node, of any shape
 * @param path - the node's path, for errors
 * @returns the node as carried, or the error for the first unsupported construct
 */
function checkNode(schema: unknown, path: string): ToolSchemaResult {
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

  // anyOf: nullable types and simple type unions, e.g. anyOf: [{type: "string"}, {type: "null"}]
  const anyOf = schema['anyOf']
  if (Array.isArray(anyOf)) {
    return checkAnyOfNode(schema, anyOf, path)
  }

  const enumValues = schema['enum']
  if (Array.isArray(enumValues)) {
    return checkEnumNode(schema, enumValues, path)
  }

  return checkByType(schema, path)
}

/**
 * Checks a node with `anyOf`: the keywords beside it, then each branch.
 *
 * @param schema - the node
 * @param anyOf - its `anyOf` branches
 * @param path - the node's path, for errors
 * @returns the node as carried, or the error for the first unsupported construct
 */
function checkAnyOfNode(
  schema: Record<string, unknown>,
  anyOf: unknown[],
  path: string
): ToolSchemaResult {
  const error = checkKeywords(schema, path, {
    structural: ['anyOf'],
    constraints: ANY_OF_CONSTRAINTS
  })
  if (error !== undefined) return error
  const branches = checkAnyOf(anyOf, path)
  return branches.ok
    ? { ok: true, schema: carried(schema, { anyOf: branches.branches }) }
    : branches
}

/**
 * Checks a node with `enum`. A string enum may also carry its type's constraints (e.g. `format`),
 * and a `type` of `"string"` or `["string", "null"]`.
 *
 * @param schema - the node
 * @param enumValues - its `enum` values
 * @param path - the node's path, for errors
 * @returns the node as carried, or the error for the first unsupported construct
 */
function checkEnumNode(
  schema: Record<string, unknown>,
  enumValues: unknown[],
  path: string
): ToolSchemaResult {
  const enumType = schema['type']
  const typeError = enumType === undefined ? undefined : checkEnumType(enumType, path)
  if (typeError !== undefined) return typeError
  const error = checkKeywords(schema, path, {
    structural: ['enum', 'type'],
    constraints: enumType === 'string' ? STRING_CONSTRAINTS : NO_CONSTRAINTS,
    ...(typeof enumType === 'string' ? { typeName: enumType } : {})
  })
  if (error !== undefined) return error
  const valuesError = checkEnumValues(enumValues, path)
  return valuesError ?? { ok: true, schema: carried(schema, {}) }
}

/**
 * Checks the `type` beside an `enum`, which goes to pi as written (#363 review): only string
 * enums are supported, so it is `"string"` or `["string", "null"]`.
 *
 * @param enumType - the node's `type`
 * @param path - the node's path, for errors
 * @returns the error for any other `type`, or `undefined`
 */
function checkEnumType(enumType: unknown, path: string): ToolSchemaError | undefined {
  if (!KEYWORD_VALUE_KINDS.types.accepts(enumType)) {
    return {
      ok: false,
      message: `'type' must be ${KEYWORD_VALUE_KINDS.types.description} at ${path || 'root'}`,
      path
    }
  }
  const typeNames: unknown[] = Array.isArray(enumType) ? enumType : [enumType]
  const nullable =
    typeNames.length === NULLABLE_TYPE_ARRAY_LENGTH &&
    typeNames.includes('string') &&
    typeNames.includes('null')
  if (enumType === 'string' || nullable) return undefined
  return { ok: false, message: `Only string enums are supported at ${path || 'root'}`, path }
}

/**
 * Checks a node by its `type`: a `[T, "null"]` array, a type name, or none.
 *
 * @param schema - the node
 * @param path - the node's path, for errors
 * @returns the node as carried, or the error for the first unsupported construct
 */
function checkByType(schema: Record<string, unknown>, path: string): ToolSchemaResult {
  const rawType = schema['type']

  if (Array.isArray(rawType)) {
    return checkNullableType(rawType, schema, path)
  }

  if (typeof rawType !== 'string') {
    return checkUntyped(schema, path)
  }

  return checkTyped(rawType, schema, path)
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
): ToolSchemaError | undefined {
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

/** What a node may carry besides annotations and meta keywords. */
interface AllowedKeywords {
  /** Keywords the node's rule reads itself. */
  readonly structural: readonly string[]
  /** Validation keywords, carried over. */
  readonly constraints: ReadonlyMap<string, KeywordValueKind>
  /** The node's `type`, named in the error for a keyword it does not support. */
  readonly typeName?: string
}

/** Allowed keywords of a node that takes annotations only. */
const ANNOTATIONS_ONLY: AllowedKeywords = { structural: [], constraints: NO_CONSTRAINTS }

/**
 * Checks that every keyword of a node is allowed on it.
 *
 * @remarks
 * Meta keywords are allowed (logged at debug; {@link carried} drops them); anything else not
 * allowed is rejected, so nothing is lost silently.
 *
 * @param schema - the node
 * @param path - the node's path, for errors
 * @param allowed - the structural keywords and constraints the node may carry
 * @returns the error for the first keyword not allowed, or `undefined`
 */
function checkKeywords(
  schema: Record<string, unknown>,
  path: string,
  allowed: AllowedKeywords
): ToolSchemaError | undefined {
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
  }
  return undefined
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
): ToolSchemaError | undefined {
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
 * Checks a node without a type: an unconstrained schema.
 *
 * @remarks
 * Allowed only when the node carries nothing but annotations and meta keywords (e.g. `{}` or
 * `{ description }`).
 *
 * @param schema - the node
 * @param path - the node's path, for errors
 * @returns the node as carried, or the error for any other keyword
 */
function checkUntyped(schema: Record<string, unknown>, path: string): ToolSchemaResult {
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
  return checkKeywords(schema, path, ANNOTATIONS_ONLY) ?? { ok: true, schema: carried(schema, {}) }
}

/**
 * Checks a node with a single `type` name through its {@link TYPE_RULES} entry.
 *
 * @param rawType - the `type` value
 * @param schema - the node
 * @param path - the node's path, for errors
 * @returns the node as carried, or the error for an unsupported type or keyword
 */
function checkTyped(
  rawType: string,
  schema: Record<string, unknown>,
  path: string
): ToolSchemaResult {
  const rule = TYPE_RULES.get(rawType)
  if (rule === undefined) {
    return {
      ok: false,
      message: `Unsupported type '${rawType}' at ${path || 'root'}`,
      path
    }
  }
  const error = checkKeywords(schema, path, {
    structural: ['type', ...rule.structural],
    constraints: rule.constraints,
    typeName: rawType
  })
  return error ?? rule.check(schema, path)
}

/** Checked `anyOf` branches, as carried. */
type AnyOfResult = { readonly ok: true; readonly branches: unknown[] } | ToolSchemaError

/**
 * Checks `anyOf` branches.
 *
 * @remarks
 * Supports nullable types (`anyOf: [{type: T}, {type: "null"}]`) and unions of supported
 * schemas, up to {@link MAX_ANY_OF_BRANCHES} branches. Branch paths are
 * `<path or root>.anyOf[i]`.
 *
 * @param branches - the `anyOf` array
 * @param path - the node's path, for errors
 * @returns the branches as carried, or the error for an empty or too long array or a failing
 *   branch
 */
function checkAnyOf(branches: unknown[], path: string): AnyOfResult {
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

  const checked: unknown[] = []
  for (let branchIndex = 0; branchIndex < branches.length; branchIndex++) {
    // Same form as a property path: no `root` segment when the node is the root.
    const branchSegment = `anyOf[${String(branchIndex)}]`
    const branchPath = path.length > 0 ? `${path}.${branchSegment}` : branchSegment
    const result = checkNode(branches[branchIndex], branchPath)
    if (!result.ok) {
      return result
    }
    checked.push(result.schema)
  }
  return { ok: true, branches: checked }
}

/**
 * Checks the values of an `enum`: strings only, at least one.
 *
 * @param values - the `enum` array
 * @param path - the node's path, for errors
 * @returns the error for a non-string value or an empty enum, or `undefined`
 */
function checkEnumValues(values: unknown[], path: string): ToolSchemaError | undefined {
  if (values.some((enumValue) => typeof enumValue !== 'string')) {
    return {
      ok: false,
      message: `Only string enums are supported at ${path || 'root'}`,
      path
    }
  }
  if (values.length === 0) {
    return {
      ok: false,
      message: `Empty enum at ${path || 'root'}`,
      path
    }
  }
  return undefined
}

/**
 * Checks `type: [T, "null"]`.
 *
 * @remarks
 * The annotations are checked as annotations, everything else as if `type` were `T`. The node is
 * carried with its `type` array as written.
 *
 * @param typeArray - the `type` array
 * @param schema - the node
 * @param path - the node's path, for errors
 * @returns the node as carried, or the error for any other type array or a failing `T` node
 */
function checkNullableType(
  typeArray: unknown[],
  schema: Record<string, unknown>,
  path: string
): ToolSchemaResult {
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

  const annotationsError = checkKeywords(annotationSchema, path, ANNOTATIONS_ONLY)
  if (annotationsError !== undefined) {
    return annotationsError
  }
  const inner = checkNode(innerSchema, path)
  if (!inner.ok) {
    return inner
  }
  // The inner node's checked children (`properties`, `items`), with the `type` array as written.
  return { ok: true, schema: carried(schema, { ...inner.schema, type: typeArray }) }
}

/**
 * Reads an object's `required` list.
 *
 * @param rawRequired - the `required` value, or `undefined` when the node has none
 * @returns whether `required` is absent or an array of strings, the only forms JSON Schema allows
 */
function isRequiredList(rawRequired: unknown): boolean {
  return (
    rawRequired === undefined ||
    (Array.isArray(rawRequired) &&
      rawRequired.every((requiredName) => typeof requiredName === 'string'))
  )
}

/**
 * Checks an `object` node and each of its properties.
 *
 * @remarks
 * Property paths are `<path>.<name>`, without a `properties` segment. A `required` that is not an
 * array of strings is refused rather than passed on: a provider that ignored it would make every
 * property optional, a silent downgrade of the client's schema.
 *
 * @param schema - the node
 * @param path - the node's path, for errors
 * @returns the node as carried, or the error for a non-object `properties`, a malformed
 *   `required` or a failing property
 */
function checkObject(schema: Record<string, unknown>, path: string): ToolSchemaResult {
  if (!isRequiredList(schema['required'])) {
    return {
      ok: false,
      message: `'required' must be an array of property names at ${path || 'root'}`,
      path
    }
  }

  const rawProperties = schema['properties']
  if (rawProperties === undefined) {
    return { ok: true, schema: carried(schema, {}) }
  }
  if (!isRecord(rawProperties)) {
    return {
      ok: false,
      message: `'properties' must be an object at ${path || 'root'}`,
      path
    }
  }

  // Keys here are property names, not keywords: a property named `$id` is kept.
  const properties: Record<string, unknown> = {}
  for (const [key, propSchema] of Object.entries(rawProperties)) {
    const propPath = path.length > 0 ? `${path}.${key}` : key
    const result = checkNode(propSchema, propPath)
    if (!result.ok) {
      return result
    }
    properties[key] = result.schema
  }
  return { ok: true, schema: carried(schema, { properties }) }
}

/**
 * Checks an `array` node and its `items` schema.
 *
 * @param schema - the node
 * @param path - the node's path, for errors; the item path is `<path>.items`
 * @returns the node as carried (any items without `items`), or the error for a failing `items`
 *   schema
 */
function checkArray(schema: Record<string, unknown>, path: string): ToolSchemaResult {
  const items = schema['items']
  if (items === undefined) {
    return { ok: true, schema: carried(schema, {}) }
  }

  const itemPath = path.length > 0 ? `${path}.items` : 'items'
  const itemResult = checkNode(items, itemPath)
  if (!itemResult.ok) {
    return itemResult
  }
  return { ok: true, schema: carried(schema, { items: itemResult.schema }) }
}
