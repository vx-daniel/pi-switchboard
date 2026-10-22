/**
 * How an alias's fallback chain uses cooldowns (#68): which candidates it skips, and how a failure
 * starts one. The cooldown state itself is `src/pi/cooldowns.ts`.
 *
 * @remarks
 * - **Skipped only where the alias names the class.** A candidate cooling down after a 429 is
 *   skipped only by a chain whose `fallbackOn` names `rate_limit`, and after a 503 only by one that
 *   names `unavailable` (principle VI). A request that names a model, or a chain that names neither,
 *   calls it as before #68.
 * - **Never skip them all.** When every remaining candidate is cooling down, the one whose cooldown
 *   ends first is tried, so the request still makes one real call.
 * - **Every failure is recorded.** A 429 or 503 from any request starts a cooldown, so the operator
 *   and clients see it even before a chain uses it.
 *
 * @packageDocumentation
 */

import type { FailureClass } from '@proxy/config/schema'
import { proxyLogger } from '@proxy/logging'
import type { ExposedModel } from '@proxy/openai/model-exposure'
import type { Attempt } from '@proxy/openai/responses'
import { activeCooldown, type Cooldown, startCooldown } from '@proxy/pi/cooldowns'
import { type FailedResponse, resetAfterMs } from '@proxy/pi/reset-time'

/** Logger for routing decisions, as for the chat route's other skips. */
const chatLogger = proxyLogger('server', 'chat')

/**
 * The cooldown a chain skips a candidate for: an active one whose class the alias names.
 *
 * @param candidate - the candidate
 * @param fallbackOn - the classes the alias names
 * @param now - the current time
 * @returns the cooldown, or `undefined` when the chain would call it
 */
function skippableCooldown(
  candidate: ExposedModel | undefined,
  fallbackOn: ReadonlySet<FailureClass>,
  now: number
): Cooldown | undefined {
  if (candidate === undefined) return undefined
  const cooldown = activeCooldown(candidate, now)
  return cooldown !== undefined && fallbackOn.has(cooldown.reason) ? cooldown : undefined
}

/**
 * Checks whether the chain would skip a candidate for its cooldown, so another check (the quota
 * reserve, #69) does not count it as an alternative.
 *
 * @param candidate - the candidate
 * @param fallbackOn - the classes the alias names
 * @param now - the current time
 * @returns whether it is cooling down for a class the alias names
 */
export function coolingForChain(
  candidate: ExposedModel,
  fallbackOn: ReadonlySet<FailureClass>,
  now: number
): boolean {
  return skippableCooldown(candidate, fallbackOn, now) !== undefined
}

/**
 * Decides whether the chain skips the candidate at `position` because it is cooling down.
 *
 * @param candidates - the chain's candidates, in order
 * @param position - the candidate's position
 * @param fallbackOn - the classes the alias names
 * @param now - the current time; `Date.now()` by default
 * @returns the cooldown it is skipped for, or `undefined` to call it
 */
export function cooldownSkip(
  candidates: readonly ExposedModel[],
  position: number,
  fallbackOn: ReadonlySet<FailureClass>,
  now: number = Date.now()
): Cooldown | undefined {
  const own = skippableCooldown(candidates[position], fallbackOn, now)
  if (own === undefined) return undefined
  const remaining = candidates.slice(position + 1)
  if (remaining.some((later) => skippableCooldown(later, fallbackOn, now) === undefined)) return own
  // Every remaining candidate is cooling down: call the one whose cooldown ends first.
  const endsFirst = remaining.every(
    (later) => (skippableCooldown(later, fallbackOn, now)?.until ?? Infinity) >= own.until
  )
  return endsFirst ? undefined : own
}

/**
 * Skips a candidate while it cools down (#68), when the chain names its class: logs the skip and
 * lists it in `attempts`.
 *
 * @param chain - the candidates, the classes the alias names, and the alias
 * @param chain.candidates - the chain's candidates
 * @param chain.fallbackOn - the failure classes the alias names
 * @param chain.alias - the alias whose chain it is
 * @param position - the candidate's index in `chain.candidates`
 * @param attempts - the attempts so far; a skip is added to them
 * @returns whether the candidate is skipped
 */
export function skipCooling(
  chain: {
    readonly candidates: readonly ExposedModel[]
    readonly fallbackOn: ReadonlySet<FailureClass>
    readonly alias: string | undefined
  },
  position: number,
  attempts: Attempt[]
): boolean {
  const cooldown = cooldownSkip(chain.candidates, position, chain.fallbackOn)
  const candidate = chain.candidates[position]
  if (cooldown === undefined || candidate === undefined) return false
  chatLogger.info('Alias {alias}: skipping {model}, cooling down after {reason} until {until}', {
    alias: chain.alias,
    model: candidate.canonicalId,
    reason: cooldown.reason,
    until: new Date(cooldown.until).toISOString(),
    scope: cooldown.scope
  })
  attempts.push({ model: candidate.canonicalId, reason: cooldown.reason, skipped: true })
  return true
}

/**
 * Starts the cooldown a failed attempt calls for: after a 429 its provider's, after a 503 or 529
 * its own, for as long as the failed response says (`src/pi/reset-time.ts`).
 *
 * @param candidate - the model that failed
 * @param failure - the failure's class
 * @param captured - the failed response, when the capturing `fetch` kept it
 */
export function recordCooldown(
  candidate: ExposedModel,
  failure: FailureClass | undefined,
  captured: FailedResponse | undefined
): void {
  if (failure !== 'rate_limit' && failure !== 'unavailable') return
  startCooldown(candidate, failure, captured === undefined ? undefined : resetAfterMs(captured))
}
