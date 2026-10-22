import { createLogBuffer, type LogBuffer } from '@proxy/tui/log-buffer'
import { logViewRows, scrollLogView } from '@proxy/tui/log-view'
import { describe, expect, test } from 'vite-plus/test'

/** Three rows of a wide terminal, where no test line wraps. */
const THREE_ROWS = { height: 3, width: 80 }

/**
 * Builds a buffer holding `line 1` … `line count`.
 *
 * @param count - how many lines to append
 * @param capacity - the buffer's capacity
 * @returns the buffer
 */
function bufferWith(count: number, capacity = 100): LogBuffer {
  const buffer = createLogBuffer(capacity)
  for (let lineNumber = 1; lineNumber <= count; lineNumber++) {
    buffer.append(`line ${String(lineNumber)}\n`)
  }
  return buffer
}

describe('the console log view', () => {
  // Catches a following view that stops showing new requests as they are logged.
  test('follows new lines until scrolled', () => {
    const buffer = bufferWith(5)
    buffer.append('line 6\n')

    expect(logViewRows(undefined, buffer, THREE_ROWS)).toEqual(['line 4', 'line 5', 'line 6'])
  })

  // Catches a short log drawn at the bottom of an empty screen, away from the tabs above it.
  test('starts at the top while the lines do not fill the view', () => {
    expect(logViewRows(undefined, bufferWith(2), THREE_ROWS)).toEqual(['line 1', 'line 2'])
  })

  // Catches a blank line in a multi-line record vanishing when wrapped, which would join the
  // paragraphs around it (second #204 review).
  test('keeps a blank line as an empty row', () => {
    const buffer = createLogBuffer(10)
    buffer.append('before\n\nafter\n')

    expect(logViewRows(undefined, buffer, THREE_ROWS)).toEqual(['before', '', 'after'])
  })

  // Catches a line's message cut off at the screen's edge on a narrow terminal: it wraps onto the
  // next rows, indented so they don't read as new lines, and the newest line's last row stays at
  // the bottom.
  test('wraps a line wider than the view', () => {
    const buffer = bufferWith(1)
    buffer.append('first-part second-part\n')

    expect(logViewRows(undefined, buffer, { height: 3, width: 16 })).toEqual([
      'line 1',
      'first-part',
      '    second-part'
    ])
    expect(logViewRows(undefined, buffer, { height: 2, width: 16 })).toEqual([
      'first-part',
      '    second-part'
    ])
  })

  // Catches a scrolled-back view that drifts while the operator reads: new lines must not move
  // the lines on screen (review on #195).
  test('stays on the same lines while new ones arrive', () => {
    const buffer = bufferWith(10)
    const view = scrollLogView(undefined, buffer, 4)
    const before = logViewRows(view, buffer, THREE_ROWS)

    buffer.append('line 11\nline 12\n')

    expect(logViewRows(view, buffer, THREE_ROWS)).toEqual(before)
    expect(before).toEqual(['line 4', 'line 5', 'line 6'])
  })

  // Catches End-of-scroll never returning to live lines: scrolling down to the newest follows.
  test('follows again once scrolled back down to the newest line', () => {
    const buffer = bufferWith(10)
    const up = scrollLogView(undefined, buffer, 4)

    expect(scrollLogView(up, buffer, -4)).toBeUndefined()
    expect(scrollLogView(up, buffer, -100)).toBeUndefined()
  })

  // Catches scrolling past the oldest line into blank rows.
  test('stops at the oldest line', () => {
    const buffer = bufferWith(10)
    const view = scrollLogView(undefined, buffer, 1000)

    expect(logViewRows(view, buffer, THREE_ROWS)).toEqual(['line 1', 'line 2', 'line 3'])
  })

  // Catches a pinned view showing nothing once its lines were dropped at capacity: it shows the
  // oldest lines still kept.
  test('shows the oldest kept lines when its own were dropped', () => {
    const buffer = bufferWith(10, 10)
    const view = scrollLogView(undefined, buffer, 8)

    buffer.append('line 11\nline 12\nline 13\nline 14\nline 15\n')

    expect(logViewRows(view, buffer, THREE_ROWS)).toEqual(['line 6', 'line 7', 'line 8'])
  })
})
