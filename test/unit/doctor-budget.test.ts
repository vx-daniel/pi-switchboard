import { budgetFindings } from '@proxy/doctor/budget-findings'
import type { ProjectStats } from '@proxy/stats/project-store'
import { describe, expect, test } from 'vite-plus/test'

/**
 * Builds a project's numbers with the given spend.
 *
 * @param project - the project
 * @param costUsd - what it spent
 * @returns its numbers
 */
function spent(project: string, costUsd: number): ProjectStats {
  return {
    project,
    requests: 1,
    failed: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd
  }
}

describe('the doctor budget check', () => {
  // Catches a project past its budget left unreported, one well under it flagged, the budget of
  // another window used, or a project without a budget judged at all (#366).
  test('warns about a project past its budget, and advises from 80% of it', () => {
    const findings = budgetFindings({
      budgets: {
        'over': { week: 10 },
        'near': { week: 10 },
        'under': { week: 10 },
        'other-window': { today: 1 }
      },
      projects: [
        spent('over', 12),
        spent('near', 8),
        spent('under', 7.9),
        spent('other-window', 5),
        spent('unbudgeted', 500)
      ],
      window: 'week'
    })

    expect(findings).toEqual([
      {
        check: 'budget',
        severity: 'warning',
        subject: 'over',
        message: 'over has spent $12.00 of its $10.00 budget for week.',
        recommendation: expect.stringContaining('nothing is refused')
      },
      expect.objectContaining({
        check: 'budget',
        severity: 'advice',
        subject: 'near',
        message: 'near has spent $8.00 of its $10.00 budget for week: 80%.'
      })
    ])
  })
})
