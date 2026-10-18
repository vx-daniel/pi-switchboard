/**
 * A compiled Bun binary sees an empty `process.env` inside some sandboxes (oven-sh/bun#27802). On
 * Linux the real environment is still in `/proc/self/environ`, as NUL-separated `NAME=value`
 * entries. pi's own binary recovers it the same way (pi-coding-agent `dist/bun/`). Losing it
 * silently would drop `PI_PROXY_AUTH_TOKEN` and so turn proxy auth off.
 */

import { readFileSync } from 'node:fs'

/**
 * Fill `env` from `readEnviron()` when it is empty. A non-empty environment is left alone, and an
 * unreadable source (not Linux, or no permission) leaves it empty. Values may contain `=`.
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
    return
  }
  for (const assignment of environ.split('\0')) {
    const separator = assignment.indexOf('=')
    if (separator > 0) env[assignment.slice(0, separator)] = assignment.slice(separator + 1)
  }
}
