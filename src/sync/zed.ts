/**
 * Zed settings.json model sync.
 *
 * @remarks
 * Discovers Zed's settings file, maps exposed proxy models to Zed's `openai_compatible`
 * `available_models` shape, and writes them back with jsonc-parser's `modify()`, which keeps
 * comments and formatting.
 *
 * @packageDocumentation
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { proxyLogger } from '@proxy/logging'
import type { ExposedModel } from '@proxy/openai/model-exposure'
import { errorCode } from '@proxy/utils/guards'
import {
  applyEdits,
  type ModificationOptions,
  modify,
  type ParseError,
  parse,
  printParseErrorCode
} from 'jsonc-parser'
import * as z from 'zod'

/** Logger for the Zed sync. */
const zedLogger = proxyLogger('sync', 'zed')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One entry of a Zed `openai_compatible` provider's `available_models`. */
export interface ZedAvailableModel {
  readonly name: string
  readonly display_name: string
  readonly max_tokens: number
  readonly max_output_tokens: number
  readonly capabilities: {
    readonly tools: boolean
    readonly images: boolean
    readonly parallel_tool_calls: boolean
    readonly prompt_cache_key: boolean
    readonly chat_completions: boolean
  }
}

/** What a Zed sync writes, and whether it writes at all. */
export interface ZedSyncOptions {
  /** Provider label in Zed settings (e.g. "Pi Proxy"). */
  readonly providerName: string
  /** API URL written into the provider block. */
  readonly apiUrl: string
  /** Preview changes without writing to disk. */
  readonly dryRun: boolean
}

/** The outcome of a Zed sync: where, what changed, or why it did not happen. */
export interface ZedSyncResult {
  readonly ok: boolean
  readonly configPath: string
  readonly added: number
  readonly removed: number
  readonly unchanged: number
  readonly summary: string
  readonly error?: string | undefined
}

// ---------------------------------------------------------------------------
// Settings file discovery
// ---------------------------------------------------------------------------

/** A place Zed's settings.json may be, and the variable that put it on the list. */
interface SettingsCandidate {
  readonly source: 'CUSTOM_DATA_DIR' | 'XDG_CONFIG_HOME' | 'HOME'
  readonly settingsPath: string
}

/**
 * Lists where Zed's global settings.json may be, in the order they are tried.
 *
 * @remarks
 * 1. `$CUSTOM_DATA_DIR/settings.json`: the proxy's own override. Zed reads no such variable: its
 *    `--user-data-dir` flag sets an internal `CUSTOM_DATA_DIR` and puts settings at
 *    `<dir>/config/settings.json` (Zed's `crates/paths/src/paths.rs`, `config_dir`).
 * 2. `$XDG_CONFIG_HOME/zed/settings.json`: Zed on Linux uses this when the variable is set.
 * 3. `$HOME/.config/zed/settings.json`: Zed on macOS, and on Linux without XDG_CONFIG_HOME.
 *
 * A variable that is unset or empty adds no candidate. `XDG_CONFIG_HOME` is honoured on every
 * platform, though Zed reads it on Linux only; it is rarely set on macOS, where Zed uses 3.
 *
 * @returns the candidates, possibly none
 */
function zedSettingsCandidates(): SettingsCandidate[] {
  const candidates: SettingsCandidate[] = []
  const customDir = process.env.CUSTOM_DATA_DIR
  if (customDir !== undefined && customDir.length > 0) {
    candidates.push({
      source: 'CUSTOM_DATA_DIR',
      settingsPath: resolve(customDir, 'settings.json')
    })
  }
  const xdg = process.env.XDG_CONFIG_HOME
  if (xdg !== undefined && xdg.length > 0) {
    candidates.push({
      source: 'XDG_CONFIG_HOME',
      settingsPath: resolve(xdg, 'zed', 'settings.json')
    })
  }
  const home = process.env.HOME
  if (home !== undefined && home.length > 0) {
    candidates.push({
      source: 'HOME',
      settingsPath: resolve(home, '.config', 'zed', 'settings.json')
    })
  }
  return candidates
}

