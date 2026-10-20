/**
 * Every declaration in scope carries a TSDoc comment with full tags (#101), and every doc comment
 * is valid TSDoc. oxlint's jsdoc rules check tags where a comment exists, but none requires a
 * comment, and its `require-returns` cannot see types, so this test owns presence and `@returns`.
 *
 * In scope: everything in `src`, `extensions`, `scripts`, `lint` and `vite.config.ts`, and every
 * non-test file under `test/` (fixtures, helpers, setup); in `*.test.ts` files, helper functions
 * only. A function needs a summary, `@param name - text` per named parameter, `@typeParam` per
 * type parameter, and `@returns` exactly when it returns a value. Types, interfaces, enums, classes
 * and top-level constants need a summary. A file comment needs `@packageDocumentation` (test files
 * excepted).
 * Object-literal members, inline callbacks, local lambdas and interface members are not required.
 */

import { spawnSync } from 'node:child_process'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import typescript from 'typescript'
import { expect, test } from 'vite-plus/test'

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/**
 * The repository-wide check builds one program over every file in scope and the dependency types
 * they import: about 2 s alone, 9 s under the gate's coverage and parallel load.
 */
const WHOLE_REPOSITORY_TIMEOUT_MS = 30_000

/**
 * Each sample check builds a program that loads TypeScript's library and the dependency types:
 * about 0.3 s alone for the first one, which parses them, and over 5 s (vitest's default) under the
 * gate's coverage and parallel load. Later samples reuse the parsed files ({@link LIBRARY_FILES}).
 */
const SAMPLE_PROGRAM_TIMEOUT_MS = 30_000

/**
 * Library and dependency source files parsed once and shared by every sample program: they never
 * change between samples, and parsing them is most of a sample's cost.
 */
const LIBRARY_FILES = new Map<string, typescript.SourceFile | undefined>()

/** Files whose every declaration is in scope: the code, and every non-test file under `test/`. */
const FULL_SCOPE =
  /^(?:(?:src|extensions|scripts|lint|test)\/(?!.*\.test\.ts$).+|vite\.config\.ts)$/u

/** Test files: only their helper functions are in scope. */
const TEST_FILE = /^test\/.+\.test\.ts$/u

/** The TSDoc standard tags; anything else (`@return`, `@type`, `@module`) is JSDoc or a typo. */
const TSDOC_TAGS = new Set([
  'alpha',
  'beta',
  'decorator',
  'defaultValue',
  'deprecated',
  'eventProperty',
  'example',
  'experimental',
  'inheritDoc',
  'internal',
  'label',
  'override',
  'packageDocumentation',
  'param',
  'privateRemarks',
  'public',
  'readonly',
  'remarks',
  'returns',
  'sealed',
  'see',
  'throws',
  'typeParam',
  'virtual'
])

/** Tags that name what they describe: `@param name - text`, `@typeParam T - text`. */
const NAMED_TAGS = new Set(['param', 'typeParam'])

/** The shape of a named tag: a name, then ` - `, then the description. */
const NAMED_TAG_FORMAT = /^[\w$.]+ - \S/u

/** Tags TSDoc types from the signature, so a `{type}` there is JSDoc. */
const UNTYPED_TAGS = new Set(['param', 'returns', 'throws'])

/** Tags that mean nothing without text. */
const DESCRIBED_TAGS = new Set([
  'deprecated',
  'example',
  'privateRemarks',
  'remarks',
  'returns',
  'see',
  'throws'
])

/** Return types that count as returning nothing: no `@returns` for these. */
const NOTHING =
  typescript.TypeFlags.Void | typescript.TypeFlags.Undefined | typescript.TypeFlags.Never

/** A block tag of a doc comment: its name without `@`, and its text up to the next tag. */
interface DocTag {
  readonly name: string
  readonly text: string
}

/** A doc comment split into its summary (the text before the first tag) and its block tags. */
interface DocComment {
  readonly summary: string
  readonly tags: readonly DocTag[]
}

