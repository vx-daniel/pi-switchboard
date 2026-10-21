/**
 * Cooldowns after rate limits and overload (#68): which providers and models are failing, and
 * until when, kept in memory for the life of the process.
 *
 * @remarks
 * - **Scope.** A 429 (`rate_limit`) cools the whole **provider**: pi has one login per provider, and
 *   a subscription's limits apply to the account. A 503 or 529 (`unavailable`) cools the **model**.
 * - **Length.** The time the failed response gives (`src/pi/reset-time.ts`), however long. When it
 *   gives none, a growing default: 60 s, then 180 s, then doubling (360 s, 720 s, …) for each
 *   failure in a row, until a time is given or a call succeeds.
 * - **Recorded from every request; applied only by routing.** Every 429 or 503 is recorded,
 *   whichever request met it, so `/healthz/models` and `/v1/switchboard/models` show it. Only an
 *   alias's fallback chain skips a cooling model, and only when its `fallbackOn` names the class
 *   (principle VI): a request that names a model still calls it.
 * - **Ended by a success.** A call that succeeds clears its provider's and its model's cooldowns.
 *
 * @packageDocumentation
 */

import { MS_PER_SECOND } from '@proxy/config/schema'
import { proxyLogger } from '@proxy/logging'
import { LATEST_DATE_MS } from '@proxy/pi/reset-time'

/** Logger for routing decisions. */
const cooldownLogger = proxyLogger('server', 'chat')

/** The failure classes that start a cooldown. */
export type CooldownReason = 'rate_limit' | 'unavailable'

/** The model a cooldown is recorded or looked up for. */
export interface CooldownSubject {
  readonly provider: string
  /** The canonical ID, `provider/model-id`. */
  readonly canonicalId: string
}

/** One provider's or model's cooldown. */
export interface Cooldown {
  /** `provider` after a 429, `model` after a 503 or 529. */
  readonly scope: 'provider' | 'model'
  readonly provider: string
  /** The canonical ID, for a model's cooldown. */
  readonly model: string | undefined
  readonly reason: CooldownReason
  /** When it started, in milliseconds since the epoch. */
  readonly since: number
  /** When it ends, in milliseconds since the epoch. */
  readonly until: number
  /** Whether the failed response gave the time (`response`) or the default gave it (`backoff`). */
  readonly source: 'response' | 'backoff'
  /** Failures in a row without a time, for the growing default; 0 after a response's time. */
  readonly streak: number
}

/** The first default cooldown, in milliseconds. */
const FIRST_BACKOFF_MS = 60_000
/** The second default cooldown; each later one doubles it. */
const SECOND_BACKOFF_MS = 180_000
/** Each default cooldown after the second is this many times the one before. */
const BACKOFF_GROWTH = 2
/** The streak whose cooldown is {@link SECOND_BACKOFF_MS}. */
const SECOND_STREAK = 2

/** Cooldowns by key ({@link keyOf}), active or expired; an expired one keeps its streak. */
const cooldowns = new Map<string, Cooldown>()
/** Keys whose end has been logged: a cooldown ends once, when it is next looked up. */
const endLogged = new Set<string>()

/**
 * The default cooldown for a run of failures without a time: 60 s, 180 s, then doubling.
 *
 * @param streak - the failures in a row without a time, from 1
 * @returns the cooldown in milliseconds
 */
export function backoffMs(streak: number): number {
  return streak <= 1
    ? FIRST_BACKOFF_MS
    : SECOND_BACKOFF_MS * BACKOFF_GROWTH ** (streak - SECOND_STREAK)
}

/**
 * Names the map key of a provider's or a model's cooldown.
 *
 * @param scope - provider or model
 * @param subject - the model
 * @returns the key
 */
function keyOf(scope: Cooldown['scope'], subject: CooldownSubject): string {
  return scope === 'provider' ? `provider:${subject.provider}` : `model:${subject.canonicalId}`
}

/**
 * Starts (or extends) the cooldown a failure calls for.
 *
 * @param subject - the model that failed
 * @param reason - its failure class
 * @param waitMs - the wait the failed response gave, or `undefined` when it gave none
 * @param now - the current time
 * @returns the cooldown
 */
