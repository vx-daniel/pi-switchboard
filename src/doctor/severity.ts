/**
 * How much a doctor finding matters (#299), and the order findings are listed in: errors, then
 * warnings, then advice. Shared by the findings, their summary and the budget check.
 *
 * @packageDocumentation
 */

/** How much a finding matters: only a general `error` fails the doctor (exit status 1). */
export type Severity = 'error' | 'warning' | 'advice'

/** Severity order, most serious first. */
const SEVERITY_RANK: Readonly<Record<Severity, number>> = { error: 0, warning: 1, advice: 2 }

/**
 * Sorts findings by severity, keeping each severity's order.
 *
 * @typeParam Ranked - what is sorted: anything with a severity
 * @param findings - the findings
 * @returns them, errors first
 */
export function bySeverity<Ranked extends { readonly severity: Severity }>(
  findings: readonly Ranked[]
): Ranked[] {
  return findings.toSorted(
    (left, right) => SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity]
  )
}
