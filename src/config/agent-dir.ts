/**
 * pi's agent directory, resolved without loading pi (#165).
 *
 * @remarks
 * The pi extension loads this package's library entry points inside pi's own process. Importing
 * `getAgentDir` from `@earendil-works/pi-coding-agent` there loaded this package's installed copy of
 * pi next to the host's: a second pi runtime in pi's process, which pi warns about. This is pi
 * 1.3.0's `getAgentDir`, Windows shell paths included, and `test/unit/agent-dir.test.ts` checks it
 * against pi's own for each case.
 *
 * @packageDocumentation
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The home-relative prefix pi expands in a configured path. */
const HOME_PREFIX = '~/'
/** The same prefix with Windows' separator, which pi also expands on Windows. */
const WINDOWS_HOME_PREFIX = '~\\'

/** A Git Bash, MSYS, Cygwin or WSL drive path: `/c/…`, `/mnt/c/…`, `/cygdrive/c/…`. */
const SHELL_DRIVE_PATH = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i

/**
 * Converts a Windows shell drive path to the native form, as pi's `normalizeWindowsShellPath`
 * does: `/c/Users/me` becomes `C:\Users\me`. A UNC path (`//server`), a path with a backslash, and
 * anything else are left as they are.
 *
 * @param path - the configured path
 * @returns the native Windows path, or `path` unchanged
 */
function windowsShellPath(path: string): string {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return path
  const match = SHELL_DRIVE_PATH.exec(path)
  const drive = match?.[1]
  if (drive === undefined) return path
  return `${drive.toUpperCase()}:\\${match?.[2]?.replaceAll('/', '\\') ?? ''}`
}

/**
 * Returns pi's agent directory: `$PI_CODING_AGENT_DIR` when set and non-empty, otherwise
 * `.pi/agent` in the user's home directory.
 *
 * @remarks
 * As pi does, on Windows a shell drive path is converted first; then a configured `~` is the home
 * directory, a leading `~/` (or `~\` on Windows) is joined onto it, and a `file://` URL becomes its
 * path. Any other value is used as written.
 *
 * @returns the agent directory
 */
export function piAgentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR
  if (configured === undefined || configured === '') return join(homedir(), '.pi', 'agent')
  const onWindows = process.platform === 'win32'
  const path = onWindows ? windowsShellPath(configured) : configured
  if (path === '~') return homedir()
  if (path.startsWith(HOME_PREFIX) || (onWindows && path.startsWith(WINDOWS_HOME_PREFIX))) {
    return join(homedir(), path.slice(HOME_PREFIX.length))
  }
  if (path.startsWith('file://')) return fileURLToPath(path)
  return path
}