export function startCooldown(
  subject: CooldownSubject,
  reason: CooldownReason,
  waitMs: number | undefined,
  now: number = Date.now()
): Cooldown {
  const scope = reason === 'rate_limit' ? 'provider' : 'model'
  const key = keyOf(scope, subject)
  const streak = waitMs === undefined ? (cooldowns.get(key)?.streak ?? 0) + 1 : 0
  const cooldown: Cooldown = {
    scope,
    provider: subject.provider,
    model: scope === 'model' ? subject.canonicalId : undefined,
    reason,
    since: now,
    // A long enough streak of failures would grow the default past what a Date can hold.
    until: Math.min(now + (waitMs ?? backoffMs(streak)), LATEST_DATE_MS),
    source: waitMs === undefined ? 'backoff' : 'response',
    streak
  }
  cooldowns.set(key, cooldown)
  endLogged.delete(key)
  cooldownLogger.info('Cooling down {scope} {name} for {seconds} s after {reason} ({source})', {
    scope,
    name: scope === 'provider' ? subject.provider : subject.canonicalId,
    seconds: Math.ceil((cooldown.until - now) / MS_PER_SECOND),
    reason,
    source: cooldown.source,
    streak
  })
  return cooldown
}

/**
 * Clears a model's cooldowns after it answered: its provider's and its own, when they started
 * before the call was sent.
 *
 * @remarks
 * A call sent before a cooldown started says nothing about the limit that started it: the
 * provider took it while there was still room. Clearing on it would erase a fresh cooldown, so
 * the next request would hit the limit again (#181 review).
 *
 * @param subject - the model that answered
 * @param sentAt - when the call that answered was sent, in milliseconds since the epoch
 */
export function clearCooldowns(subject: CooldownSubject, sentAt: number): void {
  for (const scope of ['provider', 'model'] as const) {
    const key = keyOf(scope, subject)
    const cooldown = cooldowns.get(key)
    if (cooldown === undefined || cooldown.since >= sentAt) continue
    cooldowns.delete(key)
    endLogged.delete(key)
    cooldownLogger.info('Cooldown of {scope} {name} cleared: {model} answered', {
      scope,
      name: scope === 'provider' ? subject.provider : subject.canonicalId,
      model: subject.canonicalId
    })
  }
}

/**
 * Looks one key up, logging its end the first time it is found expired.
 *
 * @param key - the map key
 * @param now - the current time
 * @returns the cooldown while active, else `undefined`
 */
function activeAt(key: string, now: number): Cooldown | undefined {
  const cooldown = cooldowns.get(key)
  if (cooldown === undefined) return undefined
  if (cooldown.until > now) return cooldown
  if (!endLogged.has(key)) {
    endLogged.add(key)
    cooldownLogger.info('Cooldown of {scope} {name} ended', {
      scope: cooldown.scope,
      name: cooldown.model ?? cooldown.provider
    })
  }
  return undefined
}

/**
 * Finds the cooldown a model is under: its provider's or its own, whichever ends later.
 *
 * @param subject - the model
 * @param now - the current time
 * @returns the active cooldown, or `undefined` when there is none
 */
export function activeCooldown(
  subject: CooldownSubject,
  now: number = Date.now()
): Cooldown | undefined {
  const provider = activeAt(keyOf('provider', subject), now)
  const model = activeAt(keyOf('model', subject), now)
  if (provider === undefined) return model
  if (model === undefined) return provider
  return model.until > provider.until ? model : provider
}

/**
 * Lists every active cooldown, soonest end first.
 *
 * @param now - the current time
 * @returns the active cooldowns
 */
export function activeCooldowns(now: number = Date.now()): Cooldown[] {
  return [...cooldowns.keys()]
    .map((key) => activeAt(key, now))
    .filter((cooldown): cooldown is Cooldown => cooldown !== undefined)
    .toSorted((left, right) => left.until - right.until)
}

/**
 * Forgets every cooldown and streak, as a restart does. Tests share this process-wide state, so
 * each starts from none.
 */
export function clearAllCooldowns(): void {
  cooldowns.clear()
  endLogged.clear()
}
