/**
 * The variables a spawned process needs from its platform, for tests that start one with an
 * otherwise empty environment (`test/binary`).
 *
 * @packageDocumentation
 */

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
