/**
 * The model-exposure engine (`src/openai/model-exposure.ts`).
 *
 * Tests cover:
 * - Exposure filtering: all, scoped, custom
 * - Public ID generation: collision-prefixed, universal, always-prefixed
 * - Provider conflict groups (connected components)
 * - Prefix uniqueness validation
 * - Universal mode collision detection
 * - Resolution: public ID, canonical fallback, hidden model rejection
 */

import { type Api, getSupportedThinkingLevels, type Model } from '@earendil-works/pi-ai'
import type { ModelExposureConfig } from '@proxy/openai/model-exposure'
import { computeModelExposure, resolveExposedModel } from '@proxy/openai/model-exposure'
import { describe, expect, test } from 'vite-plus/test'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Builds a text-only, zero-cost model on the `openai-completions` API.
 *
 * @param provider - the provider name; also forms the base URL host
 * @param id - the model ID, used as its name too
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

/**
 * Builds an exposure config: collision-prefixed IDs, scoped exposure, no patterns, no custom
 * models, no prefix overrides, then `overrides` on top.
 *
 * @param overrides - the fields that differ from that default
 * @returns the config
 */
function defaultConfig(overrides: Partial<ModelExposureConfig> = {}): ModelExposureConfig {
  return {
    publicModelIdMode: 'collision-prefixed',
    modelExposureMode: 'scoped',
    enabledModels: undefined,
    customModels: [],
    providerPrefixes: {},
    aliases: {},
    ...overrides
  }
}

/**
 * Calls {@link computeModelExposure} with the given available models.
 *
 * @param models - the available (auth-configured) models
 * @param config - the exposure config
 * @returns the exposure outcome
 */
function expose(
  models: readonly Model<Api>[],
  config: ModelExposureConfig
): ReturnType<typeof computeModelExposure> {
  return computeModelExposure(models, config, getSupportedThinkingLevels)
}

// ---------------------------------------------------------------------------
// Exposure filtering
// ---------------------------------------------------------------------------

