/**
 * Sends stray stderr writes to the console's log view (#61), so a write that bypasses LogTape
 * does not corrupt the screen.
 *
 * @packageDocumentation
 */

import type { Writable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'

import type { LogBuffer } from '@proxy/tui/log-buffer'

/** What marks a line as a stray stderr write in the log view. */
const MARK = '[stderr] '

/**
 * Replaces a stream's `write` so that what is written goes to the log view instead, a line at a
 * time, each marked `[stderr]`.
 *
 * @remarks
 * Bytes are decoded as UTF-8 across writes, so a character split between two writes arrives
 * whole, and a line written in pieces arrives as one line. A last line with no newline is kept
 * until one comes, and is added when the capture stops.
 *
 * @param stream - the stream to capture: `process.stderr`
 * @param logs - the log buffer
 * @returns a function that restores the stream's own `write`, after adding a pending line
 */
export function captureWrites(stream: Writable, logs: LogBuffer): () => void {
  const original = stream.write.bind(stream)
  const decoder = new StringDecoder('utf8')
  let pending = ''
  /**
   * Adds every complete line written so far to the log view, and keeps the rest.
   *
   * @param text - what was just written
   */
  const take = (text: string): void => {
    const lines = (pending + text).split(/\r?\n/)
    pending = lines.pop() ?? ''
    for (const line of lines) logs.append(`${MARK}${line}`)
  }
  /**
   * Takes a write in, and calls its callback as a stream would, so a writer that waits for it
   * does not stall.
   *
   * @param chunk - what was written
   * @param encodingOrCallback - the encoding, or the callback when no encoding is given
   * @param callback - the callback, after an encoding
   * @returns `true`: nothing is queued
   */
  stream.write = (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void
  ): boolean => {
    take(typeof chunk === 'string' ? chunk : decoder.write(Buffer.from(chunk)))
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback
    if (done !== undefined) process.nextTick(done)
    return true
  }
  return () => {
    const rest = pending + decoder.end()
    if (rest !== '') logs.append(`${MARK}${rest}`)
    pending = ''
    stream.write = original
  }
}
