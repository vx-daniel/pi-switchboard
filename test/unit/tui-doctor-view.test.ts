/**
 * The console's Doctor view (#325, `src/tui/doctor-view.ts`) and the credentials it judges
 * (`src/tui/console-doctor.ts`): rows, the detail pane, the tab's count, the pointers, and logins
 * judged from the Accounts view's last verification.
 */

import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { isLoopbackHost } from '@proxy/config/schema'
import {
  DOCTOR_CHECKS,
  type DoctorReport,
  type Finding,
  generalFindings,
  type GeneralInputs,
  LIMITS
} from '@proxy/doctor/findings'
import type { ProviderCredentialStatus } from '@proxy/pi/registry'
import { consoleCredentials } from '@proxy/tui/console-doctor'
import { doctorBadge, doctorContext, doctorPointer, doctorRows } from '@proxy/tui/doctor-view'
import { describe, expect, test } from 'vite-plus/test'

/**
 * Builds a finding.
 *
 * @param check - its check
 * @param severity - its severity
 * @param fields - the subject, message and recommendation to set
 * @returns the finding
 */
function found(
  check: Finding['check'],
  severity: Finding['severity'],
  fields: Partial<Pick<Finding, 'subject' | 'message' | 'recommendation'>> = {}
): Finding {
  return {
    check,
    severity,
    message: `${check} message`,
    recommendation: `${check} recommendation`,
    ...fields
  }
}

/**
 * Builds a report with these findings.
 *
 * @param general - the general section's
 * @param cache - the cache section's
 * @returns the report, over the week, with the doctor's limits
 */
function report(general: readonly Finding[], cache: readonly Finding[] = []): DoctorReport {
  return { general, cache, window: 'week', statsAvailable: true, limits: LIMITS }
}

/**
 * Renders the view as plain text.
 *
 * @param shown - the report
 * @param size - the view's rows and columns
 * @param size.height - rows
 * @param size.width - columns
 * @param selected - the selected finding
 * @returns the rows without colour codes
 */
function rows(
  shown: DoctorReport | undefined,
  size: { height: number; width: number },
  selected = 0
): string[] {
  return doctorRows({ report: shown, selected }, size).map((row) => stripTerminalSequences(row))
}

/** A report with a finding of every severity, in both sections, out of order. */
const MIXED = report(
  [
    found('stats', 'advice'),
    found('proxy-auth', 'warning', { subject: '0.0.0.0' }),
    found('exposure', 'error')
  ],
  [found('hit-rate', 'warning', { subject: 'alpha/one' }), found('retention', 'advice')]
)

describe('the Doctor view', () => {
  // Catches the view listing findings by section instead of errors first, as the CLI orders each
  // section, so an error in one section hides under the other's warnings.
  test('lists errors, then warnings, then advice, across both sections', () => {
    const shown = rows(MIXED, { height: 20, width: 80 })
    const order = ['exposure', 'proxy-auth', 'hit-rate', 'stats', 'retention'].map((check) =>
      shown.findIndex((row) => row.includes(` ${check} `))
    )

    expect(order).toEqual([0, 1, 2, 3, 4])
    expect(shown[0]).toMatch(/^› ERROR {3}exposure /u)
    expect(shown[1]).toMatch(/^ {2}WARNING proxy-auth {7}0\.0\.0\.0 proxy-auth message/u)
  })

  // Catches a row wider than the view (it would wrap the screen), a long message pushing the
  // pointer off the row, or a row that names the wrong view for its check.
  test('cuts each row to the width and keeps its pointer at the right end', () => {
    const long = report([
      found('exposure', 'error', { message: 'x'.repeat(200) }),
      found('credentials', 'error', { subject: 'alpha' }),
      found('proxy-auth', 'warning', { subject: '0.0.0.0' }),
      found('fallback-on', 'advice', { subject: 'fast' }),
      found('fallback-on', 'advice', { subject: 'routing.logins' })
    ])
    const shown = rows(long, { height: 20, width: 70 })

    for (const row of shown) expect(visibleWidth(row)).toBeLessThanOrEqual(70)
    expect(shown[0]).toMatch(/x…\s*→ 4 Models$/u)
    expect(shown[1]).toMatch(/ → 2 Accounts$/u)
    expect(shown[2]).toMatch(/ p$/u)
    expect(shown[3]).toMatch(/ → 4 Models$/u)
    expect(shown[4]).toMatch(/ → 5 Settings$/u)
  })

  // Catches the selected finding's recommendation missing from the view, which only the CLI would
  // then show: in the detail pane where there is room, under the list where there is not.
  test('shows the selected finding’s recommendation in a pane, or under the list', () => {
    const wide = rows(MIXED, { height: 20, width: 120 }, 1).join('\n')
    const narrow = rows(MIXED, { height: 20, width: 70 }, 1)

    expect(wide).toMatch(/╭─ WARNING proxy-auth ─+╮/u)
    expect(wide).toContain('about 0.0.0.0')
    expect(wide).toContain('fix proxy-auth recommendation')
    expect(wide).toMatch(/│ p +│/u)
    expect(narrow.join('\n')).not.toContain('╭─ WARNING')
    expect(narrow.at(-1)).toBe('fix: proxy-auth recommendation')
  })

  // Catches a clean report rendering as an empty view, which reads as still loading, and the
  // limits left out: the doctor can't tell some things whatever it found.
  test('says No findings, then the limits, dim, once', () => {
    const shown = rows(report([]), { height: 20, width: 200 })

    expect(shown[0]).toBe('✓ No findings')
    expect(shown.filter((row) => row === 'Limits:')).toHaveLength(1)
    expect(shown.slice(-LIMITS.length)).toEqual(LIMITS.map((limit) => `- ${limit}`))
  })

  // Catches the limits pushing the last finding off a short view when it is selected, or never
  // showing on a list longer than the view.
  test('brings the limits into view under the last finding, keeping it shown', () => {
    const many = report(DOCTOR_CHECKS.map((check) => found(check, 'advice')))
    const last = DOCTOR_CHECKS.length - 1
    const shown = rows(many, { height: 6, width: 200 }, last)

    expect(shown[0]).toMatch(/^› ADVICE {2}prompt-cache-key /u)
    expect(shown[2]).toMatch(/^Limits: /u)
  })

  // Catches the view rendering nothing before the console's first status read.
  test('says it is reading before the first report', () => {
    expect(rows(undefined, { height: 5, width: 80 })).toEqual(['Reading the status…'])
  })
})

