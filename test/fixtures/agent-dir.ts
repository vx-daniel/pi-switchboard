/**
 * A throwaway pi agent directory for a test: pi reads `models.json` and `auth.json` from it, so a
 * test decides exactly which providers, models and credentials exist, with no real login.
 *
 * @packageDocumentation
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initRegistry } from '@proxy/pi/registry'
import { vi } from 'vite-plus/test'

/** The files {@link loadFixtureAgentDir} writes into the agent directory; each one is optional. */
export interface FixtureAgentDirFiles {
  /** Written as JSON. */
  readonly modelsJson?: unknown
  /** Written as is, for a models.json that is deliberately broken. Wins over `modelsJson`. */
  readonly modelsJsonText?: string
  /** Written as JSON, owner-only, as pi expects. */
  readonly authJson?: unknown
  /** Written as is, owner-only, for an auth.json pi cannot read. Wins over `authJson`. */
  readonly authJsonText?: string
}

/** A loaded fixture agent directory: where it is, and how to delete it. */
export interface FixtureAgentDir {
  /** Absolute path of the temp directory, also set as `PI_CODING_AGENT_DIR`. */
  readonly path: string
  /** Delete the directory. The `PI_CODING_AGENT_DIR` stub is undone by `vi.unstubAllEnvs()`. */
  remove(): void
}

/** File mode for `auth.json`: read and write for the owner only. */
const OWNER_ONLY = 0o600

/** A base URL nothing listens on: a request that reaches it fails at once, on this machine. */
const UNREACHABLE_BASE_URL = 'http://127.0.0.1:9/v1'

/**
 * Builds a `models.json` provider entry with a literal fake key and these models, at an address
 * nothing listens on: for tests whose requests are answered (or refused) before any upstream call.
 *
 * @param models - the provider's models: a bare ID, or an object for extra fields such as
 *   `input: ['text', 'image']`
 * @returns the provider entry, to put under `providers.<name>` in `models.json`
 */
export function offlineProvider(
  ...models: (string | { readonly id: string; readonly [field: string]: unknown })[]
): Record<string, unknown> {
  return {
    baseUrl: UNREACHABLE_BASE_URL,
    api: 'openai-completions',
    apiKey: 'notarealsecret-fixture-provider-key',
    models: models.map((model) => (typeof model === 'string' ? { id: model } : model))
  }
}

/**
 * Writes the files into a new temp directory, points pi at it (`PI_CODING_AGENT_DIR`) and loads
 * pi's model runtime from it.
 *
 * @remarks
 * The environment variable is stubbed with `vi.stubEnv`, so `vi.unstubAllEnvs()` undoes it. A
 * `models.json` that fails to load does not reject: `initRegistry` logs it and pi keeps only its
 * built-in models.
 *
 * @param files - the files to write; none by default, which gives an empty agent directory
 * @returns the directory's path and a `remove()` that deletes it
 */
export async function loadFixtureAgentDir(
  files: FixtureAgentDirFiles = {}
): Promise<FixtureAgentDir> {
  const path = mkdtempSync(join(tmpdir(), 'pi-proxy-fixture-'))
  const modelsJson =
    files.modelsJsonText ??
    (files.modelsJson === undefined ? undefined : JSON.stringify(files.modelsJson))
  if (modelsJson !== undefined) writeFileSync(join(path, 'models.json'), modelsJson)
  const authJson =
    files.authJsonText ??
    (files.authJson === undefined ? undefined : JSON.stringify(files.authJson))
  if (authJson !== undefined) {
    writeFileSync(join(path, 'auth.json'), authJson, { mode: OWNER_ONLY })
  }
  vi.stubEnv('PI_CODING_AGENT_DIR', path)
  await initRegistry()
  return {
    path,
    remove() {
      rmSync(path, { recursive: true, force: true })
    }
  }
}
