/**
 * The console's log view position: following new lines, or scrolled back and pinned to the lines
 * on screen while new ones arrive.
 *
 * @remarks
 * Positions are absolute line numbers since the buffer began (`dropped()` plus the index in
 * `lines()`), so lines appended or dropped at capacity do not move a pinned view.
 *
 * @packageDocumentation
 */

import { type TuiMouseEvent, wrapTextWithAnsi } from '@earendil-works/pi-tui'
import type { LogBuffer } from '@proxy/tui/log-buffer'

/** `undefined` follows new lines; `{ end }` shows the lines before absolute line `end`. */
export type LogViewport = { readonly end: number } | undefined

/**
 * Scrolls the log view by some lines, pinning it when it leaves the newest line and following
 * again when it reaches it.
 *
 * @param view - where the view is
 * @param buffer - the log buffer
 * @param lines - lines to scroll up (positive) or down (negative)
 * @returns where the view is now
 */
export function scrollLogView(view: LogViewport, buffer: LogBuffer, lines: number): LogViewport {
  const total = buffer.dropped() + buffer.lines().length
  const end = (view?.end ?? total) - lines
  if (end >= total) return undefined
  return { end: Math.max(end, Math.min(buffer.dropped() + 1, total)) }
}

/**
 * Reads how far a mouse event scrolls the log or the Requests table: the wheel moves them as the
 * arrow keys do, up (a negative `wheelDelta` in pi-tui) back to older lines and down toward the
 * newest. Any other event doesn't scroll.
 *
 * @param event - the mouse event
 * @returns lines to scroll up (positive) or down (negative), or `undefined` for no scroll
 */
export function wheelLines(event: Pick<TuiMouseEvent, 'type' | 'wheelDelta'>): number | undefined {
  if (event.type !== 'wheel' || event.wheelDelta === undefined) return undefined
  return -event.wheelDelta
}

/** What a wrapped line's later rows start with, so they do not read as new lines. */
const CONTINUATION = '    '

/**
 * Wraps one log line to the width: the first row as it is, the later ones indented by
 * {@link CONTINUATION}.
 *
 * @param line - the log line
 * @param width - the columns available
 * @returns its rows
 */
function wrapLine(line: string, width: number): string[] {
  const rows = wrapTextWithAnsi(line, Math.max(1, width - CONTINUATION.length))
  return rows.map((row, rowIndex) => (rowIndex === 0 ? row : `${CONTINUATION}${row}`))
}

/**
 * Renders the rows the view shows: its lines, each wrapped to the width, newest at the bottom once
 * they fill the height, from the top while they do not.
 *
 * @remarks
 * Scrolling moves by log lines, not rows: a wrapped line moves as one.
 *
 * @param view - where the view is
 * @param buffer - the log buffer
 * @param size - the space available
 * @param size.height - rows
 * @param size.width - columns each line is wrapped to
 * @returns at most `height` rows
 */
export function logViewRows(
  view: LogViewport,
  buffer: LogBuffer,
  size: { readonly height: number; readonly width: number }
): string[] {
  const lines = buffer.lines()
  const end =
    view === undefined
      ? lines.length
      : Math.max(view.end - buffer.dropped(), Math.min(size.height, lines.length))
  const rows: string[] = []
  for (let lineIndex = end - 1; lineIndex >= 0 && rows.length < size.height; lineIndex--) {
    rows.unshift(...wrapLine(lines[lineIndex] ?? '', size.width))
  }
  return rows.slice(-size.height)
}