/** A declaration that takes parameters and may need `@param`, `@typeParam` and `@returns`. */
type FunctionLike =
  | typescript.ArrowFunction
  | typescript.ConstructorDeclaration
  | typescript.FunctionDeclaration
  | typescript.FunctionExpression
  | typescript.GetAccessorDeclaration
  | typescript.MethodDeclaration
  | typescript.SetAccessorDeclaration

/** What the checks share for one file: where problems go and how to describe a node. */
interface FileCheck {
  readonly source: typescript.SourceFile
  readonly checker: typescript.TypeChecker
  readonly path: string
  readonly problems: string[]
}

/**
 * Splits a doc comment into its summary and block tags.
 *
 * @remarks
 * A tag starts its own line; an `@` inside a fenced example is text.
 *
 * @param raw - the comment, from its opening `/**` to its closing `*\/`
 * @returns the summary and tags
 */
function parseDocComment(raw: string): DocComment {
  const lines = raw
    .replace(/^\/\*\*/u, '')
    .replace(/\*\/$/u, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\* ?/u, ''))
  const summary: string[] = []
  const tags: { name: string; text: string }[] = []
  let inFence = false
  for (const line of lines) {
    if (/^\s*```/u.test(line)) inFence = !inFence
    const tag = inFence ? null : /^\s*@(\w+)\s*(.*)$/u.exec(line)
    const current = tags.at(-1)
    if (tag !== null) tags.push({ name: tag[1] ?? '', text: tag[2] ?? '' })
    else if (current === undefined) summary.push(line)
    else current.text += `\n${line}`
  }
  return { summary: summary.join('\n').trim(), tags }
}

/**
 * Finds the doc comment attached to a node: the last comment before it, if that is a `/**` one.
 *
 * @param node - the declaration
 * @param source - the file it is in
 * @returns the parsed comment, or undefined when the node has none
 */
function docCommentOf(
  node: typescript.Node,
  source: typescript.SourceFile
): DocComment | undefined {
  const last = typescript.getLeadingCommentRanges(source.text, node.getFullStart())?.at(-1)
  if (last === undefined) return undefined
  const text = source.text.slice(last.pos, last.end)
  return text.startsWith('/**') && !text.startsWith('/**/') ? parseDocComment(text) : undefined
}

/**
 * Records a problem against a node.
 *
 * @param check - the file being checked
 * @param node - the node the problem is on, for its line
 * @param name - the declaration's name
 * @param problem - what is wrong
 */
function report(check: FileCheck, node: typescript.Node, name: string, problem: string): void {
  const { line } = check.source.getLineAndCharacterOfPosition(node.getStart(check.source))
  check.problems.push(`${check.path}:${String(line + 1)} ${name}: ${problem}`)
}

/**
 * Lists what is wrong with one block tag, whatever it documents.
 *
 * @param tag - the tag
 * @returns the problems, empty when the tag is valid TSDoc
 */
function tagProblems(tag: DocTag): string[] {
  const problems: string[] = []
  const firstLine = tag.text.split('\n')[0] ?? ''
  if (!TSDOC_TAGS.has(tag.name)) problems.push(`@${tag.name} is not a TSDoc tag`)
  if (NAMED_TAGS.has(tag.name) && !NAMED_TAG_FORMAT.test(tag.text)) {
    problems.push(`@${tag.name} must read "@${tag.name} name - description": ${firstLine}`)
  }
  if (UNTYPED_TAGS.has(tag.name) && tag.text.trimStart().startsWith('{')) {
    problems.push(`@${tag.name} carries a {type}; TSDoc takes types from the signature`)
  }
  if (DESCRIBED_TAGS.has(tag.name) && tag.text.trim() === '') problems.push(`@${tag.name} is empty`)
  return problems
}

/**
 * Checks a declaration's doc comment: present, with a summary and valid tags.
 *
 * @param check - the file being checked
 * @param node - the node the comment attaches to
 * @param name - the declaration's name
 * @returns the comment, or undefined when it is missing
 */
function checkDocComment(
  check: FileCheck,
  node: typescript.Node,
  name: string
): DocComment | undefined {
  const comment = docCommentOf(node, check.source)
  if (comment === undefined) {
    report(check, node, name, 'no doc comment')
    return undefined
  }
  if (comment.summary === '') report(check, node, name, 'no summary before the first tag')
  for (const problem of comment.tags.flatMap(tagProblems)) report(check, node, name, problem)
  return comment
}

/**
 * Tells whether a function returns a value, from its signature's type.
 *
 * @param declaration - the function
 * @param checker - the program's type checker
 * @returns false for `void`, `undefined`, `never` and promises of those, and for constructors and
 * setters; true otherwise, type guards included
 */
function returnsValue(declaration: FunctionLike, checker: typescript.TypeChecker): boolean {
  if (
    typescript.isConstructorDeclaration(declaration) ||
    typescript.isSetAccessorDeclaration(declaration)
  ) {
    return false
  }
  const signature = checker.getSignatureFromDeclaration(declaration)
  if (signature === undefined) return false
  if (checker.getTypePredicateOfSignature(signature) !== undefined) return true
  const returned = checker.getReturnTypeOfSignature(signature)
  const settled = checker.getAwaitedType(returned) ?? returned
  const members = settled.isUnion() ? settled.types : [settled]
  return !members.every((member) => (member.flags & NOTHING) !== 0)
}

/**
 * Lists the tags a function's comment lacks or has to spare.
 *
 * @param comment - the function's doc comment
 * @param declaration - the function
 * @param checker - the program's type checker
 * @returns the problems, empty when the tags match the signature
 */
function functionTagProblems(
  comment: DocComment,
  declaration: FunctionLike,
  checker: typescript.TypeChecker
): string[] {
  const named = (tagName: string): string[] =>
    comment.tags.filter((tag) => tag.name === tagName).map((tag) => tag.text.split(/\s/u)[0] ?? '')
  const parameters = declaration.parameters.flatMap((parameter) =>
    typescript.isIdentifier(parameter.name) && parameter.name.text !== 'this'
      ? [parameter.name.text]
      : []
  )
  const typeParameters = (declaration.typeParameters ?? []).map((parameter) => parameter.name.text)
  const documented = named('param')
  const hasReturns = comment.tags.some((tag) => tag.name === 'returns')
  const needsReturns = returnsValue(declaration, checker)
  return [
    ...parameters
      .filter((parameterName) => !documented.includes(parameterName))
      .map((parameterName) => `no @param for ${parameterName}`),
    ...documented
      .filter((tagged) => !parameters.includes(tagged.split('.')[0] ?? ''))
      .filter(() => parameters.length === declaration.parameters.length)
      .map((tagged) => `@param ${tagged} names no parameter`),
    ...typeParameters
      .filter((typeName) => !named('typeParam').includes(typeName))
      .map((typeName) => `no @typeParam for ${typeName}`),
    ...(needsReturns && !hasReturns ? ['no @returns'] : []),
    ...(!needsReturns && hasReturns ? ['@returns on a function that returns nothing'] : [])
  ]
}

/**
 * Checks a function's doc comment, tags included.
 *
 * @param check - the file being checked
 * @param anchor - the node the comment attaches to (the `const` statement for a `const` function)
 * @param declaration - the function
 * @param name - the function's name
 */
function checkFunction(
  check: FileCheck,
  anchor: typescript.Node,
  declaration: FunctionLike,
  name: string
): void {
  const comment = checkDocComment(check, anchor, name)
  if (comment === undefined) return
  for (const problem of functionTagProblems(comment, declaration, check.checker)) {
    report(check, anchor, name, problem)
  }
}

/**
 * Finds the function a `const` holds, through `as`, `satisfies` and parentheses.
 *
 * @param declaration - the variable
 * @returns the arrow or function expression, or undefined when it holds something else
 */
function functionValue(
  declaration: typescript.VariableDeclaration
): typescript.ArrowFunction | typescript.FunctionExpression | undefined {
  let value = declaration.initializer
  while (
    value !== undefined &&
    (typescript.isAsExpression(value) ||
      typescript.isSatisfiesExpression(value) ||
      typescript.isParenthesizedExpression(value))
  ) {
    value = value.expression
  }
  return value !== undefined &&
    (typescript.isArrowFunction(value) || typescript.isFunctionExpression(value))
    ? value
    : undefined
}

/**
 * Checks a class and each of its methods, accessors and constructor (when it takes parameters).
 *
 * @param check - the file being checked
 * @param declaration - the class
 */
function checkClass(check: FileCheck, declaration: typescript.ClassDeclaration): void {
  const className = declaration.name?.text ?? 'default'
  checkDocComment(check, declaration, className)
  for (const member of declaration.members) {
    const withBody =
      (typescript.isMethodDeclaration(member) ||
        typescript.isGetAccessorDeclaration(member) ||
        typescript.isSetAccessorDeclaration(member)) &&
      member.body !== undefined
    if (withBody) checkFunction(check, member, member, `${className}.${member.name.getText()}`)
    if (typescript.isConstructorDeclaration(member) && member.parameters.length > 0) {
      checkFunction(check, member, member, `${className}.constructor`)
    }
  }
}

/**
 * Checks a top-level `const`/`let`: functions in full, other values for a summary (not in tests).
 *
 * @param check - the file being checked
 * @param statement - the variable statement
 * @param testFile - whether the file is a test, where only functions are in scope
 */
function checkVariables(
  check: FileCheck,
  statement: typescript.VariableStatement,
  testFile: boolean
): void {
  for (const declaration of statement.declarationList.declarations) {
    const name = declaration.name.getText()
    const value = functionValue(declaration)
    if (value !== undefined) checkFunction(check, statement, value, name)
    else if (!testFile) checkDocComment(check, statement, name)
  }
}

/**
 * Checks the file comment, when there is one: outside tests it must be a package comment.
 *
 * @param check - the file being checked
 */
function checkFileComment(check: FileCheck): void {
  const { text, statements } = check.source
  const first = typescript.getLeadingCommentRanges(text, 0)?.[0]
  if (first === undefined || !text.startsWith('/**', first.pos)) return
  const firstStatement = statements[0]
  const documentsFirstDeclaration =
    firstStatement !== undefined &&
    !typescript.isImportDeclaration(firstStatement) &&
    typescript.getLeadingCommentRanges(text, firstStatement.getFullStart())?.length === 1
  if (
    !documentsFirstDeclaration &&
    !text.slice(first.pos, first.end).includes('@packageDocumentation')
  ) {
    check.problems.push(`${check.path}:1 (file): file comment needs @packageDocumentation`)
  }
}

/**
 * Lists the TSDoc problems in the in-scope files of a program.
 *
 * @param program - the program the files are in
 * @param paths - the files to check, relative to the repository root
 * @returns one `path:line name: problem` line per problem, in file order
 */
function tsdocProblems(program: typescript.Program, paths: readonly string[]): string[] {
  const checker = program.getTypeChecker()
  const problems: string[] = []
  for (const path of paths) {
    const source = program.getSourceFile(join(REPOSITORY_ROOT, path))
    if (source === undefined) throw new Error(`${path} is not in the program`)
    const testFile = TEST_FILE.test(path)
    const check: FileCheck = { source, checker, path, problems }
    if (!testFile) checkFileComment(check)
    const visit = (node: typescript.Node, topLevel: boolean): void => {
      if (typescript.isFunctionDeclaration(node) && node.body !== undefined) {
        checkFunction(check, node, node, node.name?.text ?? 'default')
      } else if (typescript.isClassDeclaration(node) && !testFile) {
        checkClass(check, node)
      } else if (typescript.isVariableStatement(node) && topLevel) {
        checkVariables(check, node, testFile)
      } else if (
        topLevel &&
        !testFile &&
        (typescript.isInterfaceDeclaration(node) ||
          typescript.isTypeAliasDeclaration(node) ||
          typescript.isEnumDeclaration(node))
      ) {
        checkDocComment(check, node, node.name.text)
      }
      typescript.forEachChild(node, (child) => {
        visit(child, false)
      })
    }
    for (const statement of source.statements) visit(statement, true)
  }
  return problems
}

/**
 * Reads the repository's compiler options.
 *
 * @returns the options `tsconfig.json` sets, resolved against the repository root
 */
function compilerOptions(): typescript.CompilerOptions {
  const read = typescript.readConfigFile(
    join(REPOSITORY_ROOT, 'tsconfig.json'),
    typescript.sys.readFile
  )
  return typescript.parseJsonConfigFileContent(read.config, typescript.sys, REPOSITORY_ROOT).options
}

/**
 * Builds a program over source text that exists only in memory, for checking samples.
 *
 * @param files - file text by path relative to the repository root
 * @returns the program, with the real library and dependency types available
 */
function inMemoryProgram(files: Readonly<Record<string, string>>): typescript.Program {
  const options = compilerOptions()
  const virtual = new Map(
    Object.entries(files).map(([path, text]) => [join(REPOSITORY_ROOT, path), text])
  )
  const host = typescript.createCompilerHost(options)
  return typescript.createProgram([...virtual.keys()], options, {
    ...host,
    fileExists: (fileName) => virtual.has(fileName) || host.fileExists(fileName),
    readFile: (fileName) => virtual.get(fileName) ?? host.readFile(fileName),
    getSourceFile: (fileName, languageVersion, onError) => {
      const text = virtual.get(fileName)
      if (text !== undefined) {
        return typescript.createSourceFile(fileName, text, languageVersion, true)
      }
      if (!LIBRARY_FILES.has(fileName)) {
        LIBRARY_FILES.set(fileName, host.getSourceFile(fileName, languageVersion, onError))
      }
      return LIBRARY_FILES.get(fileName)
    }
  })
}

/**
 * Lists the TSDoc problems in sample files.
 *
 * @param files - file text by path relative to the repository root
 * @returns the problems, as {@link tsdocProblems} reports them
 */
function sampleProblems(files: Readonly<Record<string, string>>): string[] {
  return tsdocProblems(inMemoryProgram(files), Object.keys(files))
}

/**
 * Lists the tracked files in scope, untracked new files included.
 *
 * @returns paths relative to the repository root
 */
function filesInScope(): string[] {
  const listing = spawnSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '*.ts'],
    { cwd: REPOSITORY_ROOT, encoding: 'utf8' }
  )
  if (listing.status !== 0) throw new Error(`git ls-files failed: ${listing.stderr}`)
  return listing.stdout
    .split('\0')
    .filter((path) => FULL_SCOPE.test(path) || TEST_FILE.test(path))
    .map((path) => relative(REPOSITORY_ROOT, join(REPOSITORY_ROOT, path)))
}

