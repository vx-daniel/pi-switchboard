/**
 * Model families (#231): which models belong to a family such as `anthropic/claude-opus`, which of
 * them is the newest, and which families the catalogue has.
 *
 * @remarks
 * pi's catalogue has no release date (#176), so "newest" is the version in the model ID, read by
 * one rule per provider. A family is a provider and a tier the rule reads from the IDs, so a new
 * tier in pi's catalogue is a family with no change here; the operator can't write a pattern.
 * Every caller goes through {@link scanFamily}, so moving to release dates once pi carries them
 * changes no config.
 *
 * - **Anthropic** (`claude-{tier}-{major}[-{minor}]`): `claude-opus-5-5` is 5.5 in the
 *   `claude-opus` family, `claude-opus-5` is 5. A dated snapshot (`claude-opus-4-5-20251101`) is a
 *   member, which a pin may name, but is never the newest: the undated ID is the one that moves.
 * - **OpenAI Codex** (`gpt-{version}-{tier}`): `gpt-6.1-sol` is 6.1 in the `sol` family.
 *
 * A member the rule can't read a version from (`claude-opus-next`) is never picked, and is
 * reported. Each family has a built-in alias that follows its newest model, `opus-latest` or
 * `sol-latest` ({@link latestAliasName}). Pure and pi-free: model exposure, which the pi extension
 * loads, uses it (#165).
 *
 * @packageDocumentation
 */

/** A provider's families: how its IDs name a tier, and how to read a member's version. */
interface FamilyRule {
  /**
   * Reads the family a model ID names, from its shape.
   *
   * @param id - the model ID, without the provider
   * @returns the tier, or `undefined` for an ID of no family
   */
  tierOf(id: string): string | undefined
  /**
   * Says whether a tier is written the way this provider's tiers are.
   *
   * @param tier - the tier, as an alias's `family` names it
   * @returns whether it can be one of this provider's families
   */
  isTier(tier: string): boolean
  /**
   * Says whether a model ID belongs to a tier, whether or not its version can be read.
   *
   * @param id - the model ID, without the provider
   * @param tier - the tier keyword
   * @returns whether it is a member
   */
  member(id: string, tier: string): boolean
  /**
   * Reads a member's version.
   *
   * @param id - the member's model ID
   * @param tier - the tier keyword
   * @returns the version's numbers, `'snapshot'` for a dated snapshot, or `undefined` when the
   *   rule can't read it
   */
  version(id: string, tier: string): readonly number[] | 'snapshot' | undefined
  /**
   * Names the family's built-in alias.
   *
   * @param tier - the tier keyword
   * @returns the alias: `opus-latest` for `claude-opus`
   */
  latestAlias(tier: string): string
}

/** `claude-{tier}-{major}[-{minor}][-{YYYYMMDD}]`, after the tier is removed. */
const ANTHROPIC_VERSION = /^-(?<major>\d+)(?:-(?<minor>\d{1,2}))?(?<date>-\d{8})?$/u
/** An Anthropic tier: `claude-` and a word. */
const ANTHROPIC_TIER = /^claude-[a-z]+$/u
/** The tier of an Anthropic ID with a version: `claude-opus` in `claude-opus-5-5`. */
const ANTHROPIC_TIER_OF = /^(?<tier>claude-[a-z]+)-\d/u
/** `gpt-{version}-`, before the tier is removed: a dotted version. */
const CODEX_VERSION = /^gpt-(?<version>\d+(?:\.\d+)*)-$/u
/** A Codex tier: words joined by hyphens, `sol` or `codex-mini`. */
const CODEX_TIER = /^[a-z]+(?:-[a-z]+)*$/u
/** The tier of a Codex ID with a version: `sol` in `gpt-6.1-sol`. */
const CODEX_TIER_OF = /^gpt-\d+(?:\.\d+)*-(?<tier>[a-z]+(?:-[a-z]+)*)$/u
/** What a built-in alias adds to its family's name. */
const LATEST_SUFFIX = '-latest'

