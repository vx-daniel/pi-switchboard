/**
 * How a route keeps a login's subscription quota in reserve (#69): it skips a login that has less
 * than its reserve left, for a later candidate. The quota itself is `src/pi/quota.ts`.
 *
 * @remarks
 * - **Configured, per login.** `routing.reserve` in the config file (`{ "anthropic": 0.2 }`),
 *   keyed by the login (`anthropic-2` has its own entry, #227); a login left out, or one
 *   that reports no quota (Google, API keys), is never skipped.
 * - **The worse window decides.** A subscription reports several windows (a 5-hour and a 7-day
 *   one); the login is below its reserve when any of them has less than that share left.
 * - **Between candidates only.** A request with one candidate is sent as before: the reserve only
 *   chooses between candidates. Those are an alias chain's models and, since #227, a model's
 *   logins, so a request that names a model served by two logins skips the first while it is
 *   below its reserve. The reserve is its own configured control (principle VI): it does not
 *   need `quota` in a `fallbackOn`, which names failures, and a reserve skip is not one.
 * - **Never skip them all.** When every remaining candidate is below its reserve, the one with the
 *   most left is tried, so a reserve never fails a request by itself.
 *
 * @packageDocumentation
 */

import type { Reserve } from '@proxy/config/schema'
import { proxyLogger } from '@proxy/logging'
import type { ExposedModel } from '@proxy/openai/model-exposure'
import type { Attempt } from '@proxy/openai/responses'
import { providerQuota } from '@proxy/pi/quota'
import { attemptOf, coolingForChain } from '@proxy/server/route-cooldowns'
import type { RouteHops } from '@proxy/server/route-hops'

/** Logger for routing decisions, as for the chat route's other skips. */
const chatLogger = proxyLogger('server', 'chat')

/**
 * Steps the share left is rounded to: `1 - 0.8` is `0.19999999999999996` in floating point, which
 * would put a provider with exactly its reserve left below it.
 */
const SHARE_STEPS = 1_000_000

/** Why a chain skips a candidate: its provider has less than its reserve left. */
export interface ReserveSkip {
  readonly provider: string
  /** The window with the least left, by the provider's name for it (`5h`, `secondary`). */
  readonly window: string
  /** The share of that window left, from 0 to 1. */
  readonly left: number
  /** The provider's reserve. */
  readonly reserve: number
}

/**
 * Finds the window a provider has the least left of, from its latest quota report.
 *
 * @param provider - the provider
 * @param now - the current time
 * @returns the window's name and share left, or `undefined` when the provider reports none
 */
function tightestWindow(
  provider: string,
  now: number
): { readonly window: string; readonly left: number } | undefined {
  const windows = providerQuota(provider, now)?.windows ?? []
  return windows.reduce<{ window: string; left: number } | undefined>((tightest, window) => {
    const left = Math.round((1 - window.used) * SHARE_STEPS) / SHARE_STEPS
    return tightest === undefined || left < tightest.left ? { window: window.name, left } : tightest
  }, undefined)
}

/**
 * Checks whether a provider is below its reserve, for a chain or for the console's Accounts view.
 *
 * @param provider - the provider
 * @param reserve - the reserve per provider
 * @param now - the current time; `Date.now()` by default
 * @returns why it is below, or `undefined` when it is not (or has no reserve or no quota)
 */
export function providerBelowReserve(
  provider: string,
  reserve: Reserve,
  now: number = Date.now()
): ReserveSkip | undefined {
  const kept = reserve[provider]
  if (kept === undefined) return undefined
  const tightest = tightestWindow(provider, now)
  if (tightest === undefined || tightest.left >= kept) return undefined
  return { provider, ...tightest, reserve: kept }
}

/**
 * Checks whether a candidate's provider is below its reserve.
 *
 * @param candidate - the candidate, or `undefined` past the chain's end
 * @param reserve - the reserve per provider
 * @param now - the current time
 * @returns why it is below, or `undefined` when it is not
 */
function belowReserve(
  candidate: ExposedModel | undefined,
  reserve: Reserve,
  now: number
): ReserveSkip | undefined {
  return candidate === undefined ? undefined : providerBelowReserve(candidate.login, reserve, now)
}

/**
 * Decides whether the chain skips the candidate at `position` because its provider is below its
 * reserve.
 *
 * @remarks
 * A later candidate the chain will skip for its cooldown (#68) is not an alternative: with
 * `[below its reserve, cooling down]`, the first one is called rather than skipped for one the
 * chain would not call either.
 *
 * @param candidates - the chain's candidates, in order
 * @param position - the candidate's position
 * @param rules - the reserve per provider, and the classes named for each kind of hop (for the
 *   cooldowns the chain skips)
 * @param rules.reserve - the reserve per provider
 * @param now - the current time; `Date.now()` by default
 * @returns why it is skipped, or `undefined` to call it
 */
export function reserveSkip(
  candidates: readonly ExposedModel[],
  position: number,
  rules: RouteHops & { readonly reserve: Reserve },
  now: number = Date.now()
): ReserveSkip | undefined {
  const { reserve } = rules
  const own = belowReserve(candidates[position], reserve, now)
  if (own === undefined) return undefined
  const alternatives = candidates
    .map((candidate, later) => ({ candidate, later }))
    .slice(position + 1)
    .filter(({ later }) => !coolingForChain(candidates, { from: position, to: later }, rules, now))
    .map(({ candidate }) => candidate)
  if (alternatives.some((later) => belowReserve(later, reserve, now) === undefined)) return own
  // Every alternative is below its reserve too, or there is none: call the one with the most left.
  const mostLeft = alternatives.every(
    (later) => (belowReserve(later, reserve, now)?.left ?? 0) <= own.left
  )
  return mostLeft ? undefined : own
}

/**
 * Skips a candidate whose provider is below its reserve: logs the skip at `info` and lists it in
 * `attempts` (`reason: "quota"`, `skipped: true`), as a cooldown skip is.
 *
 * @param chain - the candidates, the classes named for each kind of hop, the reserve per login,
 *   and the alias
 * @param chain.candidates - the chain's candidates
 * @param chain.reserve - the reserve per login
 * @param chain.alias - the alias whose chain it is
 * @param position - the candidate's index in `chain.candidates`
 * @param attempts - the attempts so far; a skip is added to them
 * @returns whether the candidate is skipped
 */
export function skipBelowReserve(
  chain: RouteHops & {
    readonly candidates: readonly ExposedModel[]
    readonly reserve: Reserve
    readonly alias: string | undefined
  },
  position: number,
  attempts: Attempt[]
): boolean {
  const skip = reserveSkip(chain.candidates, position, chain)
  const candidate = chain.candidates[position]
  if (skip === undefined || candidate === undefined) return false
  chatLogger.info(
    'Alias {alias}: skipping {model}, {provider} has {left} of its {window} window left, below its reserve of {reserve}',
    {
      alias: chain.alias,
      model: candidate.canonicalId,
      provider: skip.provider,
      window: skip.window,
      left: skip.left,
      reserve: skip.reserve
    }
  )
  attempts.push({ ...attemptOf(candidate), reason: 'quota', skipped: true })
  return true
}
