/**
 * The console's Doctor view (#325): `pi-switchboard doctor`'s findings (#299), errors first, one
 * row each with the view or key that acts on it, the selected finding's message and
 * recommendation in a detail pane, and the doctor's limits, dim, at the end.
 *
 * @remarks
 * Rendering only, from a {@link DoctorReport} the console builds (`console-doctor.ts`); the tab's
 * count ({@link doctorBadge}) and its context come from the same report.
 *
 * @packageDocumentation
 */

import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'
import type { DoctorCheck, DoctorReport, Finding, Severity } from '@proxy/doctor/findings'
import { findingCounts, findingsBySeverity, SEVERITY_LABEL } from '@proxy/doctor/summary'
import type { StatsWindow } from '@proxy/stats/windows'
import type { TabBadge } from '@proxy/tui/frame'
import { detailField } from '@proxy/tui/models-detail'
import { STATS_WINDOW_KEYS } from '@proxy/tui/navigation'
import { firstShown, FRAME_COLUMNS, panel } from '@proxy/tui/panel'
import { type ConsoleColor, highlight, paint, tabAccent } from '@proxy/tui/theme'

/** The pointer to the Accounts view: logins and their verification. */
const ACCOUNTS = '→ 2 Accounts'
/** The pointer to the Stats view: the numbers a cache finding is about. */
const STATS = '→ 3 Stats'
/** The pointer to the Models view: the exposure, the aliases and the login routing. */
const MODELS = '→ 4 Models'
/** The pointer to the Settings view: the config file's settings. */
const SETTINGS = '→ 5 Settings'

/** A finding's pointer: the same for every finding of its check, or one per finding. */
type Pointer = string | ((found: Finding) => string)

/**
 * Where each check's findings are acted on: a view's tab (`→ 4 Models`) or a key (`p`). A check
 * missing here gets no pointer.
 */
const DOCTOR_POINTERS: Readonly<Partial<Record<DoctorCheck, Pointer>>> = {
  'exposure': MODELS,
  'alias': MODELS,
  'login-routing': MODELS,
  'enabled-models': MODELS,
  'models-json': MODELS,
  // The not-verified advice is the one `v` answers; a failed or missing login wants a login.
  'credentials': (found) => (found.severity === 'advice' ? `${ACCOUNTS}, v` : ACCOUNTS),
  'logins': ACCOUNTS,
  'proxy-auth': 'p',
  'docs-ui': SETTINGS,
  'stats': SETTINGS,
  'config-file': SETTINGS,
  'hit-rate': STATS,
  'cache-write-cost': STATS,
  'retention': STATS,
  'fallbacks': STATS,
  'prompt-cache-key': STATS,
  // An alias's `fallbackOn` is edited with the alias; the logins' in Settings.
  'fallback-on': (found) => (found.subject === 'routing.logins' ? SETTINGS : MODELS)
}

/** Each severity's color, for its label in a row. */
const SEVERITY_COLOR: Readonly<Record<Severity, ConsoleColor>> = {
  error: 'error',
  warning: 'warning',
  advice: 'accent'
}

/** Columns the selection mark takes before a row: `› ` or two spaces. */
const MARK_COLUMNS = 2
/** The severity column: the longest label, `WARNING`, and a space. */
const LABEL_COLUMNS = 8
/** The check column: the longest names, `prompt-cache-key` and `cache-write-cost`, and a space. */
const CHECK_COLUMNS = 17
/** The subject's columns at most, its space included: a long model ID is cut. */
const SUBJECT_COLUMNS = 28
/** The narrowest row that keeps its pointer at its right end; a narrower one leaves it to the detail. */
const POINTER_LEAST_WIDTH = 60
/** The narrowest view with the detail pane beside the list. */
const SIDE_BY_SIDE_LEAST_WIDTH = 100
/** Rows the detail pane needs before it shows: the Models view's gate (#265). */
const DETAIL_LEAST_ROWS = 6
/** The detail pane's share of the view's width, and its columns at least and at most. */
const DETAIL_WIDTH = { share: 0.4, least: 36, most: 64 } as const
/** Columns between the list and the detail pane. */
const PANE_GAP = 2
/** Rows the recommendation takes at most under the list, when the pane has no room. */
const UNDER_ROWS = 3

/** What the Doctor view shows. */
export interface DoctorViewInput {
  /** The report; `undefined` before the console's first status read. */
  readonly report: DoctorReport | undefined
  /** The selected finding, in {@link findingsBySeverity}'s order. */
  readonly selected: number
}

