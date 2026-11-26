/**
 * The Stats dashboard's PROJECTS panel (#366): each project's requests, failures and cost over
 * the window, beside its budget for the window and the share of it spent. Shown when a request
 * named a project (`X-Switchboard-Project`, read only with proxy auth on) or a project has a
 * budget for the window.
 *
 * @remarks
 * The share is coloured as the doctor's budget check judges it: a warning from 80%, an error past
 * the budget. Budgets are reported, never enforced, so nothing here stops a request.
 *
 * @packageDocumentation
 */

import type { BudgetedProject } from '@proxy/stats/project-store'
import { compactCount, usd } from '@proxy/tui/panel'
import { fitLabel, tableLines } from '@proxy/tui/stats-view'
import { type ConsoleColor, paint } from '@proxy/tui/theme'

/** Percent in a whole. */
const PERCENT = 100
/** From this share of its budget a project's share is a warning, as the doctor's advice starts. */
const NEAR_SHARE = 0.8
/** The label column's narrowest width. */
const LABEL_LEAST = 12

/** The panel's number columns. */
const PROJECT_COLUMNS: readonly {
  readonly title: string
  readonly width: number
  readonly cell: (project: BudgetedProject) => string
}[] = [
  { title: 'req', width: 7, cell: (project) => compactCount(project.requests) },
  { title: 'fail', width: 5, cell: (project) => compactCount(project.failed) },
  { title: 'cost', width: 8, cell: (project) => usd(project.costUsd) },
  {
    title: 'budget',
    width: 8,
    cell: (project) => (project.budgetUsd === null ? '-' : usd(project.budgetUsd))
  },
  {
    title: 'used',
    width: 5,
    cell: (project) =>
      project.budgetUsd === null
        ? '-'
        : `${String(Math.round((project.costUsd / project.budgetUsd) * PERCENT))}%`
  }
]

/** Which column is the share used, coloured by how near the budget it is. */
const USED_COLUMN = PROJECT_COLUMNS.length - 1

/**
 * Picks the share's colour: past the budget an error, near it a warning.
 *
 * @param project - the project
 * @returns the colour, or `undefined` for none
 */
function usedColor(project: BudgetedProject): ConsoleColor | undefined {
  if (project.budgetUsd === null) return undefined
  if (project.costUsd > project.budgetUsd) return 'error'
  return project.costUsd >= project.budgetUsd * NEAR_SHARE ? 'warning' : undefined
}

/**
 * Renders the PROJECTS panel's lines: a heading, then one row per project, most spent first,
 * fitted to the room left.
 *
 * @param projects - each project with its budget for the window
 * @param room - the rows the projects may take
 * @param width - the content's columns
 * @returns the lines
 */
export function projectLines(
  projects: readonly BudgetedProject[],
  room: number,
  width: number
): string[] {
  const numbers = PROJECT_COLUMNS.reduce((total, column) => total + column.width + 1, 0)
  const labelWidth = Math.max(LABEL_LEAST, width - numbers)
  const titles = PROJECT_COLUMNS.map((column) => column.title.padStart(column.width)).join(' ')
  const head = paint('dim', `${fitLabel('project', labelWidth)} ${titles}`)
  const rows = projects.map((project) => {
    const cells = PROJECT_COLUMNS.map((column) => column.cell(project).padStart(column.width))
    const color = usedColor(project)
    if (color !== undefined) cells[USED_COLUMN] = paint(color, cells[USED_COLUMN] ?? '')
    return `${fitLabel(project.project, labelWidth)} ${cells.join(' ')}`
  })
  return tableLines(head, rows, room)
}
