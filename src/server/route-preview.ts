/**
 * What a request would do now (#379): the candidate it would call first, and those it would skip
 * before it, for `GET /v1/switchboard/models` and the console's Models view.
 *
 * @remarks
 * - **Routing's own rules.** The candidates are planned as a text request's are
 *   ({@link planLogins}), and walked as the dispatch walks them: a candidate is passed over when
 *   `cooldownSkip` or `reserveSkip` says so, the two checks `dispatchChat` makes. The preview and
 *   routing therefore never disagree, however `routing.logins.fallbackOn`, an alias's
 *   `fallbackOn` or `routing.reserve` are set.
 * - **No credential check, so `next` assumes credentials resolve.** Before calling anything, a
 *   request checks the credential of each candidate it reaches past cooldowns and reserves (#381),
 *   and a refused one fails the request unless the hop names `auth`. Resolving
 *   a credential can refresh an OAuth login, so a preview never does: with a login whose
 *   credential no longer resolves, a request can fail before reaching `next`. Nothing here
 *   records that; `availability` is only the provider's answer to a call.
 * - **Never empty.** Routing never skips every candidate (the last one left is always called), so
 *   there is always a next one.
 *
 * @packageDocumentation
 */

import type { FailureClass, Reserve } from '@proxy/config/schema'
import type { ExposedModel } from '@proxy/openai/model-exposure'
import { activeCooldown, type Cooldown, loginSubject } from '@proxy/pi/cooldowns'
import { attemptOf, cooldownSkip } from '@proxy/server/route-cooldowns'
import { planLogins } from '@proxy/server/route-plan'
import { reserveSkip } from '@proxy/server/route-reserve'
import { MS_PER_SECOND } from '@proxy/utils/time'

/** The config the preview reads: what routing reads for a request, left out as routing defaults it. */
export interface PreviewRules {
  /** `routing.reserve`; none when left out. */
  readonly reserve?: Reserve | undefined
  /** `routing.logins.fallbackOn`; none when left out. */
  readonly loginFallbackOn?: readonly FailureClass[] | undefined
}

/** A candidate the request would pass over, in `x_pi.attempts`' terms. */
export interface PreviewSkip {
  /** Its canonical ID. */
  readonly model: string
  /** Its login, when the model has more than one. */
  readonly login?: string
  /** Why: the failure it is cooling down from, or `quota` below its reserve. */
  readonly reason: FailureClass | 'quota'
  /** When its cooldown ends, in Unix seconds; `null` for a reserve skip. */
  readonly until: number | null
}

/** What a request would do now. */
export interface RoutePreview {
  /** The candidate it would call first: a model under one login. */
  readonly next: ExposedModel
  /** The candidates it would pass over before it, in order. */
  readonly skipped: readonly PreviewSkip[]
}

/**
 * Previews the route a text request naming this model or alias would take now.
 *
 * @param resolved - the exposed model or alias
 * @param rules - the reserve and the logins' fallback classes, as the config sets them
 * @param now - the current time; `Date.now()` by default
 * @returns the candidate it would call first, and those it would skip
 */
export function previewRoute(
  resolved: ExposedModel,
  rules: PreviewRules,
  now: number = Date.now()
): RoutePreview {
  const planned = planLogins(resolved, false, rules.loginFallbackOn ?? [])
  const route = { ...planned, reserve: rules.reserve ?? {} }
  const skipped: PreviewSkip[] = []
  for (const [position, candidate] of route.candidates.entries()) {
    const cooldown = cooldownSkip(route.candidates, position, route, now)
    if (cooldown !== undefined) {
      const until = Math.ceil(cooldown.until / MS_PER_SECOND)
      skipped.push({ ...nameOf(candidate), reason: cooldown.reason, until })
      continue
    }
    if (reserveSkip(route.candidates, position, route, now) !== undefined) {
      skipped.push({ ...nameOf(candidate), reason: 'quota', until: null })
      continue
    }
    return { next: candidate, skipped }
  }
  // Unreachable: neither rule skips the last candidate, which has nothing left to move on to.
  return { next: route.candidates.at(-1) ?? resolved, skipped }
}

/**
 * Finds the cooldown of the login a request naming the model would call now: none while routing
 * would pass a cooling login over for a free one, or the earliest end when every one is cooling.
 *
 * @param resolved - the exposed model or alias
 * @param rules - the reserve and the logins' fallback classes, as the config sets them
 * @param now - the current time
 * @returns the cooldown, or `undefined` when that login is free
 */
export function nextCooldown(
  resolved: ExposedModel,
  rules: PreviewRules,
  now: number
): Cooldown | undefined {
  return activeCooldown(loginSubject(previewRoute(resolved, rules, now).next), now)
}

/**
 * Names a skipped candidate as `x_pi.attempts` does: its model, and its login when it has a choice.
 *
 * @param candidate - the candidate
 * @returns its model and, when the model has more than one login, the login
 */
function nameOf(candidate: ExposedModel): Pick<PreviewSkip, 'model' | 'login'> {
  const { model, login } = attemptOf(candidate)
  return login === undefined ? { model } : { model, login }
}
