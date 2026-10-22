import { Writable } from 'node:stream'

import { createLogBuffer, type LogBuffer } from '@proxy/tui/log-buffer'
import { captureWrites } from '@proxy/tui/stderr-capture'
import { describe, expect, test } from 'vite-plus/test'

/** Lines the test buffer keeps. */
const CAPACITY = 100

/**
 * Creates a stream that drops what reaches it, and a log buffer to capture into.
 *
 * @returns the stream, the buffer, and the bytes that reached the stream itself
 */
function captured(): { stream: Writable; logs: LogBuffer; reached: string[] } {
  const reached: string[] = []
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      reached.push(chunk.toString())
      done()
    }
  })
  return { stream, logs: createLogBuffer(CAPACITY), reached }
}

describe('stray stderr writes in the console', () => {
  // Catches a line written in pieces shown as several lines, and a UTF-8 character split between
  // two writes shown as replacement characters (second #195 review).
  test('a line arrives whole, however it was split', () => {
    const { stream, logs } = captured()
    const restore = captureWrites(stream, logs)
    const text = Buffer.from('warning: café\r\nnext\n')
    const split = text.indexOf(0xc3) + 1

    stream.write('(node) ')
    stream.write(text.subarray(0, split))
    stream.write(text.subarray(split))
    restore()

    expect(logs.lines()).toEqual(['[stderr] (node) warning: café', '[stderr] next'])
  })

  // Catches a last line with no newline lost when the console stops, and writes reaching the
  // terminal while the console owns it.
  test('a pending line is added when the capture stops, and nothing reaches the stream', () => {
    const { stream, logs, reached } = captured()
    const restore = captureWrites(stream, logs)

    stream.write('no newline')
    expect(logs.lines()).toEqual([])
    restore()

    expect(logs.lines()).toEqual(['[stderr] no newline'])
    expect(reached).toEqual([])
  })

  // Catches a writer that waits for its callback stalling forever.
  test('calls the write callback, with or without an encoding', async () => {
    const { stream, logs } = captured()
    const restore = captureWrites(stream, logs)

    const called = await Promise.all([
      new Promise<string>((resolve) => stream.write('one\n', () => resolve('without'))),
      new Promise<string>((resolve) => stream.write('two\n', 'utf8', () => resolve('with')))
    ])
    restore()

    expect(called).toEqual(['without', 'with'])
  })

  // Catches the capture left in place after the console stops.
  test('restores the stream', () => {
    const { stream, logs, reached } = captured()
    captureWrites(stream, logs)()

    stream.write('after\n')

    expect(reached).toEqual(['after\n'])
    expect(logs.lines()).toEqual([])
  })
})
