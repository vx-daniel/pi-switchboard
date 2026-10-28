/**
 * How the doctor's findings are summed up in text, the same in `pi-switchboard doctor`'s output
 * (#299) and the console's Doctor view (#325): each severity's label, the counts, and one list of
 * both sections, errors first.
 *
 * @packageDocumentation
 */

import { bySeverity, type DoctorReport, type Finding, type Severity } from '@proxy/doctor/findings'

/** A severity's label in the text output, the CLI's and the console's Doctor view's. */
export const SEVERITY_LABEL: Readonly<Record<Severity, string>> = {
  error: 'ERROR',
  warning: 'WARNING',
  advice: 'ADVICE'
}

/** The plural of each severity's word, for {@link findingCounts}. */
const SEVERITY_PLURAL: Readonly<Record<Severity, string>> = {
  error: 'errors',
  warning: 'warnings',
  advice: 'advice'
}

/**
 * Counts findings by severity: `1 error, 2 warnings, 0 advice`.
 *
 * @param findings - the findings
 * @returns the counts
 */
export function findingCounts(findings: readonly Finding[]): string {
  const severities: readonly Severity[] = ['error', 'warning', 'advice']
  return severities
    .map((severity) => {
      const count = findings.filter((found) => found.severity === severity).length
      return `${String(count)} ${count === 1 ? severity : SEVERITY_PLURAL[severity]}`
    })
    .join(', ')
}

/**
 * Lists both sections' findings by severity, errors first, each severity's general findings
 * before its cache ones: the console's Doctor view's order (#325).
 *
 * @param report - the report
 * @returns the findings
 */
export function findingsBySeverity(report: Pick<DoctorReport, 'general' | 'cache'>): Finding[] {
  return bySeverity([...report.general, ...report.cache])
}
