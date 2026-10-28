/**
 * The console's whole screen (#61) as rows: the status strip, the framed view with the sidebar
 * beside it, and the footer. Pure: the console gathers a {@link ScreenInput} and redraws, so a
 * test can check that every row is exactly as wide as the terminal at every size.
 *
 * @packageDocumentation
 */

import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import { framedView, type TabBadges } from '@proxy/tui/frame'
import type { ConsoleLayout } from '@proxy/tui/layout'
import { footerLine, type KeyHint, type View } from '@proxy/tui/navigation'
import { besideSidebar } from '@proxy/tui/sidebar'
import { authOffRow, type StatusStripInput, statusStrip } from '@proxy/tui/status-strip'
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
  /** What the left end of the frame's bottom border says about the view's state; none if absent. */
  readonly status?: string
  /** The tabs' counts (the Doctor tab's, #325); none if absent. */
  readonly badges?: TabBadges
  /** The view's footer keys, when its state changes them; the view's usual keys if absent. */
  readonly keys?: readonly KeyHint[]
  /** The view's rows, rendered for `layout.viewWidth` by `layout.viewHeight`. */
  readonly body: readonly string[]
  /** The sidebar's rows, rendered for `layout.sidebarWidth` by `layout.frameRows`; none when hidden. */
  readonly sidebar: readonly string[] | undefined
  /**
   * The address while proxy auth is off and the proxy listens beyond loopback, for the alert row
   * under the strip (#287); `undefined` otherwise. `layout.alertRow` keeps the row for it.
   */
  readonly authOffAt?: string | undefined
}

/**
 * Formats a time of day: `19:02:29`, in local time.
 *
 * @param time - the time, in milliseconds since the epoch
 * @returns the text
 */
export function timeOfDay(time: number): string {
  const date = new Date(time)
  const pad = (value: number): string => String(value).padStart(CLOCK_DIGITS, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * Formats the clock over the sidebar: `Fri 23 Oct  19:02:29`, in local time.
 *
 * @param now - the time, in milliseconds since the epoch
 * @returns the text
 */
export function clockLabel(now: number): string {
  const date = new Date(now)
  const day = `${WEEKDAYS[date.getDay()] ?? ''} ${String(date.getDate())} ${MONTHS[date.getMonth()] ?? ''}`
  return `${paint('dim', day)}  ${strong(timeOfDay(now))}`
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
 * Renders the screen: the strip, the alert row when the layout keeps one, the framed view (with
 * the sidebar beside it when shown), the footer.
 *
 * @param input - the screen's input
 * @returns the rows, as many as the terminal has and each as wide
 */
export function consoleScreen(input: ScreenInput): string[] {
  const { layout } = input
  const framed = framedView(
    {
      view: input.view,
      layout,
      context: input.context,
      note: input.note,
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.badges === undefined ? {} : { badges: input.badges })
    },
    input.body
  )
  const middle =
    layout.sidebarWidth === undefined
      ? framed
      : besideSidebar(framed, sidebarColumn(input, layout.sidebarWidth), layout.mainWidth)
  const alert =
    layout.alertRow && input.authOffAt !== undefined
      ? [authOffRow(input.authOffAt, layout.columns)]
      : []
  const rows = [
    chrome(statusStrip(input.strip, layout.columns), layout.columns),
    ...alert,
    ...middle,
    footerLine(input.view, { width: layout.columns, sidebarFits: layout.sidebarFits }, input.keys)
  ]
  const shown = rows.slice(0, layout.rows)
  while (shown.length < layout.rows) shown.push('')
  return shown.map((row) => truncateToWidth(row, layout.columns, '', true))
}
