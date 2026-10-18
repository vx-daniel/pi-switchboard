#!/usr/bin/env node
/**
 * Compile the standalone binary (`src/standalone/main.ts`) with `bun build --compile`.
 *
 *   node scripts/build-binary.ts         the host platform, to dist-bin/pi-openai-proxy
 *   node scripts/build-binary.ts --all   every release target, to dist-bin/pi-openai-proxy-<target>,
 *                                        plus dist-bin/SHA256SUMS
 *
 * Bun is the compiler only: the npm package still runs on Node. One Linux machine builds every
 * target. The two autoload flags are the ones pi's own binary uses: without them a compiled binary
 * reads `.env` and `bunfig.toml` from the directory it is started in, so a stray `.env` there could
 * set `PI_PROXY_HOST` or `PI_PROXY_AUTH_TOKEN`. `test/binary/` holds that to account.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ENTRY = 'src/standalone/main.ts'
const OUT_DIR = 'dist-bin'
const NAME = 'pi-openai-proxy'

/** Release targets, as Bun names them after `bun-`. Windows is not one yet (#61). */
const RELEASE_TARGETS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'] as const

const COMPILE_FLAGS = [
  'build',
  '--compile',
  '--no-compile-autoload-dotenv',
  '--no-compile-autoload-bunfig'
]

/** Compile one binary, for the host unless `targetFlags` names a target. Exits when Bun fails. */
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