/** One rule per provider: the providers whose families an alias can follow. */
const FAMILY_RULES: Readonly<Record<string, FamilyRule>> = {
  'anthropic': {
    tierOf: (id) => ANTHROPIC_TIER_OF.exec(id)?.groups?.['tier'],
    isTier: (tier) => ANTHROPIC_TIER.test(tier),
    member: (id, tier) => id.startsWith(`${tier}-`),
    version: (id, tier) => {
      const groups = ANTHROPIC_VERSION.exec(id.slice(tier.length))?.groups
      if (groups?.['major'] === undefined) return undefined
      if (groups['date'] !== undefined) return 'snapshot'
      return [Number(groups['major']), Number(groups['minor'] ?? 0)]
    },
    latestAlias: (tier) => `${tier.slice('claude-'.length)}${LATEST_SUFFIX}`
  },
  'openai-codex': {
    tierOf: (id) => CODEX_TIER_OF.exec(id)?.groups?.['tier'],
    isTier: (tier) => CODEX_TIER.test(tier),
    // One part between `gpt-` and the tier: `gpt-5.1-codex-mini` is in `codex-mini`, not `mini`.
    member: (id, tier) => {
      if (!id.startsWith('gpt-') || !id.endsWith(`-${tier}`)) return false
      const middle = id.slice('gpt-'.length, -(tier.length + 1))
      return middle.length > 0 && !middle.includes('-')
    },
    version: (id, tier) => {
      const version = CODEX_VERSION.exec(id.slice(0, -tier.length))?.groups?.['version']
      return version?.split('.').map(Number)
    },
    latestAlias: (tier) => `${tier}${LATEST_SUFFIX}`
  }
}

/**
 * Splits a family into its provider's rule and its tier.
 *
 * @param family - the family, `provider/tier`
 * @returns the provider, its rule and the tier, or `undefined` for a family no rule knows
 */
function familyRule(
  family: string
): { readonly provider: string; readonly rule: FamilyRule; readonly tier: string } | undefined {
  const slash = family.indexOf('/')
  const provider = family.slice(0, slash)
  const tier = family.slice(slash + 1)
  const rule = slash > 0 ? FAMILY_RULES[provider] : undefined
  if (rule === undefined || !rule.isTier(tier)) return undefined
  return { provider, rule, tier }
}

/**
 * Lists the families some models belong to, read from their IDs.
 *
 * @param canonicalIds - the models' canonical IDs (`provider/model-id`)
 * @returns each family once, as `provider/tier`, sorted
 */
export function familiesIn(canonicalIds: Iterable<string>): readonly string[] {
  const families = new Set<string>()
  for (const canonicalId of canonicalIds) {
    const slash = canonicalId.indexOf('/')
    const provider = canonicalId.slice(0, slash)
    const tier =
      slash > 0 ? FAMILY_RULES[provider]?.tierOf(canonicalId.slice(slash + 1)) : undefined
    if (tier !== undefined) families.add(`${provider}/${tier}`)
  }
  return [...families].toSorted()
}

/**
 * Names a family's built-in alias.
 *
 * @param family - the family, `provider/tier`
 * @returns `opus-latest` for `anthropic/claude-opus`, `sol-latest` for `openai-codex/sol`, or
 *   `undefined` for a family no rule knows
 */
export function latestAliasName(family: string): string | undefined {
  const known = familyRule(family)
  return known?.rule.latestAlias(known.tier)
}

/** One member of a family whose version the rule reads. */
export interface FamilyMember {
  readonly canonicalId: string
  readonly version: readonly number[]
}

/** A family's members among some models. */
export interface FamilyScan {
  /** The members with a version, newest first; dated snapshots left out. */
  readonly members: readonly FamilyMember[]
  /** Every member, snapshots and unreadable IDs included: what a pin may name. */
  readonly all: readonly string[]
  /** Members whose version the rule can't read: never picked. */
  readonly unparsed: readonly string[]
}

/**
 * Compares two versions number by number, a missing number counting as 0.
 *
 * @param left - one version
 * @param right - the other
 * @returns negative when `left` is older, positive when newer, 0 when equal
 */
export function compareVersions(left: readonly number[], right: readonly number[]): number {
  for (let position = 0; position < Math.max(left.length, right.length); position += 1) {
    const difference = (left[position] ?? 0) - (right[position] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/**
 * Finds a family's members among some models.
 *
 * @param family - the family, `provider/tier`
 * @param canonicalIds - the models' canonical IDs (`provider/model-id`)
 * @returns the members, newest first, or `undefined` for a family no rule knows
 */
export function scanFamily(family: string, canonicalIds: Iterable<string>): FamilyScan | undefined {
  const known = familyRule(family)
  if (known === undefined) return undefined
  const { provider, rule, tier } = known
  const members: FamilyMember[] = []
  const all: string[] = []
  const unparsed: string[] = []
  for (const canonicalId of canonicalIds) {
    if (!canonicalId.startsWith(`${provider}/`)) continue
    const id = canonicalId.slice(provider.length + 1)
    if (!rule.member(id, tier)) continue
    all.push(canonicalId)
    const version = rule.version(id, tier)
    if (version === undefined) unparsed.push(canonicalId)
    else if (version !== 'snapshot') members.push({ canonicalId, version })
  }
  members.sort((left, right) => compareVersions(right.version, left.version))
  return { members, all, unparsed }
}