/**
 * Finds Zed's global settings.json: the first of {@link zedSettingsCandidates} that exists.
 *
 * @returns the settings path, or `undefined` when none of the candidates exists
 */
export function findZedSettings(): string | undefined {
  const candidates = zedSettingsCandidates()
  for (const { source, settingsPath } of candidates) {
    if (existsSync(settingsPath)) {
      zedLogger.debug('Found Zed settings at {settingsPath} (from {source})', {
        settingsPath,
        source
      })
      return settingsPath
    }
    zedLogger.debug('No Zed settings at {settingsPath} (from {source})', { settingsPath, source })
  }

  zedLogger.debug('Zed settings not found after checking {candidateCount} locations', {
    candidateCount: candidates.length
  })
  return undefined
}

/**
 * Describes where the settings were looked for, for the not-found error.
 *
 * @returns the checked paths, each once, or what to set when there was nowhere to look
 */
function checkedLocations(): string {
  const paths = [...new Set(zedSettingsCandidates().map((candidate) => candidate.settingsPath))]
  return paths.length > 0
    ? `Checked ${paths.join(', ')}`
    : 'Nowhere to look: set HOME or XDG_CONFIG_HOME'
}

// ---------------------------------------------------------------------------
// Model mapping
// ---------------------------------------------------------------------------

/**
 * Maps an exposed model to Zed's `available_models` entry.
 *
 * @remarks
 * The public ID becomes `name`; tools, parallel tool calls, chat completions and
 * `prompt_cache_key` are always on, and images follow the model's input types. With
 * `prompt_cache_key` on, Zed may send a key per thread, which the proxy passes to pi as its
 * session ID (#39).
 *
 * @param exposed - the exposed model
 * @returns the Zed entry
 */
export function toZedModel(exposed: ExposedModel): ZedAvailableModel {
  const model = exposed.model
  return {
    name: exposed.publicId,
    display_name: model.name,
    max_tokens: model.contextWindow,
    max_output_tokens: model.maxTokens,
    capabilities: {
      tools: true,
      images: model.input.includes('image'),
      parallel_tool_calls: true,
      prompt_cache_key: true,
      chat_completions: true
    }
  }
}

// ---------------------------------------------------------------------------
// JSONC surgical edit
// ---------------------------------------------------------------------------

/** jsonc-parser edit options: replace rather than insert into arrays, two-space indent, LF. */
const MODIFY_OPTIONS: ModificationOptions = {
  isArrayInsertion: false,
  formattingOptions: {
    tabSize: 2,
    insertSpaces: true,
    eol: '\n'
  }
}

/** The part of Zed's settings the sync reads. Other keys pass unchecked; the file keeps them. */
const ZedSettingsSchema = z.object({
  language_models: z.object({
    // Keys untrimmed: a provider name is matched exactly, as the sync writes to that exact path.
    openai_compatible: z.record(z.string(), z.unknown())
  })
})

/** A Zed provider block with an `available_models` array. */
const ZedProviderBlockSchema = z.object({ available_models: z.array(z.unknown()) })

/**
 * Names as Zed's file holds them, so the added/removed/unchanged counts describe the file. Not
 * `z.string().trim()`: they are compared verbatim with the names the sync writes.
 */
const ZedModelNameSchema = z.object({
  name: z.custom<string>((value) => typeof value === 'string', 'expected a string')
})

/**
 * Parses Zed settings as Zed does: JSONC, trailing commas allowed.
 *
 * @remarks
 * Any other error means Zed cannot load the file either, and an edit made from a partial parse
 * could land in the wrong place.
 *
 * A file with no value at all (empty, blank, or only comments) is not malformed but empty: it
 * parses as `{}`, and the sync writes the provider block into it as it would into `{}`.
 *
 * @param text - the settings file's text
 * @returns the parsed root and the parse errors; no errors means the file can be edited
 */
