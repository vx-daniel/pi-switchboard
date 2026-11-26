/**
 * The admin UI's pages (#367): the files Vite builds into `dist/admin-ui/`, served under `/admin/`
 * by the admin listener, from the package on Node and from the binary itself when compiled.
 *
 * @remarks
 * The assets are a map from a path under `/admin/` (`index.html`, `assets/index-3f2a.js`) to the
 * file holding it. On Node the map is the build directory beside the bundled code
 * (`dist/admin-ui/`). The standalone binary has no such directory: `scripts/build-binary.ts`
 * compiles a generated entry that imports each built file `with { type: 'file' }`, which Bun embeds
 * byte for byte, and registers their embedded paths with {@link registerEmbeddedAdminAssets} before
 * the proxy starts. Either way the files are read with `node:fs`, which reads Bun's embedded files
 * too. Nothing else on disk can be reached: a path that is not in the map is not served.
 *
 * @packageDocumentation
 */

import { readdir, readFile } from 'node:fs/promises'
import { extname, join, relative, sep as pathSeparator } from 'node:path'
import { fileURLToPath } from 'node:url'

import { errorCode } from '@proxy/utils/guards'

/** A path under `/admin/` -> the file that holds it. */
export type AdminAssets = ReadonlyMap<string, string>

/** One asset, read. */
export interface AdminAsset {
  readonly body: Uint8Array<ArrayBuffer>
  readonly type: string
}

/** The content types of the files Vite and the stylesheets emit; anything else is bytes. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json'
}

/** The embedded assets the standalone binary registered, if it did. */
let embedded: AdminAssets | undefined

/**
 * Registers the assets the standalone binary embeds, before the proxy starts.
 *
 * @param files - a path under `/admin/` -> the embedded file's path
 */
export function registerEmbeddedAdminAssets(files: Readonly<Record<string, string>>): void {
  embedded = new Map(Object.entries(files))
}

/**
 * Lists a build directory's files as assets, by their path under it with `/` separators.
 *
 * @param directory - the build directory
 * @returns the assets, or `undefined` when the directory does not exist (pages not built)
 * @throws whatever reading the directory throws, but its absence
 */
export async function directoryAssets(directory: string): Promise<AdminAssets | undefined> {
  try {
    const entries = await readdir(directory, { recursive: true, withFileTypes: true })
    const files = entries
      .filter((dirent) => dirent.isFile())
      .map((dirent) => join(dirent.parentPath, dirent.name))
    return new Map(
      files.map((file) => [relative(directory, file).split(pathSeparator).join('/'), file])
    )
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Finds the admin UI's pages: the ones the binary embedded, or the build beside the bundled code.
 *
 * @returns the assets, or `undefined` when this build has none
 */
export async function adminAssets(): Promise<AdminAssets | undefined> {
  // Bundled into `dist/`, the code sits beside `dist/admin-ui/`.
  return embedded ?? directoryAssets(fileURLToPath(new URL('admin-ui/', import.meta.url)))
}

/**
 * Reads one asset.
 *
 * @param assets - the assets
 * @param path - its path under `/admin/`
 * @returns the asset, or `undefined` when there is none at that path
 */
export async function readAdminAsset(
  assets: AdminAssets,
  path: string
): Promise<AdminAsset | undefined> {
  const file = assets.get(path)
  if (file === undefined) return undefined
  const type = CONTENT_TYPES[extname(path)] ?? 'application/octet-stream'
  return { body: new Uint8Array(await readFile(file)), type }
}
