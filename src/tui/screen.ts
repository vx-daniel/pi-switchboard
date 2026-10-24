/**
 * The console's whole screen (#61) as rows: the status strip, the framed view with the sidebar
 * beside it, and the footer. Pure: the console gathers a {@link ScreenInput} and redraws, so a
 * test can check that every row is exactly as wide as the terminal at every size.
 *
 * @packageDocumentation
 */

import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import { framedView } from '@proxy/tui/frame'
import type { ConsoleLayout } from '@proxy/tui/layout'
import { footerLine, type View } from '@proxy/tui/navigation'
import { besideSidebar } from '@proxy/tui/sidebar'
import { type StatusStripInput, statusStrip } from '@proxy/tui/status-strip'
import { chrome, paint, strong } from '@proxy/tui/theme'

/** Weekday names for the clock. */
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
/** Month names for the clock. */
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec'
] as const
/** Digits a clock field is padded to. */
const CLOCK_DIGITS = 2

/** Everything one render of the screen shows. */
export interface ScreenInput {
  readonly view: View
  readonly layout: ConsoleLayout
  /** The current time, for the clock over the sidebar. */
  readonly now: number
  readonly strip: StatusStripInput
  /** What the right end of the tab row says about the view. */
  readonly context: string
  /** What the right end of the frame's bottom border says about the view. */
  readonly note: string
  /** The view's rows, rendered for `layout.viewWidth` by `layout.viewHeight`. */
  readonly body: readonly string[]
  /** The sidebar's rows, rendered for `layout.sidebarWidth` by `layout.frameRows`; none when hidden. */
  readonly sidebar: readonly string[] | undefined
}

/**
 * Formats the clock over the sidebar: `Fri 23 Oct  19:02:29`, in local time.
 *
 * @param now - the time, in milliseconds since the epoch
 * @returns the text
 */
export function clockLabel(now: number): string {
  const date = new Date(now)
  const pad = (value: number): string => String(value).padStart(CLOCK_DIGITS, '0')
  const day = `${WEEKDAYS[date.getDay()] ?? ''} ${String(date.getDate())} ${MONTHS[date.getMonth()] ?? ''}`
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  return `${paint('dim', day)}  ${strong(time)}`
}

/**
 * Builds the sidebar's column beside the frame: with folder tabs, a blank row and the clock above
 * the panels, so the panels start level with the frame's top border.
 *
 * @param input - the screen's input
 * @param width - the sidebar's columns
 * @returns the rows, one per frame row plus the tab rows
 */
function sidebarColumn(input: ScreenInput, width: number): string[] {
  const panels = input.sidebar ?? []
  if (!input.layout.folderTabs) return [...panels]
  const clock = truncateToWidth(clockLabel(input.now), width, '', false)
  // By visible width: the clock carries colour codes, which `padStart` would count as columns.
  const clockRow = `${' '.repeat(Math.max(0, width - visibleWidth(clock)))}${clock}`
  return ['', truncateToWidth(clockRow, width, '', true), ...panels]
}

/**
 * Renders the screen: the strip, the framed view (with the sidebar beside it when shown), the
 * footer.
 *
 * @param input - the screen's input
 * @returns the rows, as many as the terminal has and each as wide
 */
export function consoleScreen(input: ScreenInput): string[] {
  const { layout } = input
  const framed = framedView(
    { view: input.view, layout, context: input.context, note: input.note },
    input.body
  )
  const middle =
    layout.sidebarWidth === undefined
      ? framed
      : besideSidebar(framed, sidebarColumn(input, layout.sidebarWidth), layout.mainWidth)
  const rows = [
    chrome(statusStrip(input.strip, layout.columns), layout.columns),
    ...middle,
    footerLine(input.view, { width: layout.columns, sidebarFits: layout.sidebarFits })
  ]
  const shown = rows.slice(0, layout.rows)
  while (shown.length < layout.rows) shown.push('')
  return shown.map((row) => truncateToWidth(row, layout.columns, '', true))
}
