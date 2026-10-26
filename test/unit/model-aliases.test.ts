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

/**
 * Computes the exposure of a catalogue with these aliases, every model exposed.
 *
 * @param available - the models pi has a login for
 * @param aliases - the aliases
 * @param customModels - when given, exposes only these canonical IDs ("custom" mode)
 * @returns the exposure; the test fails when the config is invalid
 */
function exposeCatalogue(
  available: readonly Model<Api>[],
  aliases: Record<string, AliasTarget>,
  customModels?: readonly string[]
): ModelExposureResult {
  const outcome = computeModelExposure(
    available,
    {
      publicModelIdMode: 'collision-prefixed',
      modelExposureMode: customModels === undefined ? 'scoped' : 'custom',
      enabledModels: undefined,
      customModels: customModels ?? [],
      providerPrefixes: {},
      aliases
    },
    getSupportedThinkingLevels
  )
  if (!outcome.ok) throw new Error(outcome.message)
  return outcome
}

/** Opus as pi lists it, plus Copilot's Opus, which is another provider's. */
const OPUS = [
  makeModel('anthropic', 'claude-opus-4-8'),
  makeModel('anthropic', 'claude-opus-5'),
  makeModel('github-copilot', 'claude-opus-6')
]
/** A newer Opus, as a catalogue update or a login adds it. */
const NEWER_OPUS = makeModel('anthropic', 'claude-opus-5-5')

describe('family aliases follow the newest exposed model (#231)', () => {
  let lines: string[] = []

  afterEach(() => {
    resetSync()
    lines = []
  })

  // Catches a family alias fixed at its first resolution (a catalogue change or a login would need
  // a restart), a move that goes unlogged, or one logged on every computation.
  test('moves when a newer model appears or goes, warning once per move', () => {
    const alias = { 'opus-moves': { family: 'anthropic/claude-opus' } }
    configureLogging({ level: 'warning', format: 'json', write: (line) => lines.push(line) })

    const before = exposeCatalogue(OPUS, alias)
    const added = exposeCatalogue([...OPUS, NEWER_OPUS], alias)
    exposeCatalogue([...OPUS, NEWER_OPUS], alias)
    const removed = exposeCatalogue(OPUS, alias)

    expect(resolved(before, 'opus-moves')?.['canonicalId']).toBe('anthropic/claude-opus-5')
    expect(resolved(added, 'opus-moves')?.['canonicalId']).toBe('anthropic/claude-opus-5-5')
    expect(resolved(removed, 'opus-moves')?.['canonicalId']).toBe('anthropic/claude-opus-5')
    // The built-in opus-latest follows the same family and moves too; this test's alias is its own.
    const moves = lines.filter(
      (line) => line.includes('now follows') && line.includes('opus-moves')
    )
    expect(moves).toHaveLength(2)
    expect(moves[0]).toContain('"model":"anthropic/claude-opus-5-5"')
    expect(moves[0]).toContain('"previousModel":"anthropic/claude-opus-5"')
  })

  // Catches the baseline lost while the family has nothing exposed: the next model served must be
  // compared with the last one clients were billed on, and the same model coming back is no move.
  test('a move across a gap with nothing exposed is logged against the last model served', () => {
    const alias = { 'opus-gap': { family: 'anthropic/claude-opus' } }
    const sonnetOnly = [makeModel('anthropic', 'claude-sonnet-5')]
    configureLogging({ level: 'warning', format: 'json', write: (line) => lines.push(line) })

    exposeCatalogue(OPUS, alias)
    exposeCatalogue(sonnetOnly, alias)
    exposeCatalogue(OPUS, alias)
    expect(lines.filter((line) => line.includes('now follows'))).toEqual([])

    exposeCatalogue(sonnetOnly, alias)
    exposeCatalogue([...OPUS, NEWER_OPUS], alias)
    const moves = lines.filter((line) => line.includes('now follows') && line.includes('opus-gap'))
    expect(moves).toHaveLength(1)
    expect(moves[0]).toContain('"previousModel":"anthropic/claude-opus-5"')
  })

  // Catches a hidden model reached through the family (principle IV), or the hiding going unseen.
  test('a hidden newer model is honoured and noted', () => {
    const exposure = exposeCatalogue(
      [...OPUS, NEWER_OPUS],
      { 'opus-hidden': { family: 'anthropic/claude-opus' } },
      ['anthropic/claude-opus-4-8', 'anthropic/claude-opus-5']
    )

    expect(resolved(exposure, 'opus-hidden')?.['canonicalId']).toBe('anthropic/claude-opus-5')
    expect(exposure.familyResolutions.filter(({ alias }) => alias === 'opus-hidden')).toEqual([
      {
        alias: 'opus-hidden',
        position: 0,
        family: 'anthropic/claude-opus',
        pin: null,
        resolved: 'anthropic/claude-opus-5',
        newest: 'anthropic/claude-opus-5',
        newerHidden: 'anthropic/claude-opus-5-5'
      }
    ])
  })

  // Catches a pin that moves with the family, or a hidden pin quietly replaced by the newest: the
  // operator pinned for a reason.
  test('a pin holds, and a hidden pin is not exposed rather than replaced', () => {
    const pinned = {
      'opus-pinned': { family: 'anthropic/claude-opus', pin: 'anthropic/claude-opus-4-8' }
    }

    const held = exposeCatalogue([...OPUS, NEWER_OPUS], pinned)
    const hidden = exposeCatalogue([...OPUS, NEWER_OPUS], pinned, ['anthropic/claude-opus-5-5'])

    expect(resolved(held, 'opus-pinned')?.['canonicalId']).toBe('anthropic/claude-opus-4-8')
    expect(resolved(hidden, 'opus-pinned')).toBeUndefined()
    expect(hidden.aliasDiagnostics).toEqual([
      expect.objectContaining({ code: 'target-not-exposed', target: 'anthropic/claude-opus-4-8' })
    ])
  })

  // Catches a family no rule knows resolved by guessing, or a pin outside its family accepted.
  test('an unknown family and a pin outside the family are configuration errors', () => {
    const exposure = exposeCatalogue(OPUS, {
      'gpt-latest': { family: 'openai/gpt' },
      'opus-odd': { family: 'anthropic/claude-opus', pin: 'github-copilot/claude-opus-6' }
    })

    // Only the built-in opus-latest: neither configured alias is exposed.
    expect(exposure.aliases.map(({ alias }) => alias)).toEqual(['opus-latest'])
    expect(exposure.aliasDiagnostics.map(({ code, target }) => ({ code, target }))).toEqual([
      { code: 'family-unknown', target: 'openai/gpt' },
      { code: 'pin-outside-family', target: 'github-copilot/claude-opus-6' }
    ])
  })

  // Catches a family target in a chain resolved once for the whole chain, or the chain dropped
  // when its family has nothing exposed.
  test('a family can be one target of a chain', () => {
    const exposure = exposeCatalogue(OPUS, {
      'opus-chain': {
        targets: [{ family: 'anthropic/claude-sonnet' }, { family: 'anthropic/claude-opus' }],
        fallbackOn: ['rate_limit']
      }
    })

    expect(
      exposure.byAlias.get('opus-chain')?.route?.candidates.map(({ canonicalId }) => canonicalId)
    ).toEqual(['anthropic/claude-opus-5'])
    expect(exposure.aliasDiagnostics).toEqual([
      expect.objectContaining({ code: 'target-not-exposed', target: 'anthropic/claude-sonnet' })
    ])
  })
})

