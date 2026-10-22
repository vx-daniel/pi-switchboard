import { createLogBuffer, type LogBuffer } from '@proxy/tui/log-buffer'
import { logViewRows, scrollLogView } from '@proxy/tui/log-view'
import { describe, expect, test } from 'vite-plus/test'

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

    expect(logViewRows(undefined, buffer, 3)).toEqual(['line 4', 'line 5', 'line 6'])
  })

  // Catches a scrolled-back view that drifts while the operator reads: new lines must not move
  // the lines on screen (review on #195).
  test('stays on the same lines while new ones arrive', () => {
    const buffer = bufferWith(10)
    const view = scrollLogView(undefined, buffer, 4)
    const before = logViewRows(view, buffer, 3)

    buffer.append('line 11\nline 12\n')

    expect(logViewRows(view, buffer, 3)).toEqual(before)
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

    expect(logViewRows(view, buffer, 3)).toEqual(['line 1', 'line 2', 'line 3'])
  })

  // Catches a pinned view showing nothing once its lines were dropped at capacity: it shows the
  // oldest lines still kept.
  test('shows the oldest kept lines when its own were dropped', () => {
    const buffer = bufferWith(10, 10)
    const view = scrollLogView(undefined, buffer, 8)

    buffer.append('line 11\nline 12\nline 13\nline 14\nline 15\n')

    expect(logViewRows(view, buffer, 3)).toEqual(['line 6', 'line 7', 'line 8'])
  })
})
