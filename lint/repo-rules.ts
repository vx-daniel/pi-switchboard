/**
 * Repo lint rules with no built-in Oxlint equivalent (carried over from the Biome config).
 *
 * @packageDocumentation
 */

import { definePlugin, defineRule } from 'vite-plus/lint/plugins'

/** `repo/no-enum`: flags every TypeScript `enum` declaration. */
const noEnum = defineRule({
  meta: { messages: { noEnum: 'Use a union or an `as const` object instead of an enum.' } },
  create(context) {
    return {
      TSEnumDeclaration(node) {
        context.report({ node, messageId: 'noEnum' })
      }
    }
  }
})

/** `repo/no-delete`: flags every `delete` expression. */
const noDelete = defineRule({
  meta: { messages: { noDelete: 'Avoid `delete`; assign `undefined` or build a new object.' } },
  create(context) {
    return {
      UnaryExpression(node) {
        if (node.operator === 'delete') context.report({ node, messageId: 'noDelete' })
      }
    }
  }
})

/**
 * `repo/no-implicit-any-let`: flags `let` and `var` declarators with neither a type annotation
 * nor an initializer.
 *
 * @remarks
 * `const`, `declare` declarations, and the left side of `for…in` / `for…of` are exempt.
 */
const noImplicitAnyLet = defineRule({
  meta: {
    messages: { noImplicitAnyLet: 'Give this variable a type annotation or an initializer.' }
  },
  create(context) {
    return {
      VariableDeclaration(node) {
        if (node.kind === 'const' || node.declare === true) return
        const parent = node.parent
        if (
          (parent.type === 'ForInStatement' || parent.type === 'ForOfStatement') &&
          parent.left === node
        ) {
          return
        }
        for (const declarator of node.declarations) {
          if (declarator.init === null && declarator.id.typeAnnotation == null) {
            context.report({ node: declarator, messageId: 'noImplicitAnyLet' })
          }
        }
      }
    }
  }
})

export default definePlugin({
  meta: { name: 'repo' },
  rules: {
    'no-enum': noEnum,
    'no-delete': noDelete,
    'no-implicit-any-let': noImplicitAnyLet
  }
})
