/**
 * No inline lint or fallow directives anywhere in the repository (CONSTITUTION.md, principle
 * II): a rule that fails is fixed in the code, never switched off, and fallow's exceptions live
 * in `.fallowrc.jsonc` with their reasons (#83). A lint rule cannot enforce this, because the
 * directive it bans would switch that rule off too, so this test reads every tracked script's
 * comments itself.
 *
 * Comments come from TypeScript's parser, so a directive inside a string or a regular expression
 * (a lint rule's test fixture, say) is not a comment and is not flagged.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import typescript from 'typescript'
import { expect, test } from 'vite-plus/test'

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** The script files TypeScript can parse: TypeScript and JavaScript, as ES modules or CommonJS. */
const SCRIPT_FILE = /\.[cm]?[jt]sx?$/

/**
 * A comment that switches a check off or back on: `oxlint-` or `eslint-` followed by `disable`,
 * `disable-line`, `disable-next-line` or `enable`, or fallow's `fallow-ignore-next-line` and
 * `fallow-ignore-file`. As in ESLint, only a comment that starts with one is a directive, and
 * only a `//` or `/* … *\/` comment: neither tool reads one in a doc comment, nor prose that
 * mentions it.
 */
const DIRECTIVE = /^(?:\/\/|\/\*)\s*(?:(?:oxlint|eslint)-(?:disable|enable)|fallow-ignore)\b/

/**
 * fallow's JSDoc tag for an export kept on purpose, which hides it from the unused-export check.
 * It counts where a JSDoc tag goes, opening the doc comment or one of its lines; mentioned
 * mid-sentence, it is prose.
 */
const EXPECTED_UNUSED_TAG = /(?:^\/\*\*|\n\s*\*)\s*@expected-unused\b/

/**
 * Lists every script file git tracks.
 *
 * @returns the paths, relative to the repository root
 * @throws Error when `git ls-files` fails
 */
function trackedScripts(): string[] {
  const listing = spawnSync('git', ['ls-files', '-z'], { cwd: REPOSITORY_ROOT, encoding: 'utf8' })
  if (listing.status !== 0) throw new Error(`git ls-files failed: ${listing.stderr}`)
  return listing.stdout.split('\0').filter((path) => SCRIPT_FILE.test(path))
}

/**
 * Collects the text of every comment in `source`, each once, in no particular order.
 *
 * @param path - the file name TypeScript's parser is given for `source`
 * @param source - the file's text
 * @returns each comment's full text, delimiters included
 */
function commentsOf(path: string, source: string): string[] {
  const file = typescript.createSourceFile(path, source, typescript.ScriptTarget.Latest, false)
  const comments = new Map<number, string>()
  const collect = (position: number): void => {
    for (const range of [
      ...(typescript.getLeadingCommentRanges(source, position) ?? []),
      ...(typescript.getTrailingCommentRanges(source, position) ?? [])
    ]) {
      comments.set(range.pos, source.slice(range.pos, range.end))
    }
  }
  const visit = (node: typescript.Node): void => {
    collect(node.getFullStart())
    collect(node.getEnd())
    typescript.forEachChild(node, visit)
  }
  visit(file)
  return [...comments.values()]
}

/**
 * Finds the directives in `source`: its comments that are, or carry, one.
 *
 * @param path - the file name TypeScript's parser is given for `source`
 * @param source - the file's text
 * @returns the matching comments' full text, sorted
 */
function directivesIn(path: string, source: string): string[] {
  return commentsOf(path, source)
    .filter((comment) => DIRECTIVE.test(comment) || EXPECTED_UNUSED_TAG.test(comment))
    .toSorted()
}

// Catches a detector that finds nothing, which would let the repository-wide test below pass
// whatever the code says: each form oxlint or fallow obeys, including one naming the rule meant to
// forbid it.
test('finds every form of directive oxlint and fallow obey', () => {
  const source = [
    '/* oxlint-disable */',
    'export const first = 1 // oxlint-disable-line no-magic-numbers',
    '/* eslint-disable repo/no-enum */',
    '// oxlint-disable-next-line no-magic-numbers',
    'export const second = 2',
    '// eslint-enable',
    '// fallow-ignore-next-line unused-export',
    '/* fallow-ignore-file */',
    '/** @expected-unused */',
    'export const third = 3',
    '/**',
    ' * A helper.',
    ' * @expected-unused',
    ' */',
    'export const fourth = 4'
  ].join('\n')

  expect(directivesIn('sample.ts', source)).toEqual([
    '/* eslint-disable repo/no-enum */',
    '/* fallow-ignore-file */',
    '/* oxlint-disable */',
    '/**\n * A helper.\n * @expected-unused\n */',
    '/** @expected-unused */',
    '// eslint-enable',
    '// fallow-ignore-next-line unused-export',
    '// oxlint-disable-line no-magic-numbers',
    '// oxlint-disable-next-line no-magic-numbers'
  ])
})

// Catches false positives that would block legitimate code: directive text that is not a comment,
// prose that mentions one, and doc comments, which neither tool reads as a directive (measured on
// fallow 3.34.1: a doc-comment fallow-ignore suppresses nothing).
test('leaves strings, regular expressions, prose and doc comments alone', () => {
  const source = [
    "export const text = '// oxlint-disable-next-line not-a-comment'",
    'export const pattern = /\\/\\/ eslint-disable x/',
    '// prose that mentions oxlint-disable or fallow-ignore is not a directive',
    '/** oxlint-disable no-magic-numbers */',
    '/** fallow-ignore-next-line unused-export */',
    '/** Unlike the @expected-unused tag, this keeps the export checked. */',
    'export const value = 1'
  ].join('\n')

  expect(directivesIn('sample.ts', source)).toEqual([])
})

// Catches an inline lint or fallow directive in any tracked script.
test('no tracked script disables or re-enables a lint rule in a comment', () => {
  const directives = trackedScripts().flatMap((path) =>
    directivesIn(path, readFileSync(join(REPOSITORY_ROOT, path), 'utf8')).map(
      (comment) => `${path}: ${comment}`
    )
  )

  expect(directives).toEqual([])
})