/**
 * Says where a finding is acted on.
 *
 * @param found - the finding
 * @returns its pointer (`→ 4 Models`, `p`), or `''` when its check has none
 */
export function doctorPointer(found: Finding): string {
  const pointer = DOCTOR_POINTERS[found.check]
  if (pointer === undefined) return ''
  return typeof pointer === 'string' ? pointer : pointer(found)
}

/**
 * Counts the errors and warnings for the Doctor tab: advice alone shows no count.
 *
 * @param report - the report, or `undefined` before the first read
 * @returns the count, in the error color when any is an error; `undefined` for none
 */
export function doctorBadge(report: DoctorReport | undefined): TabBadge | undefined {
  if (report === undefined) return undefined
  const findings = findingsBySeverity(report)
  const errors = findings.filter((found) => found.severity === 'error').length
  const count = errors + findings.filter((found) => found.severity === 'warning').length
  if (count === 0) return undefined
  return { count, level: errors > 0 ? 'error' : 'warning' }
}

/**
 * Says what the Doctor tab's context shows: the window, as the Stats tab does, and the counts.
 *
 * @param window - the window both views read
 * @param report - the report, or `undefined` before the first read
 * @returns `week · 1 error, 2 warnings, 0 advice`, or the window alone before the first read
 */
export function doctorContext(window: StatsWindow, report: DoctorReport | undefined): string {
  const name = STATS_WINDOW_KEYS[window][1]
  return report === undefined ? name : `${name} · ${findingCounts(findingsBySeverity(report))}`
}

/**
 * Renders one finding's row: the mark, the severity, the check, the subject and the message, cut
 * to the width, and its pointer at the right end.
 *
 * @param found - the finding
 * @param selected - whether it is the selected one
 * @param width - the row's columns
 * @returns the row, `width` columns
 */
function findingRow(found: Finding, selected: boolean, width: number): string {
  const pointer = doctorPointer(found)
  const hint = pointer === '' || width < POINTER_LEAST_WIDTH ? '' : ` ${pointer}`
  const subject =
    found.subject === undefined
      ? ''
      : `${truncateToWidth(found.subject, SUBJECT_COLUMNS - 1, '…')} `
  const label = SEVERITY_LABEL[found.severity].padEnd(LABEL_COLUMNS)
  const rest = `${found.check.padEnd(CHECK_COLUMNS)}${subject}${found.message}`
  const text = selected
    ? highlight(`› ${label}${rest}`)
    : `${' '.repeat(MARK_COLUMNS)}${paint(SEVERITY_COLOR[found.severity], label)}${rest}`
  const room = Math.max(0, width - visibleWidth(hint))
  return `${truncateToWidth(text, room, '…', true)}${tabAccent(hint)}`
}

/**
 * Lists the doctor's limits, dim, after a blank row, as the CLI prints them at the report's end.
 *
 * @param limits - the limits
 * @param width - the columns
 * @returns the lines
 */
function limitLines(limits: readonly string[], width: number): string[] {
  return [
    '',
    paint('dim', 'Limits:'),
    ...limits.flatMap((limit) => wrapTextWithAnsi(paint('dim', `- ${limit}`), width))
  ]
}

/**
 * Renders the list: each finding's row, or `No findings`, then the limits, scrolled so the
 * selected row shows; the last finding selected brings as much of the limits as fits.
 *
 * @param findings - the findings, in order
 * @param report - the report, for its limits
 * @param selected - the selected finding
 * @param size - the list's rows and columns
 * @param size.height - rows
 * @param size.width - columns
 * @returns the rows
 */
function listRows(
  findings: readonly Finding[],
  report: DoctorReport,
  selected: number,
  size: { readonly height: number; readonly width: number }
): string[] {
  const rows =
    findings.length === 0
      ? [paint('success', '✓ No findings')]
      : findings.map((found, index) => findingRow(found, index === selected, size.width))
  const lines = [...rows, ...limitLines(report.limits, size.width)]
  const last = selected === findings.length - 1
  const anchor = last ? Math.min(lines.length - 1, selected + size.height - 1) : selected
  const first = firstShown(anchor, lines.length, size.height)
  return lines.slice(first, first + size.height)
}

/**
 * Lists the detail pane's lines: what the finding is about, its message, the recommendation and
 * its pointer.
 *
 * @param found - the finding
 * @param width - the pane's content columns
 * @returns the lines
 */
