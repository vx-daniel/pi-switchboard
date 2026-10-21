/**
 * The console's log buffer: the last formatted log lines, kept in memory for the Logs view.
 *
 * @remarks
 * The console owns the terminal, so LogTape writes here instead of to stderr. Lines arrive already
 * formatted and redacted (`configureLogging`'s `write`), so the buffer never sees a raw record.
 *
 * @packageDocumentation
 */

/** A bounded list of log lines that tells listeners when it changes. */
export interface LogBuffer {
  /**
   * Adds one formatted log record; a record spanning several lines adds each of them.
   *
   * @param text - the formatted record, with or without its trailing newline
   */
  append(text: string): void
  /**
   * Returns the lines, oldest first.
   *
   * @returns the lines
   */
  lines(): readonly string[]
  /**
   * Registers a listener called after every append.
   *
   * @param listener - called with no arguments
   * @returns a function that removes the listener
   */
  onChange(listener: () => void): () => void
}

/**
 * Creates a log buffer that keeps at most `capacity` lines, dropping the oldest first.
 *
 * @param capacity - the most lines kept; at least 1
 * @returns the buffer
 */
export function createLogBuffer(capacity: number): LogBuffer {
  const kept: string[] = []
  const listeners = new Set<() => void>()
  return {
    append(text) {
      kept.push(...text.replace(/\r?\n$/, '').split(/\r?\n/))
      if (kept.length > capacity) kept.splice(0, kept.length - capacity)
      for (const listener of listeners) listener()
    },
    lines: () => kept,
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}
