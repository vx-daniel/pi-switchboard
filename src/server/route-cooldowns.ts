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
import type { ExposedModel } from '@proxy/openai/model-exposure'
import { activeCooldown, type Cooldown, startCooldown } from '@proxy/pi/cooldowns'
import { type FailedResponse, resetAfterMs } from '@proxy/pi/reset-time'

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
