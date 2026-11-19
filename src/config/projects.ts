/**
 * Projects (#366): the label a client sends in `X-Switchboard-Project` to have its usage counted
 * apart, and the budgets `proxy-config.json` sets per project and stats window.
 *
 * @remarks
 * A label is short and plain (letters, digits and `._:/@-`, starting with a letter or digit), so
 * it can't be mistaken for the stats' own rows (`(other)`), nor carry anything a log or a console
 * would render. A budget is in US dollars, as the stats price each request, for any of the stats
 * windows; it is reported, never enforced.
 *
 * @packageDocumentation
 */

import * as z from 'zod'

/** The longest project label: room for `owner/repository`. */
export const MAX_PROJECT_LENGTH = 64

/** What a project label may hold: a letter or digit, then letters, digits and `._:/@-`. */
const PROJECT_PATTERN = /^[A-Za-z0-9][\w.:/@-]*$/u

/** A project label, as a client sends it and as `budgets` names it. */
export const ProjectLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_PROJECT_LENGTH)
  .regex(
    PROJECT_PATTERN,
    'A project starts with a letter or digit; then letters, digits and ._:/@-'
  )

/** One project's budget, in US dollars, for any of the stats windows. */
export const BudgetSchema = z
  .object({
    /** Since midnight, local time. */
    today: z.number().positive().optional(),
    /** The last 7 days. */
    week: z.number().positive().optional(),
    /** The last 30 days: everything the stats keep. */
    all: z.number().positive().optional()
  })
  .strict()

/** Project -> its budget (`budgets`). */
export const BudgetsSchema = z.record(ProjectLabelSchema, BudgetSchema).readonly()

/** Project -> its budget. */
export type Budgets = z.infer<typeof BudgetsSchema>
