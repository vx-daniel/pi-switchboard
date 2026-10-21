/**
 * The container image's entrypoint (`docker/entrypoint.sh`, #60). The image listens on every
 * interface and serves the pi login in its volume, so the script refuses to start the proxy
 * without a bearer token; with one, it hands the container's arguments to the proxy unchanged.
 * The one exception is an info flag alone (`--version`, `--help`), which starts no server (#168).
 */

import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, describe, expect, test } from 'vite-plus/test'

const ENTRYPOINT = fileURLToPath(new URL('../../docker/entrypoint.sh', import.meta.url))

/** The status the script exits with when the token is missing (EX_USAGE). */
const EXIT_NO_TOKEN = 64

/** A directory holding a stand-in `node` that prints what it was asked to run. */
const STUB_BIN = mkdtempSync(join(tmpdir(), 'entrypoint-test-'))
writeFileSync(join(STUB_BIN, 'node'), '#!/bin/sh\necho "node $*"\n')
chmodSync(join(STUB_BIN, 'node'), 0o755)

afterAll(() => {
  rmSync(STUB_BIN, { recursive: true, force: true })
})

/**
 * Runs the entrypoint with only the variables given: nothing from the developer's environment.
 *
 * @param env - the variables to set, besides `PATH`
 * @param args - the container's arguments
 * @returns the exit status and both streams
 */
function runEntrypoint(
  env: Readonly<Record<string, string>>,
  args: readonly string[] = []
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('sh', [ENTRYPOINT, ...args], {
    env: { PATH: `${STUB_BIN}:/usr/bin:/bin`, ...env },
    encoding: 'utf8'
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe('docker/entrypoint.sh', () => {
  // Catches the image starting a proxy anyone on the network can use: without a token, or with an
  // empty one, it must stop before the proxy runs, and say which variable to set.
  test.each([
    ['unset', {}],
    ['empty', { PI_SWITCHBOARD_AUTH_TOKEN: '' }]
  ])('refuses to start with the token %s', (_case, env) => {
    const result = runEntrypoint(env)

    expect(result.status).toBe(EXIT_NO_TOKEN)
    expect(result.stderr).toContain('set PI_SWITCHBOARD_AUTH_TOKEN')
    expect(result.stdout).toBe('')
  })

  // Catches the guard passing but the proxy not started as the image documents, or the container's
  // arguments (`docker run … --log-level debug`) lost on the way.
  test('starts the proxy with the container arguments when the token is set', () => {
    const result = runEntrypoint({ PI_SWITCHBOARD_AUTH_TOKEN: 'notarealsecret-token' }, [
      '--log-level',
      'debug'
    ])

    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe('node /app/dist/index.mjs --log-level debug')
  })

  // Catches `docker run --rm <image> --version` refused for want of a token, though it serves
  // nothing (#168).
  test.each(['--version', '-v', '--help', '-h'])('runs %s alone without a token', (flag) => {
    const result = runEntrypoint({}, [flag])

    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe(`node /app/dist/index.mjs ${flag}`)
  })

  // Catches the exception widened past an info flag alone, the only shape the CLI test pins as
  // starting no server: the flag beside other arguments (`--version --port 4141`), the flag as an
  // option's value (`--host --help`, matched by a looser check such as "any argument is --help"),
  // or a prefix match (`--versions`). Each still needs the token.
  test.each([
    ['--version beside another argument', ['--version', '--port', '4141']],
    ['an info flag as a value', ['--host', '--help']],
    ['a near miss', ['--versions']]
  ])('still refuses without a token: %s', (_case, args) => {
    const result = runEntrypoint({}, args)

    expect(result.status).toBe(EXIT_NO_TOKEN)
    expect(result.stdout).toBe('')
  })
})
