import { compareVersions, KNOWN_FAMILIES, scanFamily } from '@proxy/openai/model-families'
import { describe, expect, test } from 'vite-plus/test'

/** pi-ai 1.3.0's Anthropic catalogue, as canonical IDs. */
const ANTHROPIC = [
  'claude-fable-5',
  'claude-fable-5-1',
  'claude-haiku-4-5',
  'claude-haiku-4-5-20251001',
  'claude-haiku-5-5',
  'claude-opus-4-5',
  'claude-opus-4-5-20251101',
  'claude-opus-4-6',
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-opus-5',
  'claude-opus-5-5',
  'claude-sonnet-4-5',
  'claude-sonnet-4-5-20250929',
  'claude-sonnet-4-6',
  'claude-sonnet-5',
  'claude-sonnet-5-5'
].map((modelId) => `anthropic/${modelId}`)

/** pi-ai 1.3.0's OpenAI Codex catalogue, as canonical IDs. */
const CODEX = [
  'gpt-5.3-codex-spark',
  'gpt-5.5',
  'gpt-5.6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-6-astra',
  'gpt-6-luna',
  'gpt-6-sol',
  'gpt-6.1-sol'
].map((modelId) => `openai-codex/${modelId}`)

describe('model families', () => {
  // Catches a newest picked by string order (`claude-opus-4-8` after `claude-opus-5`), a dated
  // snapshot picked over its undated ID, or another tier counted in the family.
  test("Anthropic's Opus family, newest first, without the dated snapshot", () => {
    const scan = scanFamily('anthropic/claude-opus', ANTHROPIC)

    expect(scan?.members.map((member) => member.canonicalId)).toEqual([
      'anthropic/claude-opus-5-5',
      'anthropic/claude-opus-5',
      'anthropic/claude-opus-4-8',
      'anthropic/claude-opus-4-7',
      'anthropic/claude-opus-4-6',
      'anthropic/claude-opus-4-5'
    ])
    // A pin may still name the snapshot: it is in the family.
    expect(scan?.all).toContain('anthropic/claude-opus-4-5-20251101')
    expect(scan?.unparsed).toEqual([])
  })

  // Catches a dotted version compared as text (`6.1` before `6`), or a tier matched inside
  // another model's ID (`gpt-5.3-codex-spark`, `gpt-5.5`).
  test("Codex's sol family, by its dotted version", () => {
    const scan = scanFamily('openai-codex/sol', CODEX)

    expect(scan?.members.map((member) => member.canonicalId)).toEqual([
      'openai-codex/gpt-6.1-sol',
      'openai-codex/gpt-6-sol',
      'openai-codex/gpt-5.6-sol'
    ])
  })

  // Catches an ID the rule can't read being guessed at: it is in the family, never a member with a
  // version, and reported.
  test('a member whose version the rule cannot read is reported, never ranked', () => {
    const scan = scanFamily('anthropic/claude-opus', [
      'anthropic/claude-opus-next',
      'anthropic/claude-opus-5'
    ])

    expect(scan?.members.map((member) => member.canonicalId)).toEqual(['anthropic/claude-opus-5'])
    expect(scan?.unparsed).toEqual(['anthropic/claude-opus-next'])
  })

  // Catches a family taken from another provider's models (Copilot also serves Claude), or a
  // family no rule knows resolved by guessing.
  test('a family is its own provider, and an unknown one is refused', () => {
    expect(
      scanFamily('anthropic/claude-opus', ['github-copilot/claude-opus-5-5'])?.members
    ).toEqual([])
    expect(scanFamily('anthropic/claude-opus-5', ANTHROPIC)).toBeUndefined()
    expect(scanFamily('openai/gpt', CODEX)).toBeUndefined()
    expect(scanFamily('claude-opus', ANTHROPIC)).toBeUndefined()
    expect(KNOWN_FAMILIES).toContain('anthropic/claude-sonnet')
    expect(KNOWN_FAMILIES).toContain('openai-codex/luna')
  })

  // Catches a missing number not counting as 0, which would put `5` above `5.0.1` or call them
  // equal to `5.5`.
  test('versions compare number by number', () => {
    expect(compareVersions([5], [5, 0])).toBe(0)
    expect(compareVersions([5], [5, 5])).toBeLessThan(0)
    expect(compareVersions([6, 1], [6])).toBeGreaterThan(0)
    expect(compareVersions([4, 8], [5])).toBeLessThan(0)
    expect(compareVersions([6, 1], [6, 1, 0])).toBe(0)
  })

  // Catches a version cut at two numbers: `gpt-6.1.2-sol` would tie `gpt-6.1-sol`.
  test('a version with more than two numbers ranks by all of them', () => {
    const scan = scanFamily('openai-codex/sol', [
      'openai-codex/gpt-6.1-sol',
      'openai-codex/gpt-6.1.2-sol',
      'openai-codex/gpt-6.10-sol'
    ])

    expect(scan?.members.map((member) => member.canonicalId)).toEqual([
      'openai-codex/gpt-6.10-sol',
      'openai-codex/gpt-6.1.2-sol',
      'openai-codex/gpt-6.1-sol'
    ])
  })
})
