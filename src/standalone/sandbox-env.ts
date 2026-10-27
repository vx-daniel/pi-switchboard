/**
 * A compiled Bun binary sees an empty `process.env` inside some sandboxes (oven-sh/bun#27802). On
 * Linux the real environment is still in `/proc/self/environ`, as NUL-separated `NAME=value`
 * entries. pi's own binary recovers it the same way (pi-coding-agent `dist/bun/`). Losing it
 * silently would drop `PI_SWITCHBOARD_AUTH_TOKEN` and so turn proxy auth off.
 *
 * @packageDocumentation
 */

import { readFileSync } from 'node:fs'

/**
 * Fills `env` from `readEnviron()` when it is empty. A non-empty environment is left alone, and an
 * unreadable source (not Linux, or no permission) leaves it empty and
 * writes one line to stderr saying so, since logging is not configured yet. Values may contain `=`.
 *
 * @param env - the environment to restore, `process.env` by default
 * @param readEnviron - reads the NUL-separated environment, `/proc/self/environ` by default
 */
export function restoreSandboxEnv(
  env: NodeJS.ProcessEnv = process.env,
  readEnviron: () => string = () => readFileSync('/proc/self/environ', 'utf-8')
): void {
  if (Object.keys(env).length > 0) return
  let environ: string
  try {
    environ = readEnviron()
  } catch {
    // Logging is not configured yet, so stderr is the only channel. Never print values.
    process.stderr.write(
      'pi-switchboard: process.env is empty and /proc/self/environ could not be read; ' +
        'starting without environment variables (PI_SWITCHBOARD_AUTH_TOKEN included)\n'
    )
    return
  }
  for (const assignment of environ.split('\0')) {
    const separator = assignment.indexOf('=')
    if (separator > 0) env[assignment.slice(0, separator)] = assignment.slice(separator + 1)
  }
}