// Catches a checker that finds nothing, which would let the repository-wide test pass whatever the
// code says: one sample per rule, each reported once.
test(
  'reports each kind of TSDoc problem',
  () => {
    const source = [
      '/** A file comment without the package tag. */',
      "import { join } from 'node:path'",
      '',
      'export const UNDOCUMENTED = 1',
      '',
      '/**',
      ' * Joins badly.',
      ' * @param {string} left the left',
      ' * @param gone - not a parameter',
      ' * @return the path',
      ' */',
      'export function badTags(left: string): string {',
      '  return join(left)',
      '}',
      '',
      '/**',
      ' * @returns nothing',
      ' */',
      'export function noSummary(): void {}',
      '',
      '/** Identity, untagged. */',
      'export const identity = <T,>(value: T): T => value',
      '',
      '/**',
      ' * A guard with a bare remarks tag.',
      ' * @remarks',
      ' */',
      'export function isText(value: unknown): value is string {',
      "  return typeof value === 'string'",
      '}',
      '',
      'export interface Shape { readonly side: number }',
      '',
      '/** A class. */',
      'export class Box {',
      '  method(size: number): number {',
      '    return size',
      '  }',
      '}'
    ].join('\n')

    expect(sampleProblems({ 'src/sample.ts': source })).toEqual([
      'src/sample.ts:1 (file): file comment needs @packageDocumentation',
      'src/sample.ts:4 UNDOCUMENTED: no doc comment',
      'src/sample.ts:12 badTags: @param must read "@param name - description": {string} left the left',
      'src/sample.ts:12 badTags: @param carries a {type}; TSDoc takes types from the signature',
      'src/sample.ts:12 badTags: @return is not a TSDoc tag',
      'src/sample.ts:12 badTags: no @param for left',
      'src/sample.ts:12 badTags: @param {string} names no parameter',
      'src/sample.ts:12 badTags: @param gone names no parameter',
      'src/sample.ts:12 badTags: no @returns',
      'src/sample.ts:19 noSummary: no summary before the first tag',
      'src/sample.ts:19 noSummary: @returns on a function that returns nothing',
      'src/sample.ts:22 identity: no @param for value',
      'src/sample.ts:22 identity: no @typeParam for T',
      'src/sample.ts:22 identity: no @returns',
      'src/sample.ts:28 isText: @remarks is empty',
      'src/sample.ts:28 isText: no @param for value',
      'src/sample.ts:28 isText: no @returns',
      'src/sample.ts:32 Shape: no doc comment',
      'src/sample.ts:36 Box.method: no doc comment'
    ])
  },
  SAMPLE_PROGRAM_TIMEOUT_MS
)

