import { createLogBuffer } from '@proxy/tui/log-buffer'
import { describe, expect, test, vi } from 'vite-plus/test'

describe('the console log buffer', () => {
  // Catches the console's memory growing with every request for as long as it runs: past its
  // capacity, the oldest lines go first.
  test('keeps only the newest lines, up to its capacity', () => {
    const buffer = createLogBuffer(3)
    for (const line of ['one\n', 'two\n', 'three\n', 'four\n']) buffer.append(line)

    expect(buffer.lines()).toEqual(['two', 'three', 'four'])
  })

  // Catches a multi-line record (a stack trace, a pretty-printed property) drawn as one row that
  // breaks the screen, or a blank row after every record from its trailing newline.
  test('splits a record into its lines, without the trailing newline', () => {
    const buffer = createLogBuffer(10)
    buffer.append('first line\r\n  at caller (file.ts:1)\n')

    expect(buffer.lines()).toEqual(['first line', '  at caller (file.ts:1)'])
  })

  // Catches a log view that only redraws on the next key press.
  test('tells its listeners after every append, until they unsubscribe', () => {
    const buffer = createLogBuffer(10)
    const listener = vi.fn()
    const unsubscribe = buffer.onChange(listener)

    buffer.append('one\n')
    unsubscribe()
    buffer.append('two\n')

    expect(listener).toHaveBeenCalledTimes(1)
  })
})
