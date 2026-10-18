/**
 * The repo lint rules (lint/repo-rules.ts) with no built-in Oxlint equivalent. Pins which
 * shapes each rule flags and which it deliberately leaves alone.
 */

import { RuleTester } from 'vite-plus/lint/plugins-dev'
import { describe, it } from 'vite-plus/test'

import repo from '../../lint/repo-rules'

RuleTester.describe = describe
RuleTester.it = it

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: 'ts' } } })

/** Looks up a repo rule by name, failing loudly if it is not registered. */
function rule(name: string): NonNullable<typeof repo.rules>[string] {
  const found = repo.rules[name]
  if (found === undefined) throw new Error(`repo/${name} is not defined`)
  return found
}

tester.run('no-enum', rule('no-enum'), {
  // Catches: flagging union types or `as const` objects, the sanctioned enum replacements.
  valid: ["type Kind = 'a' | 'b'", "const Kind = { a: 'a' } as const"],
  // Catches: plain and `const` enums slipping through.
  invalid: [
    { code: 'enum Kind { A }', errors: [{ messageId: 'noEnum' }] },
    { code: 'const enum Kind { A }', errors: [{ messageId: 'noEnum' }] }
  ]
})

tester.run('no-delete', rule('no-delete'), {
  // Catches: flagging other unary operators such as `typeof`, `void` or `!`.
  valid: ['const kind = typeof value', 'void run()', 'const off = !on'],
  // Catches: `delete` on a property or computed key going unreported.
  invalid: [
    { code: 'delete record.key', errors: [{ messageId: 'noDelete' }] },
    { code: 'delete record[key]', errors: [{ messageId: 'noDelete' }] }
  ]
})

tester.run('no-implicit-any-let', rule('no-implicit-any-let'), {
  valid: [
    // Catches: flagging a `let` that has an initializer or an annotation.
    'let count = 0',
    'let count: number',
    // Catches: flagging `const` (always initialized) or ambient `declare` bindings.
    'const count = 0',
    'declare let count',
    'declare var count',
    // Catches: flagging the for-in / for-of loop variable, which the iterable types.
    'for (let key in record) {}',
    'for (const item of items) {}',
    'for (let item of items) {}',
    // Catches: flagging declarators that each carry an initializer or annotation.
    'let first = 1, second: number'
  ],
  invalid: [
    // Catches: a bare `let` / `var` becoming implicit any unnoticed.
    { code: 'let count', errors: [{ messageId: 'noImplicitAnyLet' }] },
    { code: 'var count', errors: [{ messageId: 'noImplicitAnyLet' }] },
    // Catches: the for-loop exemption leaking into a classic `for` init or a body `let`.
    { code: 'for (let index; ; ) {}', errors: [{ messageId: 'noImplicitAnyLet' }] },
    { code: 'for (const item of items) { let copy }', errors: [{ messageId: 'noImplicitAnyLet' }] },
    // Catches: reporting only the first declarator, or the whole declaration, not each bare one.
    {
      code: 'let first, second = 2, third',
      errors: [
        { messageId: 'noImplicitAnyLet', column: 4, endColumn: 9 },
        { messageId: 'noImplicitAnyLet', column: 23, endColumn: 28 }
      ]
    }
  ]
})
