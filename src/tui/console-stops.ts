/**
 * How the console (#61) comes to an end: the operator quits, the process is told to stop, or
 * something crashes it, and what crashed it is thrown again once the screen is restored.
 *
 * @packageDocumentation
 */

/** The console's end: what stops it, and how it ended. */
export interface ConsoleStop {
  /** Settles once the console should stop. */
  readonly stopped: Promise<void>
  /** Stops the console: a quit or a signal. */
  readonly stop: () => void
  /** Stops the console on an error, which `rethrow` throws; the first one counts. */
  readonly crashed: (error: unknown) => void
  /** Throws what crashed the console, if anything did: an `Error`, or one wrapping a non-error. */
  readonly rethrow: () => void
}

/**
 * Creates the console's end, not yet reached.
 *
 * @returns the stop
 */
export function consoleStop(): ConsoleStop {
  // The project's ES2023 lib has no `Promise.withResolvers` (ES2024): the executor form.
  let settle: () => void = () => undefined
  const stopped = new Promise<void>((resolve) => {
    settle = resolve
  })
  let crash: unknown
  return {
    stopped,
    stop: () => settle(),
    crashed: (error) => {
      crash ??= error
      settle()
    },
    rethrow: () => {
      if (crash instanceof Error) throw crash
      if (crash !== undefined) {
        throw new Error('The console stopped on a thrown value', { cause: crash })
      }
    }
  }
}

/**
 * Ends the console on `SIGTERM`, `SIGHUP` or an uncaught exception, until the returned function is
 * called.
 *
 * @param end - the console's end: a signal stops it, an uncaught exception crashes it
 * @returns a function that removes the handlers
 */
export function listenForStops(end: ConsoleStop): () => void {
  process.on('uncaughtException', end.crashed)
  process.once('SIGTERM', end.stop)
  process.once('SIGHUP', end.stop)
  return () => {
    process.off('uncaughtException', end.crashed)
    process.off('SIGTERM', end.stop)
    process.off('SIGHUP', end.stop)
  }
}
