/**
 * Which failures move a request along its candidates (#67, #227): between two logins of the same
 * model, the classes `routing.logins.fallbackOn` names; between two models, the classes the
 * alias's `fallbackOn` names. A class named for models but not logins skips the rest of a model's
 * logins and moves to the next model.
 *
 * @packageDocumentation
 */

import type { FailureClass } from '@proxy/config/schema'
import type { ExposedModel } from '@proxy/openai/model-exposure'

/** The classes that move a request on: between models (an alias's), and between logins. */
export interface RouteHops {
  /** The alias's `fallbackOn`; empty for a request that names a model. */
  readonly fallbackOn: ReadonlySet<FailureClass>
  /** `routing.logins.fallbackOn`. */
  readonly loginFallbackOn: ReadonlySet<FailureClass>
}

/**
 * Says whether a failure moves the request from one candidate to another.
 *
 * @param hops - the classes named for each kind of hop
 * @param from - the candidate that failed
 * @param to - a later candidate
 * @param failure - the failure's class
 * @returns whether the request may move from `from` to `to` for it
 */
export function movesOn(
  hops: RouteHops,
  from: ExposedModel,
  to: ExposedModel,
  failure: FailureClass
): boolean {
  return from.canonicalId === to.canonicalId
    ? hops.loginFallbackOn.has(failure)
    : hops.fallbackOn.has(failure)
}

/**
 * Finds the candidate a failure moves the request to.
 *
 * @param candidates - the route's candidates, in order
 * @param position - the failed candidate's index
 * @param hops - the classes named for each kind of hop
 * @param failure - the failure's class, or `undefined` for one that never moves on
 * @returns the index of the next candidate to try, or `undefined` to answer with the failure
 */
export function nextFor(
  candidates: readonly ExposedModel[],
  position: number,
  hops: RouteHops,
  failure: FailureClass | undefined
): number | undefined {
  const failed = candidates[position]
  if (failed === undefined || failure === undefined) return undefined
  for (let next = position + 1; next < candidates.length; next += 1) {
    const candidate = candidates[next]
    if (candidate !== undefined && movesOn(hops, failed, candidate, failure)) return next
  }
  return undefined
}