// Catches false positives that would demand meaningless tags: no `@returns` for void, async void
// or a void call's result, one `@param` for a destructured parameter, and nothing for object-literal
// members, callbacks and local lambdas.
test(
  'accepts complete TSDoc and leaves out-of-scope functions alone',
  () => {
    const source = [
      '/**',
      ' * A sample module.',
      ' *',
      ' * @packageDocumentation',
      ' */',
      '',
      'declare function done(value: string): void',
      '',
      '/**',
      ' * Finishes.',
      ' *',
      ' * @param value - the value',
      ' */',
      'export const finish = (value: string): void => done(value)',
      '',
      '/**',
      ' * Waits.',
      ' *',
      ' * @param count - how many',
      ' */',
      'export async function wait(count: number): Promise<void> {',
      '  await Promise.resolve(count)',
      '}',
      '',
      '/**',
      ' * Reads options.',
      ' *',
      ' * @remarks',
      ' * An `@param` inside a fence is text:',
      ' * ```ts',
      ' * @param nothing',
      ' * ```',
      ' * @param options - the options',
      ' * @returns the size',
      ' */',
      'export function size({ width }: { width: number }): number {',
      '  const double = (value: number): number => value * 2',
      '  return double(width)',
      '}',
      '',
      '/** Handlers by name. */',
      'export const HANDLERS = {',
      '  go: (value: string): number => value.length',
      '}'
    ].join('\n')

    expect(sampleProblems({ 'src/sample.ts': source })).toEqual([])
  },
  SAMPLE_PROGRAM_TIMEOUT_MS
)

