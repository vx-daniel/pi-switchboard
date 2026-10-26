/**
 * The platform side of the binary tests (`test/binary`): which binary they run, and the
 * variables a process started with an otherwise empty environment needs.
 *
 * @packageDocumentation
 */

import { resolve } from 'node:path'

/**
 * Returns the binary the tests run: `PI_SWITCHBOARD_BINARY` when set (the Windows workflow job
 * points it at the release file it downloaded), else the host build `pnpm run build:binary`
 * writes.
 *
 * @returns the binary's absolute path
 */
export function binaryUnderTest(): string {
  const host =
    process.platform === 'win32' ? 'dist-bin/pi-switchboard.exe' : 'dist-bin/pi-switchboard'
  return resolve(process.env['PI_SWITCHBOARD_BINARY'] ?? host)
}

/**
 * Returns what a process started with `home` as its home needs on this platform: on Windows, the
 * home is `USERPROFILE` rather than `HOME`, and a process without `SystemRoot` cannot open
 * sockets. Elsewhere nothing beyond `HOME`.
 *
 * @param home - the home directory to give the process
 * @returns the variables to add to its environment
 */
export function platformEnv(home: string): Record<string, string> {
  if (process.platform !== 'win32') return {}
  return { USERPROFILE: home, SystemRoot: process.env['SystemRoot'] ?? 'C:\\Windows' }
}