describe('the built-in -latest aliases (#231)', () => {
  // Catches a built-in alias that needs config, one per family missing, or one for a family with
  // no exposed model (Codex without a login).
  test('one for each family with an exposed model, after the configured aliases', () => {
    const exposure = exposeCatalogue(
      [...OPUS, makeModel('anthropic', 'claude-sonnet-5'), makeModel('openai-codex', 'gpt-6-sol')],
      { opus: 'anthropic/claude-opus-5' },
      ['anthropic/claude-opus-4-8', 'anthropic/claude-opus-5', 'anthropic/claude-sonnet-5']
    )

    expect(exposure.aliases.map(({ alias, canonicalId }) => [alias, canonicalId])).toEqual([
      ['opus', 'anthropic/claude-opus-5'],
      ['opus-latest', 'anthropic/claude-opus-5'],
      ['sonnet-latest', 'anthropic/claude-sonnet-5']
    ])
    expect(exposure.latestAliases).toEqual({
      'opus-latest': { family: 'anthropic/claude-opus' },
      'sonnet-latest': { family: 'anthropic/claude-sonnet' }
    })
    expect(exposure.aliasDiagnostics).toEqual([])
  })

  // Catches a built-in alias listed twice or overriding the operator's own alias of its name, or
  // taking a name an exposed model has.
  test('gives way to a configured alias of its name, and to a model named like it', () => {
    const configured = exposeCatalogue(OPUS, { 'opus-latest': 'anthropic/claude-opus-4-8' })
    const named = exposeCatalogue([...OPUS, makeModel('custom', 'opus-latest')], {}, [
      'anthropic/claude-opus-5',
      'custom/opus-latest'
    ])

    expect(configured.aliases.map(({ alias, canonicalId }) => [alias, canonicalId])).toEqual([
      ['opus-latest', 'anthropic/claude-opus-4-8']
    ])
    expect(configured.latestAliases).toEqual({})
    expect(named.byPublicId.get('opus-latest')?.canonicalId).toBe('custom/opus-latest')
    expect(named.latestAliases).toEqual({})
    expect(named.aliasDiagnostics).toEqual([])
  })

  // Catches a built-in alias for a family it could never serve: only a dated snapshot or an ID
  // without a readable version exposed would list it and report it as not exposed.
  test('none for a family whose only exposed members are snapshots or unreadable IDs', () => {
    const exposure = exposeCatalogue(
      [
        makeModel('anthropic', 'claude-haiku-4-5-20251001'),
        makeModel('anthropic', 'claude-opus-next')
      ],
      {}
    )

    expect(exposure.latestAliases).toEqual({})
    expect(exposure.aliases).toEqual([])
    expect(exposure.aliasDiagnostics).toEqual([])
  })

  // Catches two families that name the same alias both listed, or the one listed chosen anew on
  // each computation (clients would be billed on a coin toss).
  test('two families naming one alias: the first in family order keeps it', () => {
    const exposure = exposeCatalogue(
      [makeModel('openai-codex', 'gpt-6-opus'), makeModel('anthropic', 'claude-opus-5')],
      {}
    )

    expect(exposure.latestAliases).toEqual({ 'opus-latest': { family: 'anthropic/claude-opus' } })
    expect(exposure.aliases.map(({ alias, canonicalId }) => [alias, canonicalId])).toEqual([
      ['opus-latest', 'anthropic/claude-opus-5']
    ])
  })
})
