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
  collect(file.endOfFileToken.getFullStart())
  return [...comments.values()]
}

// Catches a disable comment anywhere, including one that names the rule meant to forbid it.
test('no tracked script disables or re-enables a lint rule in a comment', () => {
  const directives = trackedScripts().flatMap((path) =>
    commentsOf(path, readFileSync(join(REPOSITORY_ROOT, path), 'utf8'))
      .filter((comment) => LINT_DIRECTIVE.test(comment))
      .map((comment) => `${path}: ${comment}`)
  )

  expect(directives).toEqual([])
})
