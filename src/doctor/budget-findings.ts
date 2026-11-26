/**
 * The doctor's budget check (#366): each project's spend in the window against its budget in
 * `proxy-config.json`. Part of the general section; `judgeDoctorInputs` adds it, so the CLI, the
 * console's Doctor view and the admin UI report it alike.
 *
 * @remarks
 * Budgets are reported, never enforced (constitution principle VI keeps refusing requests a
 * decision of its own), so a project past its budget is a warning, not an error: the doctor's
 * exit status doesn't change.
 *
 * @packageDocumentation
 */

import type { Budgets } from '@proxy/config/projects'
import type { Finding } from '@proxy/doctor/findings'
import type { ProjectStats } from '@proxy/stats/project-store'
import type { StatsWindow } from '@proxy/stats/windows'

/** A project's spend past this share of its budget is worth knowing before it is spent. */
const BUDGET_NEAR_SHARE = 0.8
/** Percent in a whole. */
const PERCENT = 100
/** Decimals of a dollar figure. */
const CENTS_DECIMALS = 2

/** What the budget check judges. */
export interface BudgetInputs {
  /** The budgets in `proxy-config.json`. */
  readonly budgets: Budgets
  /** Each project's numbers in the window. */
  readonly projects: readonly ProjectStats[]
  /** The window both are for. */
  readonly window: StatsWindow
}

/**
 * Judges each project's spend in the window against its budget for the window: past it a
 * warning, from {@link BUDGET_NEAR_SHARE} of it advice. A project without a budget for the window
 * isn't judged.
 *
 * @param inputs - the budgets, each project's spend in the window, and the window
 * @returns the findings
 */
export function budgetFindings(inputs: BudgetInputs): Finding[] {
  return inputs.projects.flatMap((project): Finding[] => {
    const budget = inputs.budgets[project.project]?.[inputs.window]
    if (budget === undefined || project.costUsd < budget * BUDGET_NEAR_SHARE) return []
    const spent = `$${project.costUsd.toFixed(CENTS_DECIMALS)} of its $${budget.toFixed(CENTS_DECIMALS)} budget for ${inputs.window}`
    if (project.costUsd > budget) {
      return [
        {
          check: 'budget',
          severity: 'warning',
          subject: project.project,
          message: `${project.project} has spent ${spent}.`,
          recommendation:
            'Raise the budget in proxy-config.json (budgets), or look at what the project sends; nothing is refused.'
        }
      ]
    }
    return [
      {
        check: 'budget',
        severity: 'advice',
        subject: project.project,
        message: `${project.project} has spent ${spent}: ${String(Math.round((project.costUsd / budget) * PERCENT))}%.`,
        recommendation: 'Nothing to do yet: a budget is reported, never enforced.'
      }
    ]
  })
}
