/**
 * Model families (#231): which models belong to a family such as `anthropic/claude-opus`, and
 * which of them is the newest.
 *
 * @remarks
 * pi's catalogue has no release date (#176), so "newest" is the version in the model ID, read by
 * one rule per provider. A family is a provider and a tier keyword the rule knows; the operator
 * can't write a pattern. Every caller goes through {@link scanFamily}, so moving to release dates
 * once pi carries them changes no config.
 *
 * - **Anthropic** (`claude-{tier}-{major}[-{minor}]`): `claude-opus-5-5` is 5.5, `claude-opus-5` is
 *   5. A dated snapshot (`claude-opus-4-5-20251101`) is a member, which a pin may name, but is
 *   never the newest: the undated ID is the one that moves.
 * - **OpenAI Codex** (`gpt-{version}-{tier}`): `gpt-6.1-sol` is 6.1 in the `sol` family.
 *
 * A member the rule can't read a version from (`claude-opus-next`) is never picked, and is
 * reported. Pure and pi-free: model exposure, which the pi extension loads, uses it (#165).
 *
 * @packageDocumentation
 */

/** A family's members and how to read a member's version. */
interface FamilyRule {
  /** The tier keywords this provider's families are named by. */
  readonly tiers: readonly string[]
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
}

/** `claude-{tier}-{major}[-{minor}][-{YYYYMMDD}]`, after the tier is removed. */
const ANTHROPIC_VERSION = /^-(?<major>\d+)(?:-(?<minor>\d{1,2}))?(?<date>-\d{8})?$/u
/** `gpt-{version}-`, before the tier is removed: a dotted version. */
const CODEX_VERSION = /^gpt-(?<version>\d+(?:\.\d+)*)-$/u

/** One rule per provider: the providers whose families an alias can follow. */
const FAMILY_RULES: Readonly<Record<string, FamilyRule>> = {
  'anthropic': {
    tiers: ['claude-opus', 'claude-sonnet', 'claude-haiku', 'claude-fable'],
    member: (id, tier) => id.startsWith(`${tier}-`),
    version: (id, tier) => {
      const groups = ANTHROPIC_VERSION.exec(id.slice(tier.length))?.groups
      if (groups?.['major'] === undefined) return undefined
      if (groups['date'] !== undefined) return 'snapshot'
      return [Number(groups['major']), Number(groups['minor'] ?? 0)]
    }
  },
  'openai-codex': {
    tiers: ['sol', 'luna', 'terra', 'astra'],
    member: (id, tier) => id.startsWith('gpt-') && id.endsWith(`-${tier}`),
    version: (id, tier) => {
      const version = CODEX_VERSION.exec(id.slice(0, -tier.length))?.groups?.['version']
      return version?.split('.').map(Number)
    }
  }
}

/** Every family an alias can follow, as `provider/tier`. */
export const KNOWN_FAMILIES: readonly string[] = Object.entries(FAMILY_RULES).flatMap(
  ([provider, rule]) => rule.tiers.map((tier) => `${provider}/${tier}`)
)

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
  const slash = family.indexOf('/')
  const provider = family.slice(0, slash)
  const tier = family.slice(slash + 1)
  const rule = slash > 0 ? FAMILY_RULES[provider] : undefined
  if (rule === undefined || !rule.tiers.includes(tier)) return undefined
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
