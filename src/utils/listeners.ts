/**
 * Telling a registry's listeners about a change, without letting one that throws fail the caller.
 *
 * @packageDocumentation
 */

import type { Logger } from '@logtape/logtape'
import { errorMessage } from '@proxy/utils/guards'

/**
 * Calls each listener with the same arguments. One that throws is logged and skipped: the others
 * are still called, and whatever caused the change does not fail for it.
 *
 * @remarks
 * The warning names the error's type only; its message goes in a debug record (#250), since a
 * listener's error can quote what it was drawing.
 *
 * @typeParam Args - the arguments every listener takes
 * @param listeners - who to tell, in order
 * @param args - what each listener is called with
 * @param logger - the registry's logger
 * @param source - what the listeners watch, for the log lines (`active requests`, …)
 */
export function notifyListeners<Args extends readonly unknown[]>(
  listeners: Iterable<(...args: Args) => void>,
  args: Args,
  logger: Logger,
  source: string
): void {
  for (const listener of listeners) {
    try {
      listener(...args)
    } catch (error) {
      logger.warn('A listener for {source} threw: {errorName}', {
        source,
        errorName: error instanceof Error ? error.name : typeof error
      })
      logger.debug('Listener for {source} failure detail: {detail}', {
        source,
        detail: errorMessage(error)
      })
    }
  }
}
