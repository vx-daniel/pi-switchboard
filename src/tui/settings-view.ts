/**
 * The console's Settings view (#288): renders the settings the shared model lists
 * (`src/config/settings.ts`, also the admin UI's, #367), grouped by when a change applies, with
 * the value saved, the value running when a restart is still to apply it, and the flag or env var
 * that wins over the file.
 *
 * @remarks
 * Rendering only; the rows come from `settingRows`, and the editors behind Enter are
 * `src/tui/console-settings.ts`.
 *
 * @packageDocumentation
 */

import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'
import {
  type Section,
  sectionHeading,
  settingHelp,
  type SettingRow,
  settingSection
} from '@proxy/config/settings'
import { firstShown } from '@proxy/tui/panel'
import { highlight, paint, strong } from '@proxy/tui/theme'

/** Columns the selection mark takes before a row: `› ` or two spaces. */
const MARK_COLUMNS = 2
/** The label column. */
const LABEL_COLUMNS = 24
/** The value column at its widest; the note after it takes the rest. */
const VALUE_COLUMNS = 34
/** The most lines of the selected setting's help shown under the list, after a blank row. */
const HELP_ROWS = 3

/**
 * Says what a row's note is: the override that wins over the saved value, or the running value a
 * restart would replace.
 *
 * @param row - the row
 * @returns the note, colored, or `''`
 */
function rowNote(row: SettingRow): string {
  if (row.override !== undefined) return paint('warning', `${row.override} wins over the file`)
  if (row.running === undefined) return ''
  return row.applies === 'restart'
    ? paint('warning', `running ${row.running}; restart (r) to apply`)
    : paint('warning', `running ${row.running} until the server restarts`)
}

/**
 * Renders one setting's line.
 *
 * @param row - the setting
 * @param selected - whether it is the selected one
 * @param width - the view's columns
 * @returns the line
 */
function settingLine(row: SettingRow, selected: boolean, width: number): string {
  const valueColumns = Math.max(0, Math.min(VALUE_COLUMNS, width - MARK_COLUMNS - LABEL_COLUMNS))
  const label = truncateToWidth(row.label, LABEL_COLUMNS - 1, '…', true)
  const value = truncateToWidth(row.saved, valueColumns - 1, '…', true)
  const mark = selected ? '› ' : '  '
  const text = `${mark}${label} ${value}`
  const line = selected ? highlight(text) : `${mark}${label} ${strong(value)}`
  return truncateToWidth(`${line} ${rowNote(row)}`, width)
}

/**
 * Lays out every line of the list: a heading per group, each setting under it, a blank row between
 * groups.
 *
 * @param rows - the settings
 * @param selected - the selected setting's index in `rows`
 * @param width - the view's columns
 * @returns the lines, and which one is the selected setting
 */
function listLines(
  rows: readonly SettingRow[],
  selected: number,
  width: number
): { lines: string[]; selectedLine: number } {
  const lines: string[] = []
  let selectedLine = 0
  let section: Section | undefined
  for (const [rowIndex, row] of rows.entries()) {
    const rowSection = settingSection(row.key)
    if (rowSection !== section) {
      if (section !== undefined) lines.push('')
      section = rowSection
      const { title, note } = sectionHeading(rowSection)
      lines.push(truncateToWidth(`${strong(title)}  ${paint('dim', note)}`, width))
    }
    if (rowIndex === selected) selectedLine = lines.length
    lines.push(settingLine(row, rowIndex === selected, width))
  }
  return { lines, selectedLine }
}

/**
 * Says, over the list, that the config file can't be used: the view shows the defaults it loads
 * as, and nothing is saved over it (#288).
 *
 * @param problem - why the file can't be used, or `undefined` when it can
 * @param width - the view's columns
 * @returns the banner and a blank row, or nothing
 */
function problemBanner(problem: string | undefined, width: number): string[] {
  if (problem === undefined) return []
  const text = `proxy-config.json ${problem}: these are the defaults it loads as, and nothing is saved over it until it is fixed or removed.`
  return [...wrapTextWithAnsi(paint('error', text), width), '']
}

/**
 * Renders the Settings view: a banner when the config file can't be used, the settings by group,
 * scrolled to keep the selected one on screen, and its help under them.
 *
 * @param rows - the settings ({@link settingRows})
 * @param selected - the selected setting's index
 * @param size - the space available
 * @param size.height - rows
 * @param size.width - columns
 * @param problem - why the config file can't be used (`is not valid JSON`); `undefined` when it can
 * @returns the view's rows
 */
export function settingsViewRows(
  rows: readonly SettingRow[],
  selected: number,
  size: { readonly height: number; readonly width: number },
  problem?: string
): string[] {
  const { width, height } = size
  const banner = problemBanner(problem, width)
  const chosen = rows[selected]
  const help =
    chosen === undefined ? [] : wrapTextWithAnsi(paint('dim', settingHelp(chosen.key)), width)
  const helpRows = help.length === 0 ? 0 : Math.min(help.length + 1, HELP_ROWS + 1)
  const visible = Math.max(1, height - helpRows - banner.length)
  const { lines, selectedLine } = listLines(rows, selected, width)
  const first = firstShown(selectedLine, lines.length, visible)
  const shown = [...banner, ...lines.slice(first, first + visible)]
  if (helpRows === 0) return shown
  const padding = Array.from(
    { length: Math.max(0, visible + banner.length - shown.length) },
    () => ''
  )
  return [...shown, ...padding, '', ...help.slice(0, helpRows - 1)].map((row) =>
    visibleWidth(row) > width ? truncateToWidth(row, width) : row
  )
}