function parseSettings(text: string): { root: unknown; errors: ParseError[] } {
  const errors: ParseError[] = []
  const root: unknown = parse(text, errors, { allowTrailingComma: true })
  const noValue =
    root === undefined &&
    errors.every((error) => printParseErrorCode(error.error) === 'ValueExpected')
  return noValue ? { root: {}, errors: [] } : { root, errors }
}

/**
 * Finds the 1-based line and column of `offset` in `text`, for an error a person can find in their
 * editor.
 *
 * @param text - the file's text
 * @param offset - a character offset into `text`
 * @returns the line and column
 */
function lineAndColumn(text: string, offset: number): { line: number; column: number } {
  const lines = text.slice(0, offset).split('\n')
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 }
}

/**
 * Refuses to touch settings that do not parse; the log and the result carry positions only.
 *
 * @param configPath - the settings file's path
 * @param text - the settings file's text, for the error position
 * @param errors - the parse errors; the first one is reported
 * @returns a failed result naming the first error's kind and position
 */
function refuseMalformed(configPath: string, text: string, errors: ParseError[]): ZedSyncResult {
  const [firstError] = errors
  const errorKind = firstError === undefined ? 'unknown' : printParseErrorCode(firstError.error)
  const { line, column } = lineAndColumn(text, firstError?.offset ?? 0)
  // Positions and error kinds only: the text around the fault is the user's settings.
  zedLogger.error(
    'Zed settings {configPath} has {parseErrorCount} JSONC errors; leaving it untouched',
    { configPath, parseErrorCount: errors.length, firstErrorCode: errorKind, line, column }
  )
  return {
    ok: false,
    configPath,
    added: 0,
    removed: 0,
    unchanged: 0,
    summary: '',
    error: `Zed settings.json has syntax errors (${errorKind} at line ${String(line)}, column ${String(column)}); fix them in Zed, then sync again`
  }
}

/**
 * Reads the model names in a provider's `available_models` from parsed Zed settings.
 *
 * @param root - the parsed settings
 * @param providerName - the `openai_compatible` provider name, matched exactly
 * @returns the names that are strings, or an empty array when the provider block or its
 *   `available_models` array does not exist
 */
function readCurrentModelNames(root: unknown, providerName: string): string[] {
  const settings = ZedSettingsSchema.safeParse(root)
  const provider = settings.success
    ? settings.data.language_models.openai_compatible[providerName]
    : undefined
  if (provider === undefined) {
    zedLogger.debug('No existing Zed provider block for {providerName}', { providerName })
    return []
  }

  const block = ZedProviderBlockSchema.safeParse(provider)
  if (!block.success) {
    zedLogger.debug('Zed provider {providerName} has no available_models array', { providerName })
    return []
  }

  const names: string[] = []
  for (const availableModel of block.data.available_models) {
    const parsed = ZedModelNameSchema.safeParse(availableModel)
    if (parsed.success) names.push(parsed.data.name)
  }
  return names
}

/**
 * Writes the provider block (`api_url` and `available_models`) into the JSONC text.
 *
 * @remarks
 * The whole block at `language_models.openai_compatible.<providerName>` is replaced, so any other
 * key in it is dropped; the rest of the file keeps its comments and formatting.
 *
 * @param text - the settings file's text
 * @param providerName - the `openai_compatible` provider name
 * @param apiUrl - the proxy's API URL
 * @param models - the models to list
 * @returns the new text
 */
function applyProviderBlock(
  text: string,
  providerName: string,
  apiUrl: string,
  models: readonly ZedAvailableModel[]
): string {
  const providerBlock = {
    api_url: apiUrl,
    available_models: models
  }

  const edits = modify(
    text,
    ['language_models', 'openai_compatible', providerName],
    providerBlock,
    MODIFY_OPTIONS
  )

  return applyEdits(text, edits)
}

/**
 * Reads the settings file, logging a failure before it propagates.
 *
 * @param configPath - the settings file's path
 * @returns the file's text
 * @throws the `readFileSync` error when the file cannot be read
 */
function readSettingsText(configPath: string): string {
  try {
    return readFileSync(configPath, 'utf-8')
  } catch (error) {
    zedLogger.error('Failed to read Zed settings {configPath} ({code})', {
      configPath,
      code: errorCode(error)
    })
    throw error
  }
}

