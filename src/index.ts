/**
 * pi-switchboard entry point: runs the CLI (`src/cli.ts`), and says clearly when pi is missing.
 *
 * @remarks
 * pi's own packages, `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent`, are optional
 * dependencies (#165), so an install with `--omit=optional` or `--no-optional` leaves them out.
 * The CLI imports them statically, so without them it fails while loading, before any of its code
 * runs. Loading it here, dynamically, turns that one failure into a message naming the cause and
 * the fix, with exit status 1, instead of a stack trace. Any other failure is rethrown unchanged.
 *
 * @packageDocumentation
 */

import { isRecord } from '@proxy/utils/guards'

/** pi's packages the CLI cannot run without. */
const PI_PACKAGES = ['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent']

/** How far down an error's `cause` chain to look. */
const MAX_CAUSE_DEPTH = 5

/**
 * Finds the pi package a failed load is missing, looking down the error's `cause` chain.
 *
 * @param error - what loading the CLI threw
 * @returns the missing package's name, or `undefined` when the failure is something else
 */
function missingPiPackage(error: unknown): string | undefined {
  let current: unknown = error
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && isRecord(current); depth++) {
    const message = typeof current['message'] === 'string' ? current['message'] : ''
    if (current['code'] === 'ERR_MODULE_NOT_FOUND') {
      const missing = PI_PACKAGES.find((packageName) => message.includes(`'${packageName}'`))
      if (missing !== undefined) return missing
    }
    current = current['cause']
  }
  return undefined
}

try {
  // Dynamic on purpose: a static import of the CLI would fail while this module loads, before
  // the `try` exists, so a missing pi package could not be caught and explained.
  await import('@proxy/cli')
} catch (error) {
  const missing = missingPiPackage(error)
  if (missing === undefined) throw error
  // Before logging is configured, and the one thing to say: a plain line on stderr.
  process.stderr.write(
    `pi-switchboard: ${missing} is not installed. It is an optional dependency of ` +
      '@vx-daniel/pi-switchboard: reinstall without --omit=optional or --no-optional.\n'
  )
  process.exitCode = 1
}
