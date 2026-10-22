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
 * Renders the lines the view shows, padded at the top when there are fewer than fit.
 *
 * @param view - where the view is
 * @param buffer - the log buffer
 * @param height - rows available
 * @returns exactly `height` rows
 */
export function logViewRows(view: LogViewport, buffer: LogBuffer, height: number): string[] {
  const lines = buffer.lines()
  const end =
    view === undefined
      ? lines.length
      : Math.max(view.end - buffer.dropped(), Math.min(height, lines.length))
  const shown = lines.slice(Math.max(0, end - height), end)
  return [...Array.from({ length: height - shown.length }, () => ''), ...shown]
}
