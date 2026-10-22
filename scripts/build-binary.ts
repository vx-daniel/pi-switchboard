#!/usr/bin/env node
/**
 * Compile the standalone binary (`src/standalone/main.ts`) with `bun build --compile`.
 *
 *   node scripts/build-binary.ts         the host platform, to dist-bin/pi-switchboard
 *   node scripts/build-binary.ts --all   every release target, to dist-bin/pi-switchboard-<target>,
 *                                        plus dist-bin/SHA256SUMS
 *
 * Bun is the compiler only: the npm package still runs on Node. One Linux machine builds every
 * target. The two autoload flags are the ones pi's own binary uses: without them a compiled binary
 * reads `.env` and `bunfig.toml` from the directory it is started in, so a stray `.env` there could
 * set `PI_SWITCHBOARD_HOST` or `PI_SWITCHBOARD_AUTH_TOKEN`. `test/binary/` holds that to account.
 *
 * @packageDocumentation
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The binary's entry: the proxy after pi's Bun setup. */
const ENTRY = 'src/standalone/main.ts'
/** Where the binaries and `SHA256SUMS` are written; git-ignored. */
const OUT_DIR = 'dist-bin'
/** The host binary's file name, and the prefix of each release target's. */
const NAME = 'pi-switchboard'

/** Release targets, as Bun names them after `bun-`. Windows is not one yet (#61). */
const RELEASE_TARGETS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'] as const

/** `bun build` arguments for every target: compile, without `.env` or `bunfig.toml` autoloading. */
const COMPILE_FLAGS = [
  'build',
  '--compile',
  '--no-compile-autoload-dotenv',
  '--no-compile-autoload-bunfig'
]

/**
 * Compiles one binary, for the host unless `targetFlags` names a target. Exits when Bun fails.
 *
 * @param outfile - where the binary is written
 * @param targetFlags - `--target bun-<os>-<arch>`, or none for the host
 */
function compile(outfile: string, targetFlags: readonly string[] = []): void {
  const result = spawnSync('bun', [...COMPILE_FLAGS, ...targetFlags, ENTRY, '--outfile', outfile], {
    stdio: 'inherit'
  })
  if (result.status === 0) return
  // `status` is null when bun could not start (not installed) or was killed; `error` then says why.
  const reason = result.error === undefined ? '' : `: ${result.error.message}`
  process.stderr.write(`build-binary: bun build failed for ${outfile}${reason}\n`)
  process.exit(result.status ?? 1)
}

mkdirSync(OUT_DIR, { recursive: true })

if (process.argv.includes('--all')) {
  rmSync(OUT_DIR, { recursive: true, force: true })
  mkdirSync(OUT_DIR, { recursive: true })
  const sums: string[] = []
  for (const target of RELEASE_TARGETS) {
    const file = `${NAME}-${target}`
    compile(join(OUT_DIR, file), ['--target', `bun-${target}`])
    sums.push(
      `${createHash('sha256')
        .update(readFileSync(join(OUT_DIR, file)))
        .digest('hex')}  ${file}`
    )
  }
  writeFileSync(join(OUT_DIR, 'SHA256SUMS'), `${sums.join('\n')}\n`)
} else {
  compile(join(OUT_DIR, NAME))
}
