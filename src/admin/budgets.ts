/**
 * The admin UI's budgets (#366, #367): each project's budget per stats window, as
 * `proxy-config.json` holds it (`budgets`), and an editor's change to one project's, logged for
 * audit. Budgets are reported beside each project's usage and in the doctor; nothing refuses a
 * request past one.
 *
 * @packageDocumentation
 */

import { badRequest, fileUnusable, notWritten, type Refusal } from '@proxy/admin/answers'
import { type BudgetSchema, type Budgets, ProjectLabelSchema } from '@proxy/config/projects'
import { loadConfigFromFile, saveConfigToFile } from '@proxy/config/schema'
import { proxyLogger } from '@proxy/logging'
import type * as z from 'zod'

/** Logger for the changes operators make. */
const auditLogger = proxyLogger('admin', 'audit')

/** Decimals of a dollar amount in the audit line. */
const CENTS_DECIMALS = 2

/** One project's budget per window. */
type Budget = z.infer<typeof BudgetSchema>

/**
 * Describes a budget for the audit line: each window's amount, or `none`.
 *
 * @param budget - the budget, or `undefined` for none
 * @returns `week $50.00, all $150.00`, or `none`
 */
function budgetText(budget: Budget | undefined): string {
  const windows = Object.entries(budget ?? {}).flatMap(([window, amount]) =>
    amount === undefined ? [] : [`${window} $${amount.toFixed(CENTS_DECIMALS)}`]
  )
  return windows.length === 0 ? 'none' : windows.join(', ')
}

/**
 * Reads the budgets in the config file now.
 *
 * @returns project -> its budget
 */
export function readBudgets(): Budgets {
  return loadConfigFromFile().budgets
}

/** What setting a project's budget needs: who, which project, and the budget. */
export interface BudgetChange {
  /** The operator, an editor, for the audit line. */
  readonly login: string
  /** The project, as `X-Switchboard-Project` names it. */
  readonly project: string
  /** Its budget per window; no window removes the project's budget. */
  readonly budget: Budget
}

/**
 * Sets a project's budget for an editor, or removes it when no window has one.
 *
 * @param change - who, which project, and the budget
 * @returns why it was refused, or `undefined` when it was saved
 */
export function setBudget(change: BudgetChange): Refusal | undefined {
  if (!ProjectLabelSchema.safeParse(change.project).success) {
    return badRequest(
      'invalid_project',
      'A project is 1 to 64 characters: a letter or digit, then letters, digits and ._:/@-'
    )
  }
  const unusable = fileUnusable()
  if (unusable !== undefined) return unusable
  const config = loadConfigFromFile()
  const { [change.project]: before, ...others } = config.budgets
  const removing = Object.keys(change.budget).length === 0
  const budgets = removing ? others : { ...others, [change.project]: change.budget }
  if (!saveConfigToFile({ ...config, budgets })) return notWritten()
  auditLogger.info('{login} set the budget of {project}: {before} to {after}', {
    login: change.login,
    project: change.project,
    before: budgetText(before),
    after: budgetText(removing ? undefined : change.budget)
  })
  return undefined
}
