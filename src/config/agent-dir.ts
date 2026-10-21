/**
 * pi's agent directory, resolved without loading pi (#165).
 *
 * @remarks
 * The pi extension loads this package's library entry points inside pi's own process. Importing
 * `getAgentDir` from `@earendil-works/pi-coding-agent` there loaded this package's installed copy of
 * pi next to the host's: a second pi runtime in pi's process, which pi warns about. This is pi
 * 1.3.0's `getAgentDir` for POSIX paths, and `test/unit/agent-dir.test.ts` checks it against pi's own
 * for each case. It does not repeat pi's Windows shell-path conversion (`/c/…` to `C:\…`), as no
 * test can pin it on the Linux test runner.
 *
 * @packageDocumentation
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The home-relative prefix pi expands in a configured path. */
const HOME_PREFIX = '~/'

/**
 * Returns pi's agent directory: `$PI_CODING_AGENT_DIR` when set and non-empty, otherwise
 * `.pi/agent` in the user's home directory.
 *
 * @remarks
 * As pi does, a configured `~` is the home directory, a leading `~/` is joined onto it, and a
 * `file://` URL becomes its path; any other value is used as written.
 *
 * @returns the agent directory
 */
export function piAgentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR
  if (configured === undefined || configured === '') return join(homedir(), '.pi', 'agent')
  if (configured === '~') return homedir()
  if (configured.startsWith(HOME_PREFIX)) {
    return join(homedir(), configured.slice(HOME_PREFIX.length))
  }
  if (configured.startsWith('file://')) return fileURLToPath(configured)
  return configured
}
