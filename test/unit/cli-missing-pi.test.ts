/**
 * The CLI entry (`src/index.ts`) when pi's packages are missing: they are optional dependencies
 * (#165), so an install with `--omit=optional` leaves them out. Each case mocks
 * `@earendil-works/pi-ai` to fail as Node fails for a package that is not installed, then loads the
 * entry, which loads the CLI. The mock factory runs on the first import, which is that load.
 */

import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

/** What the mocked package throws when it is loaded: replaced per test. */
let loadFailure: Error = new Error('unset')

vi.mock('@earendil-works/pi-ai', () => {
  throw loadFailure
})

/** Everything written to stderr during a case. */
let stderr: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
  process.exitCode = undefined
  stderr = []
})

/**
 * Builds the error Node throws for a package that is not installed.
 *
 * @param packageName - the missing package
 * @returns the error, with Node's code and wording
 */
function notInstalled(packageName: string): Error {
  return Object.assign(
    new Error(`Cannot find package '${packageName}' imported from /app/dist/cli.mjs`),
    { code: 'ERR_MODULE_NOT_FOUND' }
  )
}

/**
 * Loads the CLI entry with stderr captured.
 *
 * @returns how the load settled
 */
async function loadEntry(): Promise<PromiseSettledResult<unknown>> {
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  })
  const [settled] = await Promise.allSettled([import('@proxy/index')])
  return settled
}

describe('the CLI entry without pi', () => {
  // Catches a stack trace instead of the cause and the fix when an install left pi out: the CLI
  // cannot start, and the user must learn why and how to fix it.
  test('names the missing package and the fix, and exits 1', async () => {
    loadFailure = notInstalled('@earendil-works/pi-ai')

    const settled = await loadEntry()

    expect(settled.status).toBe('fulfilled')
    expect(stderr.join('')).toContain('@earendil-works/pi-ai is not installed')
    expect(stderr.join('')).toContain('reinstall without --omit=optional')
    expect(process.exitCode).toBe(1)
  })

  // Catches every load failure dressed up as a missing pi: anything else must surface unchanged.
  test('rethrows any other failure', async () => {
    loadFailure = new Error('something else broke')

    const settled = await loadEntry()

    expect(settled.status).toBe('rejected')
    expect(stderr.join('')).not.toContain('is not installed')
  })
})
