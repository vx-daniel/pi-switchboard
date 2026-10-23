/**
 * Aliases in the exposure engine (`src/openai/model-aliases.ts`, #66), through
 * `computeModelExposure` and `resolveExposedModel`: which aliases are exposed in each mode, what
 * they resolve to, and the warning about aliases named like a model.
 */

import { type Api, getSupportedThinkingLevels, type Model } from '@earendil-works/pi-ai'
import { resetSync } from '@logtape/logtape'
import type { AliasTarget } from '@proxy/config/schema'
import { configureLogging } from '@proxy/logging'
import {
  computeModelExposure,
  type ModelExposureConfig,
  type ModelExposureResult,
  resolveExposedModel
} from '@proxy/openai/model-exposure'
import { afterEach, describe, expect, test } from 'vite-plus/test'

/**
 * Builds a text-only model.
 *
 * @param provider - the provider name
 * @param id - the model ID
 * @returns the model
 */
function makeModel(provider: string, id: string): Model<Api> {
  return {
    id,
    name: id,
    api: 'openai-completions',
    provider,
    baseUrl: `https://${provider}.example.com`,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096
  }
}

/** Two providers that share `gpt-4o`, so collision-prefixed mode prefixes both. */
const MODELS = [
  makeModel('openai', 'gpt-4o'),
  makeModel('codex', 'gpt-4o'),
  makeModel('anthropic', 'claude')
]

/**
 * Computes the exposure of {@link MODELS} with these aliases and settings.
 *
 * @param aliases - alias -> one canonical ID, or a fallback chain
 * @param overrides - exposure settings that differ from scoped, collision-prefixed, unfiltered
 * @returns the exposure; the test fails when the config is invalid
 */
function exposeWith(
  aliases: Record<string, AliasTarget>,
  overrides: Partial<ModelExposureConfig> = {}
): ModelExposureResult {
  const outcome = computeModelExposure(
    MODELS,
    {
      publicModelIdMode: 'collision-prefixed',
      modelExposureMode: 'scoped',
      enabledModels: undefined,
      customModels: [],
      providerPrefixes: {},
      aliases,
      ...overrides
    },
    getSupportedThinkingLevels
  )
  if (!outcome.ok) throw new Error(outcome.message)
  return outcome
}

/**
 * Summarizes what an alias resolves to.
 *
 * @param exposure - the exposure
 * @param name - the requested model
 * @returns the resolved entry's public ID, canonical ID and alias, or `undefined`
 */
function resolved(
  exposure: ModelExposureResult,
  name: string
): Record<string, unknown> | undefined {
  const entry = resolveExposedModel(exposure, name)
  return entry === undefined
    ? undefined
    : { publicId: entry.publicId, canonicalId: entry.canonicalId, alias: entry.alias }
}

describe('which aliases are exposed', () => {
  // Catches an alias reaching a model custom mode leaves out (CONSTITUTION.md, principle IV):
  // only the selected model's alias is exposed, and the other is reported, not resolved.
  test('custom mode: only an alias whose target is selected', () => {
    const exposure = exposeWith(
      { fast: 'openai/gpt-4o', smart: 'anthropic/claude' },
      { modelExposureMode: 'custom', customModels: ['openai/gpt-4o'] }
    )

    expect(exposure.aliases.map((exposedAlias) => exposedAlias.publicId)).toEqual(['fast'])
    expect(resolved(exposure, 'smart')).toBeUndefined()
    expect(exposure.aliasDiagnostics).toEqual([
      expect.objectContaining({ code: 'target-not-exposed', alias: 'smart' })
    ])
  })

  // Catches an alias tied to its target's public ID instead of its canonical ID: here both
  // gpt-4o models are prefixed, and the alias still picks the provider it names.
  test('a target whose public ID is prefixed', () => {
    const exposure = exposeWith({ main: 'codex/gpt-4o' })

    expect(exposure.models.map((model) => model.publicId)).toContain('codex/gpt-4o')
    expect(resolved(exposure, 'main')).toEqual({
      publicId: 'main',
      canonicalId: 'codex/gpt-4o',
      alias: 'main'
    })
  })

  // Catches aliases chained: a target is a canonical ID, so an alias naming another alias names
  // no model, and is reported rather than followed.
  test('an alias naming another alias is not followed', () => {
    const exposure = exposeWith({ fast: 'anthropic/claude', quick: 'fast' })

    expect(resolved(exposure, 'fast')).toMatchObject({ canonicalId: 'anthropic/claude' })
    expect(resolved(exposure, 'quick')).toBeUndefined()
    expect(exposure.aliasDiagnostics).toEqual([
      expect.objectContaining({ code: 'target-not-exposed', alias: 'quick', target: 'fast' })
    ])
  })

  // Catches a fallback chain that reaches a hidden model, that is dropped when only its first
  // target is hidden, or that is listed as a model it may not use first: the chain keeps its
  // exposed targets in order, is listed as the first of them, and reports the hidden one (#67).
  test('a fallback chain keeps its exposed targets, in order', () => {
    const exposure = exposeWith(
      {
        chain: {
          targets: ['openai/gpt-4o', 'anthropic/claude', 'codex/gpt-4o'],
          fallbackOn: ['rate_limit']
        }
      },
      { modelExposureMode: 'custom', customModels: ['anthropic/claude', 'codex/gpt-4o'] }
    )
    const chain = resolveExposedModel(exposure, 'chain')

    expect({
      listedAs: chain?.canonicalId,
      candidates: chain?.route?.candidates.map((candidate) => candidate.canonicalId),
      fallbackOn: chain?.route?.fallbackOn
    }).toEqual({
      listedAs: 'anthropic/claude',
      candidates: ['anthropic/claude', 'codex/gpt-4o'],
      fallbackOn: ['rate_limit']
    })
    expect(exposure.aliasDiagnostics).toEqual([
      expect.objectContaining({
        code: 'target-not-exposed',
        alias: 'chain',
        target: 'openai/gpt-4o'
      })
    ])
  })
})

describe('the warning about aliases named like a model', () => {
  let lines: string[] = []

  afterEach(() => {
    resetSync()
    lines = []
  })

  // Catches the warning repeating on every request (exposure is computed per request), or not
  // repeating when the set of offending aliases changes, so a new mistake went unreported.
  test('warns once per set of shadowing aliases', () => {
    // The warning is deduplicated in module state: start from a config without one.
    exposeWith({})
    configureLogging({ level: 'warning', format: 'json', write: (line) => lines.push(line) })

    exposeWith({ 'anthropic/claude': 'openai/gpt-4o' })
    exposeWith({ 'anthropic/claude': 'openai/gpt-4o' })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('"aliases":["anthropic/claude"]')

    exposeWith({ 'anthropic/claude': 'openai/gpt-4o', 'claude': 'openai/gpt-4o' })
    expect(lines).toHaveLength(2)
    exposeWith({})
    exposeWith({ 'anthropic/claude': 'openai/gpt-4o' })
    expect(lines).toHaveLength(3)
  })
})
