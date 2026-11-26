/**
 * A log file the console keeps beside its in-memory buffer (#389): JSON Lines, owner-only, one
 * line written per record, and bounded on disk by one previous file.
 *
 * @remarks
 * Not `@logtape/file`'s rotating sink: that opens each new file with the process's umask (0644 on
 * most systems), and a log names models, logins and projects. This one opens every file `0600`,
 * as pi's `auth.json` is, and writes each record at once, so a crash loses nothing written before
 * it.
 *
 * @packageDocumentation
 */

import { closeSync, fchmodSync, fstatSync, openSync, renameSync, writeSync } from 'node:fs'

import { jsonLinesFormatter, type LogRecord, type Sink } from '@logtape/logtape'

/** Owner read and write only. */
const OWNER_ONLY = 0o600

/** The sink, and how to close its file. */
export type FileSink = Sink & Disposable

/**
 * Opens a log file for appending, owner-only whether it is new or already there.
 *
 * @param path - the file
 * @returns its descriptor and size
 */
function openOwnerOnly(path: string): { fd: number; size: number } {
  const fd = openSync(path, 'a', OWNER_ONLY)
  // An existing file keeps its mode through `open`; this narrows one a person created wider.
  fchmodSync(fd, OWNER_ONLY)
  return { fd, size: fstatSync(fd).size }
}

/**
 * Makes a sink that appends JSON Lines to `path`. When a line would take the file past `maxBytes`,
 * the file becomes `<path>.1` (replacing the one before) and a new file starts.
 *
 * @remarks
 * The file opens at the first record. A failure to open or write it stops the sink: nothing more
 * is written, `onFailure` hears the error once, and the proxy runs on, since a log file must never
 * stop it.
 *
 * @param path - the log file
 * @param maxBytes - the size a file rotates at
 * @param onFailure - told the error the first time the file can't be opened or written
 * @returns the sink, which closes its file when disposed
 */
export function rotatingFileSink(
  path: string,
  maxBytes: number,
  onFailure: (error: unknown) => void
): FileSink {
  let file: { fd: number; size: number } | undefined
  let failed = false
  const close = (): void => {
    if (file !== undefined) closeSync(file.fd)
    file = undefined
  }
  const write = (record: LogRecord): void => {
    const bytes = Buffer.from(jsonLinesFormatter(record))
    file ??= openOwnerOnly(path)
    if (file.size > 0 && file.size + bytes.length > maxBytes) {
      close()
      renameSync(path, `${path}.1`)
      file = openOwnerOnly(path)
    }
    writeSync(file.fd, bytes)
    file.size += bytes.length
  }
  const sink = (record: LogRecord): void => {
    if (failed) return
    try {
      write(record)
    } catch (error) {
      failed = true
      try {
        close()
      } catch {
        // The descriptor is unusable already; the failure reported is the write's.
      }
      onFailure(error)
    }
  }
  return Object.assign(sink, { [Symbol.dispose]: close })
}