describe('exposure filtering', () => {
  const models = [
    makeModel('openai', 'gpt-4o'),
    makeModel('openai', 'gpt-4o-mini'),
    makeModel('anthropic', 'claude-sonnet-4-20250514'),
    makeModel('google', 'gemini-2.5-pro')
  ]

  test('scoped mode with no enabledModels exposes all available models', () => {
    const result = expose(models, defaultConfig())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.models.length).toBe(4)
  })

  test('scoped mode with empty enabledModels exposes all available models', () => {
    const result = expose(models, defaultConfig({ enabledModels: [] }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.models.length).toBe(4)
  })

  test('scoped mode filters by enabledModels canonical IDs', () => {
    const result = expose(
      models,
      defaultConfig({
        enabledModels: ['openai/gpt-4o', 'google/gemini-2.5-pro']
      })
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.models.length).toBe(2)
    const ids = result.models.map((model) => model.canonicalId)
    expect(ids).toContain('openai/gpt-4o')
    expect(ids).toContain('google/gemini-2.5-pro')
  })

  test('scoped mode ignores enabledModels entries not in available set', () => {
    const result = expose(
      models,
      defaultConfig({
        enabledModels: ['openai/gpt-4o', 'fake/nonexistent']
      })
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.models.length).toBe(1)
    expect(result.models[0]?.canonicalId).toBe('openai/gpt-4o')
  })

  test('all mode exposes all available (auth-configured) models', () => {
    const result = expose(models, defaultConfig({ modelExposureMode: 'all' }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.models.length).toBe(4)
  })

  test('custom mode exposes only allowlisted canonical IDs', () => {
    const result = expose(
      models,
      defaultConfig({
        modelExposureMode: 'custom',
        customModels: ['openai/gpt-4o', 'anthropic/claude-sonnet-4-20250514']
      })
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.models.length).toBe(2)
    const ids = result.models.map((model) => model.canonicalId)
    expect(ids).toContain('openai/gpt-4o')
    expect(ids).toContain('anthropic/claude-sonnet-4-20250514')
  })

  // Catches an empty custom selection falling back to every model (#88).
  test('custom mode with empty list exposes no model', () => {
    const result = expose(models, defaultConfig({ modelExposureMode: 'custom', customModels: [] }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.models).toEqual([])
  })

  test('custom mode ignores non-existent canonical IDs', () => {
    const result = expose(
      models,
      defaultConfig({
        modelExposureMode: 'custom',
        customModels: ['openai/gpt-4o', 'fake/nonexistent']
      })
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.models.length).toBe(1)
  })

  test('empty available models produces empty exposure', () => {
    const result = expose([], defaultConfig())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.models.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Public ID modes -- no collisions
// ---------------------------------------------------------------------------

describe('public ID modes -- no collisions', () => {
  const models = [
    makeModel('openai', 'gpt-4o'),
    makeModel('anthropic', 'claude-sonnet-4-20250514'),
    makeModel('google', 'gemini-2.5-pro')
  ]

  test('collision-prefixed uses raw IDs when no collisions', () => {
    const result = expose(models, defaultConfig())
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const publicIds = result.models.map((model) => model.publicId)
    expect(publicIds).toContain('gpt-4o')
    expect(publicIds).toContain('claude-sonnet-4-20250514')
    expect(publicIds).toContain('gemini-2.5-pro')
  })

  test('universal uses raw IDs when no collisions', () => {
    const result = expose(models, defaultConfig({ publicModelIdMode: 'universal' }))
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const publicIds = result.models.map((model) => model.publicId)
    expect(publicIds).toContain('gpt-4o')
    expect(publicIds).toContain('claude-sonnet-4-20250514')
  })

  test('always-prefixed uses provider/model-id for all', () => {
    const result = expose(models, defaultConfig({ publicModelIdMode: 'always-prefixed' }))
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const publicIds = result.models.map((model) => model.publicId)
    expect(publicIds).toContain('openai/gpt-4o')
    expect(publicIds).toContain('anthropic/claude-sonnet-4-20250514')
    expect(publicIds).toContain('google/gemini-2.5-pro')
  })
})

// ---------------------------------------------------------------------------
// Public ID modes -- with collisions
// ---------------------------------------------------------------------------

describe('public ID modes -- with collisions', () => {
  const models = [
    makeModel('openai', 'gpt-4o'),
    makeModel('openai', 'gpt-4o-mini'),
    makeModel('codex', 'gpt-4o'), // collides with openai
    makeModel('codex', 'codex-unique'),
    makeModel('anthropic', 'claude-sonnet-4-20250514'),
    makeModel('google', 'gemini-2.5-pro')
  ]

  test('collision-prefixed prefixes all models in conflict group', () => {
    const result = expose(models, defaultConfig())
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const publicIds = result.models.map((model) => model.publicId)
    // Catches a model emitted under both its prefixed and raw ID, or a conflict-group model left
    // raw. Order is part of the contract: computeModelExposure keeps the input order.
    expect(publicIds).toEqual([
      'openai/gpt-4o',
      'openai/gpt-4o-mini',
      'codex/gpt-4o',
      'codex/codex-unique',
      'claude-sonnet-4-20250514',
      'gemini-2.5-pro'
    ])
  })

  test('universal mode fails on collision', () => {
    const result = expose(models, defaultConfig({ publicModelIdMode: 'universal' }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain('gpt-4o')
    expect(result.message).toContain('openai')
    expect(result.message).toContain('codex')
  })

  test('always-prefixed works despite collisions', () => {
    const result = expose(models, defaultConfig({ publicModelIdMode: 'always-prefixed' }))
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const publicIds = result.models.map((model) => model.publicId)
    expect(publicIds).toContain('openai/gpt-4o')
    expect(publicIds).toContain('codex/gpt-4o')
  })
})

// ---------------------------------------------------------------------------
// Connected conflict groups (transitive closure)
// ---------------------------------------------------------------------------

describe('connected conflict groups', () => {
  test('transitive conflict: A-B collide, B-C collide -> all three prefixed', () => {
    const models = [
      makeModel('provA', 'shared-ab'),
      makeModel('provB', 'shared-ab'), // A-B collide
      makeModel('provB', 'shared-bc'),
      makeModel('provC', 'shared-bc'), // B-C collide
      makeModel('provC', 'unique-c'),
      makeModel('provD', 'unique-d') // no collision
    ]

    const result = expose(models, defaultConfig())
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const publicIds = result.models.map((model) => model.publicId)
    // A, B, C form one connected group -- all prefixed
    expect(publicIds).toContain('provA/shared-ab')
    expect(publicIds).toContain('provB/shared-ab')
    expect(publicIds).toContain('provB/shared-bc')
    expect(publicIds).toContain('provC/shared-bc')
    expect(publicIds).toContain('provC/unique-c')
    // D has no collisions -- raw ID
    expect(publicIds).toContain('unique-d')
  })

  // Catches a union-find regression that drops a provider when three or more share one ID,
  // fails to merge a chained group, or normalizes IDs that differ only in case.
  test('multi-way and chained conflicts join one group; case-distinct IDs never collide', () => {
    const models = [
      makeModel('provA', 'shared-abc'),
      makeModel('provB', 'shared-abc'),
      makeModel('provC', 'shared-abc'), // A-B-C collide on one ID
      makeModel('provD', 'shared-cd'),
      makeModel('provC', 'shared-cd'), // D joins through C
      makeModel('provE', 'shared-de'),
      makeModel('provD', 'shared-de'), // E joins through D
      makeModel('provF', 'Shared-ABC') // differs only by case: no collision
    ]

    const result = expose(models, defaultConfig())
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.models.map((model) => model.publicId)).toEqual([
      'provA/shared-abc',
      'provB/shared-abc',
      'provC/shared-abc',
      'provD/shared-cd',
      'provC/shared-cd',
      'provE/shared-de',
      'provD/shared-de',
      'Shared-ABC'
    ])
  })
})

// ---------------------------------------------------------------------------
// Provider prefix overrides
// ---------------------------------------------------------------------------

describe('provider prefix overrides', () => {
  const models = [
    makeModel('openai', 'gpt-4o'),
    makeModel('codex', 'gpt-4o'),
    makeModel('anthropic', 'claude-sonnet-4-20250514')
  ]

  test('collision-prefixed uses custom prefix labels', () => {
    const result = expose(
      models,
      defaultConfig({ providerPrefixes: { openai: 'oai', codex: 'cx' } })
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const publicIds = result.models.map((model) => model.publicId)
    expect(publicIds).toContain('oai/gpt-4o')
    expect(publicIds).toContain('cx/gpt-4o')
    // anthropic not in conflict group, so raw ID
    expect(publicIds).toContain('claude-sonnet-4-20250514')
  })

  test('always-prefixed uses custom prefix labels', () => {
    const result = expose(
      models,
      defaultConfig({
        publicModelIdMode: 'always-prefixed',
        providerPrefixes: { anthropic: 'claude' }
      })
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const publicIds = result.models.map((model) => model.publicId)
    expect(publicIds).toContain('openai/gpt-4o') // no override -> provider key
    expect(publicIds).toContain('claude/claude-sonnet-4-20250514') // override
  })
})

// ---------------------------------------------------------------------------
// Prefix uniqueness validation
// ---------------------------------------------------------------------------

describe('prefix uniqueness validation', () => {
  test('duplicate prefix labels fail in collision-prefixed mode', () => {
    const models = [makeModel('openai', 'gpt-4o'), makeModel('codex', 'gpt-4o')]
    const result = expose(
      models,
      defaultConfig({ providerPrefixes: { openai: 'same', codex: 'same' } })
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain('same')
    expect(result.message).toContain('Duplicate prefix label')
  })

  test('duplicate prefix labels fail in always-prefixed mode', () => {
    const models = [makeModel('openai', 'gpt-4o'), makeModel('anthropic', 'claude')]
    const result = expose(
      models,
      defaultConfig({
        publicModelIdMode: 'always-prefixed',
        providerPrefixes: { openai: 'dup', anthropic: 'dup' }
      })
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain('Duplicate prefix label')
  })

  test('no error when non-conflicting providers share prefix labels in collision-prefixed', () => {
    // If providers don't collide, they don't get prefixed, so no prefix conflict
    const models = [makeModel('openai', 'gpt-4o'), makeModel('anthropic', 'claude')]
    const result = expose(
      models,
      defaultConfig({ providerPrefixes: { openai: 'same', anthropic: 'same' } })
    )
    expect(result.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

describe('resolveExposedModel', () => {
  const models = [
    makeModel('openai', 'gpt-4o'),
    makeModel('openai', 'gpt-4o-mini'),
    makeModel('codex', 'gpt-4o'),
    makeModel('anthropic', 'claude-sonnet-4-20250514')
  ]

  test('resolves by public ID', () => {
    const result = expose(models, defaultConfig())
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // openai/codex collide -> prefixed
    const resolved = resolveExposedModel(result, 'openai/gpt-4o')
    expect(resolved).toBeDefined()
    expect(resolved?.model.provider).toBe('openai')
    expect(resolved?.model.id).toBe('gpt-4o')
  })

  test('resolves unprefixed public ID for non-conflicting provider', () => {
    const result = expose(models, defaultConfig())
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const resolved = resolveExposedModel(result, 'claude-sonnet-4-20250514')
    expect(resolved).toBeDefined()
    expect(resolved?.model.provider).toBe('anthropic')
  })

  test('resolves by canonical ID fallback for exposed models', () => {
    const result = expose(models, defaultConfig())
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const resolved = resolveExposedModel(result, 'anthropic/claude-sonnet-4-20250514')
    expect(resolved).toBeDefined()
    expect(resolved?.model.provider).toBe('anthropic')
  })

  test('hidden models are not reachable via canonical fallback', () => {
    const result = expose(
      models,
      defaultConfig({
        modelExposureMode: 'custom',
        customModels: ['openai/gpt-4o', 'openai/gpt-4o-mini']
      })
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // anthropic is hidden -- should not resolve by canonical ID
    const resolved = resolveExposedModel(result, 'anthropic/claude-sonnet-4-20250514')
    expect(resolved).toBeUndefined()
  })

  test('hidden models are not reachable via raw ID', () => {
    const result = expose(
      models,
      defaultConfig({
        modelExposureMode: 'custom',
        customModels: ['openai/gpt-4o', 'openai/gpt-4o-mini']
      })
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const resolved = resolveExposedModel(result, 'claude-sonnet-4-20250514')
    expect(resolved).toBeUndefined()
  })

  test('returns undefined for completely unknown model', () => {
    const result = expose(models, defaultConfig())
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const resolved = resolveExposedModel(result, 'nonexistent')
    expect(resolved).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Universal mode validation
// ---------------------------------------------------------------------------

describe('universal mode validation', () => {
  test('rejects duplicate raw model IDs', () => {
    const models = [makeModel('openai', 'gpt-4o'), makeModel('codex', 'gpt-4o')]
    const result = expose(models, defaultConfig({ publicModelIdMode: 'universal' }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain('Universal mode conflict')
    expect(result.message).toContain('gpt-4o')
  })

  test('succeeds when custom exposure removes collisions', () => {
    const models = [
      makeModel('openai', 'gpt-4o'),
      makeModel('codex', 'gpt-4o'),
      makeModel('anthropic', 'claude')
    ]
    const result = expose(
      models,
      defaultConfig({
        publicModelIdMode: 'universal',
        modelExposureMode: 'custom',
        customModels: ['openai/gpt-4o', 'anthropic/claude']
      })
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const publicIds = result.models.map((model) => model.publicId)
    expect(publicIds).toContain('gpt-4o')
    expect(publicIds).toContain('claude')
    expect(publicIds.length).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  test('model with nested slashes in ID (openrouter-style)', () => {
    const models = [makeModel('openrouter', 'anthropic/claude-sonnet-4-20250514')]
    const result = expose(models, defaultConfig({ publicModelIdMode: 'always-prefixed' }))
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.models[0]?.publicId).toBe('openrouter/anthropic/claude-sonnet-4-20250514')
    expect(result.models[0]?.canonicalId).toBe('openrouter/anthropic/claude-sonnet-4-20250514')
  })

  // Catches the canonical fallback skipped when a provider prefix label differs from the provider
  // name: public IDs are `oai/gpt-4o` and `cx/gpt-4o`, so `openai/gpt-4o` only resolves through
  // the fallback, and must still pick the right provider of two with the same model ID.
  test('canonical fallback works for models behind a prefix label', () => {
    const models = [makeModel('openai', 'gpt-4o'), makeModel('codex', 'gpt-4o')]
    const result = expose(
      models,
      defaultConfig({ providerPrefixes: { openai: 'oai', codex: 'cx' } })
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect({
      publicIds: result.models.map((model) => model.publicId),
      openai: resolveExposedModel(result, 'openai/gpt-4o')?.publicId,
      codex: resolveExposedModel(result, 'codex/gpt-4o')?.publicId
    }).toEqual({ publicIds: ['oai/gpt-4o', 'cx/gpt-4o'], openai: 'oai/gpt-4o', codex: 'cx/gpt-4o' })
  })

  test('single model from single provider works in all modes', () => {
    const models = [makeModel('openai', 'gpt-4o')]

    for (const mode of ['collision-prefixed', 'universal', 'always-prefixed'] as const) {
      const result = expose(models, defaultConfig({ publicModelIdMode: mode }))
      expect(result.ok).toBe(true)
      if (!result.ok) continue
      expect(result.models.length).toBe(1)
    }
  })
})