/**
 * Writes the settings file, logging a failure before it propagates.
 *
 * @param configPath - the settings file's path
 * @param text - the new text
 * @throws the `writeFileSync` error when the file cannot be written
 */
function writeSettingsText(configPath: string, text: string): void {
  try {
    writeFileSync(configPath, text, 'utf-8')
  } catch (error) {
    zedLogger.error('Failed to write Zed settings {configPath} ({code})', {
      configPath,
      code: errorCode(error)
    })
    throw error
  }
}

/**
 * Counts how the new model names differ from the ones already in Zed settings.
 *
 * @param currentNames - the names in the file now
 * @param newNames - the names the sync writes
 * @returns how many are added, removed and unchanged
 */
function countModelChanges(
  currentNames: ReadonlySet<string>,
  newNames: ReadonlySet<string>
): { added: number; removed: number; unchanged: number } {
  let added = 0
  let removed = 0
  let unchanged = 0

  for (const modelName of newNames) {
    if (currentNames.has(modelName)) {
      unchanged += 1
    } else {
      added += 1
    }
  }
  for (const modelName of currentNames) {
    if (!newNames.has(modelName)) {
      removed += 1
    }
  }
  return { added, removed, unchanged }
}

// ---------------------------------------------------------------------------
// Public sync API
// ---------------------------------------------------------------------------

/**
 * Syncs exposed models into Zed's settings.json, under the provider named in `options`.
 *
 * @remarks
 * A file that does not parse is left untouched. A dry run reads and counts but writes nothing.
 *
 * @param exposedModels - the models the proxy exposes
 * @param options - the provider name, API URL and dry-run flag
 * @returns the counts and summary, or a failed result when the settings file is missing or
 *   malformed
 * @throws the file system error when the settings file cannot be read or written
 */
export function syncToZed(
  exposedModels: readonly ExposedModel[],
  options: ZedSyncOptions
): ZedSyncResult {
  const configPath = findZedSettings()
  if (configPath === undefined) {
    zedLogger.warn('Zed sync skipped: settings.json not found')
    return {
      ok: false,
      configPath: '',
      added: 0,
      removed: 0,
      unchanged: 0,
      summary: '',
      error: `Zed settings.json not found. ${checkedLocations()}`
    }
  }

  const originalText = readSettingsText(configPath)
  const { root, errors } = parseSettings(originalText)
  if (errors.length > 0) return refuseMalformed(configPath, originalText, errors)
  const currentNames = new Set(readCurrentModelNames(root, options.providerName))
  const zedModels = exposedModels.map(toZedModel)
  const newNames = new Set(zedModels.map((zedModel) => zedModel.name))

  const { added, removed, unchanged } = countModelChanges(currentNames, newNames)

  const parts: string[] = []
  if (added > 0) parts.push(`${String(added)} added`)
  if (removed > 0) parts.push(`${String(removed)} removed`)
  if (unchanged > 0) parts.push(`${String(unchanged)} unchanged`)
  const summary = parts.length > 0 ? parts.join(', ') : 'no changes'

  const outcome = {
    configPath,
    providerName: options.providerName,
    modelCount: zedModels.length,
    added,
    removed,
    unchanged,
    dryRun: options.dryRun
  }

  if (options.dryRun) {
    zedLogger.info('Zed sync dry run for {configPath}: {summary}', { ...outcome, summary })
    return {
      ok: true,
      configPath,
      added,
      removed,
      unchanged,
      summary: `[dry-run] ${summary}`
    }
  }

  const newText = applyProviderBlock(originalText, options.providerName, options.apiUrl, zedModels)
  writeSettingsText(configPath, newText)
  zedLogger.info('Wrote {modelCount} models to Zed settings {configPath}: {summary}', {
    ...outcome,
    summary,
    bytesWritten: Buffer.byteLength(newText, 'utf-8')
  })

  return {
    ok: true,
    configPath,
    added,
    removed,
    unchanged,
    summary
  }
}
