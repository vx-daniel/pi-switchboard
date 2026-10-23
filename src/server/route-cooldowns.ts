/**
 * How a route uses cooldowns (#68): which candidates it skips, and how a failure starts one. The
 * cooldown state itself is `src/pi/cooldowns.ts`.
 *
 * @remarks
 * - **Skipped only where the route names the class.** A candidate cooling down after a 429 is
 *   skipped only when the hop past it is named for `rate_limit`, and after a 503 only when it is
 *   named for `unavailable` (principle VI): the alias's `fallbackOn` between models, and
 *   `routing.logins.fallbackOn` between a model's logins (#227). A chain that names neither calls
 *   it as before #68.
 * - **Never skip them all.** When every remaining candidate is cooling down, the one whose cooldown
 *   ends first is tried, so the request still makes one real call.
 * - **Every failure is recorded.** A 429 or 503 from any request starts a cooldown, so the operator
 *   and clients see it even before a chain uses it.
 * - **Keyed by login.** A 429 cools the login that met it (`candidate.login`), not the provider's
 *   other logins; a 503 cools the model, under every login (#227).
 *
 * @packageDocumentation
 */

import type { FailureClass } from '@proxy/config/schema'
import { proxyLogger } from '@proxy/logging'
import type { ExposedModel } from '@proxy/openai/model-exposure'
import type { Attempt } from '@proxy/openai/responses'
import {
  activeCooldown,
  type Cooldown,
  type CooldownSubject,
  startCooldown
} from '@proxy/pi/cooldowns'
import { type FailedResponse, resetAfterMs } from '@proxy/pi/reset-time'
import { movesOn, type RouteHops } from '@proxy/server/route-hops'

/** Logger for routing decisions, as for the chat route's other skips. */
const chatLogger = proxyLogger('server', 'chat')

/**
 * The cooldown subject a candidate is: its login, and the exposed model.
 *
 * @param candidate - the candidate
 * @returns the subject
 */
export function loginSubject(candidate: ExposedModel): CooldownSubject {
  return { provider: candidate.login, canonicalId: candidate.canonicalId }
}

/**
 * A later candidate's cooldown, when the hop to it from `from` is named for the cooldown's class:
 * the route would not call it either.
 *
 * @param hops - the classes named for each kind of hop
 * @param from - the candidate the route is at
 * @param to - a later candidate
 * @param now - the current time
 * @returns `to`'s cooldown, or `undefined` when the route would call it
 */
function namedCooldown(
  hops: RouteHops,
  from: ExposedModel,
  to: ExposedModel,
  now: number
): Cooldown | undefined {
  const cooldown = activeCooldown(loginSubject(to), now)
  return cooldown !== undefined && movesOn(hops, from, to, cooldown.reason) ? cooldown : undefined
}

/**
 * Checks whether the route, at `hop.from`, would skip a later candidate for its cooldown, so
 * another check (the quota reserve, #69) does not count it as an alternative.
 *
 * @param candidates - the route's candidates
 * @param hop - the candidate the route is at, and the later candidate's position
 * @param hops - the classes named for each kind of hop
 * @param now - the current time
 * @returns whether it is cooling down for a class the hop to it is named for
 */
export function coolingForChain(
  candidates: readonly ExposedModel[],
  hop: { readonly from: number; readonly to: number },
  hops: RouteHops,
  now: number
): boolean {
  const from = candidates[hop.from]
  const to = candidates[hop.to]
  return from !== undefined && to !== undefined && namedCooldown(hops, from, to, now) !== undefined
}

/**
 * Decides whether the route skips the candidate at `position` because it is cooling down: only
 * when a later candidate is reachable for the cooldown's class, and not when every reachable one
 * is cooling down too and this one's cooldown ends first.
 *
 * @param candidates - the route's candidates, in order
 * @param position - the candidate's position
 * @param hops - the classes named for each kind of hop
 * @param now - the current time; `Date.now()` by default
 * @returns the cooldown it is skipped for, or `undefined` to call it
 */
export function cooldownSkip(
  candidates: readonly ExposedModel[],
  position: number,
  hops: RouteHops,
  now: number = Date.now()
): Cooldown | undefined {
  const candidate = candidates[position]
  if (candidate === undefined) return undefined
  const own = activeCooldown(loginSubject(candidate), now)
  if (own === undefined) return undefined
  const reachable = candidates
    .slice(position + 1)
    .filter((later) => movesOn(hops, candidate, later, own.reason))
  if (reachable.length === 0) return undefined
  const cooling = reachable.map((later) => namedCooldown(hops, candidate, later, now))
  if (cooling.some((cooldown) => cooldown === undefined)) return own
  // Every reachable candidate is cooling down: call the one whose cooldown ends first.
  const endsFirst = cooling.every((cooldown) => (cooldown?.until ?? Infinity) >= own.until)
  return endsFirst ? undefined : own
}

/**
 * Skips a candidate while it cools down (#68), when a hop past it names its class: logs the skip
 * and lists it in `attempts`.
 *
 * @param route - the candidates, the classes named for each kind of hop, and the alias
 * @param route.candidates - the route's candidates
 * @param route.alias - the alias whose chain it is
 * @param position - the candidate's index in `route.candidates`
 * @param attempts - the attempts so far; a skip is added to them
 * @returns whether the candidate is skipped
 */
export function skipCooling(
  route: RouteHops & {
    readonly candidates: readonly ExposedModel[]
    readonly alias: string | undefined
  },
  position: number,
  attempts: Attempt[]
): boolean {
  const cooldown = cooldownSkip(route.candidates, position, route)
  const candidate = route.candidates[position]
  if (cooldown === undefined || candidate === undefined) return false
  chatLogger.info(
    'Alias {alias}: skipping {model} on {login}, cooling down after {reason} until {until}',
    {
      alias: route.alias,
      model: candidate.canonicalId,
      login: candidate.login,
      reason: cooldown.reason,
      until: new Date(cooldown.until).toISOString(),
      scope: cooldown.scope
    }
  )
  attempts.push({ ...attemptOf(candidate), reason: cooldown.reason, skipped: true })
  return true
}

/**
 * Names a candidate in `x_pi.attempts`: its model, and its login when the model has a choice of
 * them (#227).
 *
 * @param candidate - the candidate, as the route planned it
 * @returns the attempt's `model` and, with several logins, `login`
 */
export function attemptOf(candidate: ExposedModel): Pick<Attempt, 'model' | 'login'> {
  return {
    model: candidate.canonicalId,
    ...(candidate.logins === undefined ? {} : { login: candidate.login })
  }
}

/**
 * Starts the cooldown a failed attempt calls for: after a 429 its login's, after a 503 or 529
 * its model's, for as long as the failed response says (`src/pi/reset-time.ts`).
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
  startCooldown(
    loginSubject(candidate),
    failure,
    captured === undefined ? undefined : resetAfterMs(captured)
  )
}