// Catches the test-file scope drifting: constants and the file comment are free, helper functions,
// at any depth, are not.
test(
  'in a test file, only helper functions are in scope',
  () => {
    const source = [
      '/** A test file comment needs no package tag. */',
      'const LIMIT = 3',
      'let current = 0',
      '',
      'function helper(value: number): number {',
      '  return value + LIMIT + current',
      '}',
      '',
      'export const run = (): void => {',
      '  function nested(): void {}',
      '  nested()',
      '}'
    ].join('\n')

    expect(sampleProblems({ 'test/unit/sample.test.ts': source })).toEqual([
      'test/unit/sample.test.ts:5 helper: no doc comment',
      'test/unit/sample.test.ts:9 run: no doc comment',
      'test/unit/sample.test.ts:10 nested: no doc comment'
    ])
  },
  SAMPLE_PROGRAM_TIMEOUT_MS
)

// Catches a declaration in scope without a valid TSDoc comment, anywhere in the repository.
test(
  'every declaration in scope has a valid TSDoc comment',
  () => {
    const paths = filesInScope()
    const program = typescript.createProgram(
      paths.map((path) => join(REPOSITORY_ROOT, path)),
      compilerOptions()
    )

    expect(tsdocProblems(program, paths)).toEqual([])
  },
  WHOLE_REPOSITORY_TIMEOUT_MS
)