function detailLines(found: Finding, width: number): string[] {
  const pointer = doctorPointer(found)
  return [
    ...(found.subject === undefined ? [] : detailField('about', found.subject, width)),
    ...wrapTextWithAnsi(found.message, width),
    '',
    ...detailField('fix', found.recommendation, width),
    ...(pointer === '' ? [] : ['', tabAccent(pointer)])
  ]
}

/**
 * Frames the detail pane for the selected finding, at most `height` rows: a taller pane loses its
 * last lines, keeping its frame, as the Models view's does.
 *
 * @param found - the finding
 * @param size - the pane's rows and columns, its frame included
 * @param size.height - rows
 * @param size.width - columns
 * @returns the pane's rows
 */
function detailPane(
  found: Finding,
  size: { readonly height: number; readonly width: number }
): string[] {
  const inner = Math.max(1, size.width - FRAME_COLUMNS)
  const pane = panel(
    SEVERITY_LABEL[found.severity],
    detailLines(found, inner),
    size.width,
    found.check
  )
  if (pane.length <= size.height) return pane
  return [...pane.slice(0, size.height - 1), ...pane.slice(-1)]
}

/**
 * Puts the detail pane beside the list.
 *
 * @param findings - the findings
 * @param report - the report
 * @param selected - the selected finding
 * @param size - the view's rows and columns
 * @param size.height - rows
 * @param size.width - columns
 * @returns the rows
 */
function sideBySideRows(
  findings: readonly Finding[],
  report: DoctorReport,
  selected: number,
  size: { readonly height: number; readonly width: number }
): string[] {
  const paneWidth = Math.min(
    DETAIL_WIDTH.most,
    Math.max(DETAIL_WIDTH.least, Math.floor(size.width * DETAIL_WIDTH.share))
  )
  const listWidth = size.width - paneWidth - PANE_GAP
  const list = listRows(findings, report, selected, { height: size.height, width: listWidth })
  const found = findings[selected]
  const pane =
    found === undefined ? [] : detailPane(found, { height: size.height, width: paneWidth })
  return Array.from(
    { length: Math.max(list.length, pane.length) },
    (_, row) =>
      `${truncateToWidth(list[row] ?? '', listWidth, '…', true)}${' '.repeat(PANE_GAP)}${pane[row] ?? ''}`
  )
}

/**
 * Puts the selected finding's recommendation under the list, for a view too narrow or short for
 * the pane, with its pointer when the rows had no room for it.
 *
 * @param findings - the findings
 * @param report - the report
 * @param selected - the selected finding
 * @param size - the view's rows and columns
 * @param size.height - rows
 * @param size.width - columns
 * @returns the rows
 */
function stackedRows(
  findings: readonly Finding[],
  report: DoctorReport,
  selected: number,
  size: { readonly height: number; readonly width: number }
): string[] {
  const found = findings[selected]
  const pointer =
    found === undefined || size.width >= POINTER_LEAST_WIDTH ? '' : doctorPointer(found)
  const under =
    found === undefined
      ? []
      : wrapTextWithAnsi(
          `${pointer === '' ? '' : `${tabAccent(pointer)} `}${paint('dim', `fix: ${found.recommendation}`)}`,
          size.width
        ).slice(0, UNDER_ROWS)
  const underRows = under.length === 0 ? 0 : under.length + 1
  const visible = Math.max(1, size.height - underRows)
  const list = listRows(findings, report, selected, { height: visible, width: size.width })
  if (underRows === 0) return list
  const padding = Array.from({ length: Math.max(0, visible - list.length) }, () => '')
  return [...list, ...padding, '', ...under]
}

/**
 * Renders the Doctor view: the findings, errors first, with the selected one's detail pane beside
 * them from {@link SIDE_BY_SIDE_LEAST_WIDTH} columns and {@link DETAIL_LEAST_ROWS} rows, or its
 * recommendation under them otherwise; then the limits.
 *
 * @param view - the report and the selection
 * @param size - the space available
 * @param size.height - rows
 * @param size.width - columns
 * @returns the rows
 */
export function doctorRows(
  view: DoctorViewInput,
  size: { readonly height: number; readonly width: number }
): string[] {
  const { report } = view
  if (report === undefined) return [paint('dim', 'Reading the status…')]
  const findings = findingsBySeverity(report)
  const selected = Math.min(Math.max(view.selected, 0), Math.max(0, findings.length - 1))
  const roomy = size.width >= SIDE_BY_SIDE_LEAST_WIDTH && size.height >= DETAIL_LEAST_ROWS
  return roomy && findings.length > 0
    ? sideBySideRows(findings, report, selected, size)
    : stackedRows(findings, report, selected, size)
}
