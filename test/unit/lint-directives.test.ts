/**
 * No inline lint directives anywhere in the repository (AGENTS.md): a rule that fails is fixed in
 * the code, never switched off. A lint rule cannot enforce this, because the directive it bans
 * would switch that rule off too, so this test reads every tracked script's comments itself.
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
 * A comment that switches lint rules off or back on: `oxlint-` or `eslint-` followed by `disable`,
 * `disable-line`, `disable-next-line` or `enable`. As in ESLint, only a comment that starts with
 * one is a directive, so prose that mentions them is not.
 */
const LINT_DIRECTIVE = /^(?:\/\/|\/\*)\s*(?:oxlint|eslint)-(?:disable|enable)\b/

/** Every tracked script file, relative to the repository root. */
function trackedScripts(): string[] {
  const listing = spawnSync('git', ['ls-files', '-z'], { cwd: REPOSITORY_ROOT, encoding: 'utf8' })
  if (listing.status !== 0) throw new Error(`git ls-files failed: ${listing.stderr}`)
  return listing.stdout.split('\0').filter((path) => SCRIPT_FILE.test(path))
}

/** The text of every comment in `source`, each once, in no particular order. */
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

/** The lint directives in `source`: its comments that start with one, sorted. */
function directivesIn(path: string, source: string): string[] {
  return commentsOf(path, source)
    .filter((comment) => LINT_DIRECTIVE.test(comment))
    .toSorted()
}

// Catches a detector that finds nothing, which would let the repository-wide test below pass
// whatever the code says: each form oxlint obeys, including one naming the rule meant to forbid it.
test('finds every form of directive oxlint obeys', () => {
  const source = [
    '/* oxlint-disable */',
    'export const first = 1 // oxlint-disable-line no-magic-numbers',
    '/* eslint-disable repo/no-enum */',
    '// oxlint-disable-next-line no-magic-numbers',
    'export const second = 2',
    '// eslint-enable'
  ].join('\n')

  expect(directivesIn('sample.ts', source)).toEqual([
    '/* eslint-disable repo/no-enum */',
    '/* oxlint-disable */',
    '// eslint-enable',
    '// oxlint-disable-line no-magic-numbers',
    '// oxlint-disable-next-line no-magic-numbers'
  ])
})

// Catches false positives that would block legitimate code: directive text that is not a comment,
// prose that mentions one, and a doc comment, which oxlint does not read as a directive.
test('leaves strings, regular expressions, prose and doc comments alone', () => {
  const source = [
    "export const text = '// oxlint-disable-next-line not-a-comment'",
    'export const pattern = /\\/\\/ eslint-disable x/',
    '// prose that mentions oxlint-disable is not a directive',
    '/** oxlint-disable no-magic-numbers */',
    'export const value = 1'
  ].join('\n')

  expect(directivesIn('sample.ts', source)).toEqual([])
})

// Catches a disable comment anywhere in the repository.
test('no tracked script disables or re-enables a lint rule in a comment', () => {
  const directives = trackedScripts().flatMap((path) =>
    directivesIn(path, readFileSync(join(REPOSITORY_ROOT, path), 'utf8')).map(
      (comment) => `${path}: ${comment}`
    )
  )

  expect(directives).toEqual([])
})