describe('the Doctor tab', () => {
  // Catches the count including advice (the tab would never go quiet), missing warnings, or
  // coloured as a warning while an error is among them.
  test('counts errors and warnings, coloured by the worst; advice alone shows no count', () => {
    expect(doctorBadge(MIXED)).toEqual({ count: 3, level: 'error' })
    expect(doctorBadge(report([found('docs-ui', 'warning')]))).toEqual({
      count: 1,
      level: 'warning'
    })
    expect(doctorBadge(report([found('stats', 'advice')], [found('retention', 'advice')]))).toBe(
      undefined
    )
    expect(doctorBadge(undefined)).toBeUndefined()
  })

  // Catches the tab's context not naming the window the Stats view shares, or the counts.
  test('names the shared window and the counts in its context', () => {
    expect(doctorContext('all', MIXED)).toBe('all 30 days · 1 error, 2 warnings, 2 advice')
    expect(doctorContext('today', undefined)).toBe('today')
  })
})

describe('the Doctor view’s pointers', () => {
  // Catches a check added to the doctor without a pointer, which its finding would then lack
  // (every check today has a view or key that acts on it).
  test('every check the doctor can report points somewhere', () => {
    for (const check of DOCTOR_CHECKS) {
      expect(doctorPointer(found(check, 'warning')), check).not.toBe('')
    }
  })

  // Catches the per-finding pointers going the wrong way: an alias's fallbackOn is edited in
  // Models, the logins' in Settings; only the not-verified advice is answered by `v`.
  test('picks the pointer from the finding where its check spans two places', () => {
    expect(doctorPointer(found('fallback-on', 'advice', { subject: 'fast' }))).toBe('→ 4 Models')
    expect(doctorPointer(found('fallback-on', 'advice', { subject: 'routing.logins' }))).toBe(
      '→ 5 Settings'
    )
    expect(doctorPointer(found('credentials', 'advice'))).toBe('→ 2 Accounts, v')
    expect(doctorPointer(found('credentials', 'error', { subject: 'alpha' }))).toBe('→ 2 Accounts')
  })
})

/**
 * Builds a login as the console holds it.
 *
 * @param provider - the provider
 * @param verification - its last verification, if any
 * @returns the login
 */
function login(
  provider: string,
  verification: Pick<ProviderCredentialStatus, 'verified' | 'error'> = {}
): ProviderCredentialStatus {
  return { provider, type: 'oauth', availableModelCount: 1, ...verification }
}

/**
 * Judges the general section with the console's credentials for these logins, on an otherwise
 * healthy proxy.
 *
 * @param accounts - the logins, with their last verification
 * @returns the credentials findings
 */
function credentialChecks(accounts: readonly ProviderCredentialStatus[]): Finding[] {
  const inputs: GeneralInputs = {
    models: {
      availableModelCount: 1,
      exposedModelCount: 1,
      exposureError: null,
      scopeDiagnostics: [],
      aliasDiagnostics: [],
      loginDiagnostics: [],
      modelsJsonError: null
    },
    credentials: consoleCredentials(accounts, { registered: true }),
    server: { host: '127.0.0.1', proxyAuth: true, docsUi: false, stats: true },
    configFileProblem: undefined,
    fallback: { aliases: [], logins: ['rate_limit'] },
    fallbacksByAlias: new Map()
  }
  return generalFindings(inputs, isLoopbackHost).filter(
    (finding) => finding.check === 'credentials'
  )
}

describe('the Doctor view’s credentials', () => {
  // Catches a login the Accounts view never verified passing as verified, or the advice telling
  // the operator to rerun the CLI with --verify instead of pressing v in the console.
  test('a login never verified is advice to verify it in Accounts', () => {
    const findings = credentialChecks([login('alpha', { verified: true }), login('beta')])

    expect(findings).toEqual([
      expect.objectContaining({
        severity: 'advice',
        message: expect.stringMatching(/^1 providers have a login or key: beta\. Not verified\.$/u),
        recommendation: expect.stringMatching(/^Verify the logins in the Accounts view \(v;/u)
      })
    ])
    expect(doctorPointer(findings[0] ?? found('stats', 'advice'))).toBe('→ 2 Accounts, v')
  })

  // Catches a failed verification in the Accounts view not reaching the doctor as the error the
  // CLI's --verify reports, or a verified login still called not verified.
  test('a failed verification is an error; verified logins raise nothing', () => {
    const failed = credentialChecks([login('alpha', { verified: false, error: 'expired' })])

    expect(failed).toEqual([
      expect.objectContaining({
        severity: 'error',
        subject: 'alpha',
        message: 'The login failed to verify: expired.'
      })
    ])
    expect(credentialChecks([login('alpha', { verified: true })])).toEqual([])
  })
})
