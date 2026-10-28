#!/usr/bin/env node
/**
 * Compile the standalone binary (`src/standalone/main.ts`) with `bun build --compile`.
 *
 *   node scripts/build-binary.ts            the host platform, to dist-bin/pi-switchboard
 *                                           (pi-switchboard.exe on Windows)
 *   node scripts/build-binary.ts --all      the Linux and macOS release targets, to
 *                                           dist-bin/pi-switchboard-<target>, plus SHA256SUMS
 *   node scripts/build-binary.ts --windows  the Windows targets, to
 *                                           dist-bin/pi-switchboard-<target>.exe, plus
 *                                           SHA256SUMS-windows; on Windows only
 *
 * Bun is the compiler only: the npm package still runs on Node. One Linux machine builds the Linux
 * and macOS targets. The two autoload flags are the ones pi's own binary uses: without them a
 * compiled binary reads `.env` and `bunfig.toml` from the directory it is started in, so a stray
 * `.env` there could set `PI_SWITCHBOARD_HOST` or `PI_SWITCHBOARD_AUTH_TOKEN`. `test/binary/`
 * holds that to account.
 *
 * A Windows binary carries the icon `assets/pi-switchboard.ico`, the 256 to 16 pixel sizes of
 * `assets/pi-switchboard-icon.png` (`magick pi-switchboard-icon.png -define
 * icon:auto-resize=256,128,64,48,32,16 pi-switchboard.ico`). Bun sets it (`--windows-icon`) only
 * when it compiles on Windows, which is why the Windows targets are built there. Linux and macOS
 * executables have no place for an icon.
 *
 * @packageDocumentation
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The binary's entry: the proxy after pi's Bun setup. */
const ENTRY = 'src/standalone/main.ts'
/** Where the binaries and their checksum files are written; git-ignored. */
const OUT_DIR = 'dist-bin'
/** The host binary's file name, and the prefix of each release target's. */
const NAME = 'pi-switchboard'

/** A set of release targets, built together, with its checksum file. */
interface TargetSet {
  /** The targets, as Bun names them after `bun-`. */
  readonly targets: readonly string[]
  /** The binaries' file extension. */
  readonly extension: string
  /** The checksum file listing them. */
  readonly sums: string
  /** `bun build` flags these targets add to `COMPILE_FLAGS`. */
  readonly flags: readonly string[]
}

/** The Linux and macOS targets: what the release workflow builds for every release. */
const UNIX: TargetSet = {
  targets: ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'],
  extension: '',
  sums: 'SHA256SUMS',
  flags: []
}

/** The Windows targets: built on a Windows runner (`binary.yml` with `platforms: windows`). */
const WINDOWS: TargetSet = {
  targets: ['windows-x64', 'windows-arm64'],
  extension: '.exe',
  sums: 'SHA256SUMS-windows',
  flags: ['--windows-icon', 'assets/pi-switchboard.ico']
}

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
 * @param targetFlags - `--target bun-<os>-<arch>` and the set's `flags`, or the host's flags
 */
function compile(outfile: string, targetFlags: readonly string[]): void {
  const result = spawnSync('bun', [...COMPILE_FLAGS, ...targetFlags, ENTRY, '--outfile', outfile], {
    stdio: 'inherit'
  })
  if (result.status === 0) return
  // `status` is null when bun could not start (not installed) or was killed; `error` then says why.
  const reason = result.error === undefined ? '' : `: ${result.error.message}`
  process.stderr.write(`build-binary: bun build failed for ${outfile}${reason}\n`)
  process.exit(result.status ?? 1)
}

/**
 * Builds every target of a set into a clean output directory, then writes its checksum file.
 *
 * @param set - the targets to build
 */
function buildSet(set: TargetSet): void {
  rmSync(OUT_DIR, { recursive: true, force: true })
  mkdirSync(OUT_DIR, { recursive: true })
  const sums = set.targets.map((target) => {
    const file = `${NAME}-${target}${set.extension}`
    compile(join(OUT_DIR, file), ['--target', `bun-${target}`, ...set.flags])
    const digest = createHash('sha256')
      .update(readFileSync(join(OUT_DIR, file)))
      .digest('hex')
    return `${digest}  ${file}`
  })
  writeFileSync(join(OUT_DIR, set.sums), `${sums.join('\n')}\n`)
}

if (process.argv.includes('--all')) buildSet(UNIX)
else if (process.argv.includes('--windows')) buildSet(WINDOWS)
else {
  mkdirSync(OUT_DIR, { recursive: true })
  const windows = process.platform === 'win32'
  compile(join(OUT_DIR, windows ? `${NAME}.exe` : NAME), windows ? WINDOWS.flags : UNIX.flags)
}
