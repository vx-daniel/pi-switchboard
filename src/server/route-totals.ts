/**
 * Running usage totals per route (#70): alias × provider × served model, in memory since the
 * process started (or {@link clearRouteTotals}).
 *
 * @remarks
 * The chat dispatcher records every attempt of a request's chain (`chat-dispatch.ts`): a request
 * on its row, a failure and its class, a fallback when the chain moves on from it, and the tokens
 * and cost pi reports for each upstream call. Cooldown skips are not attempts. Nothing here
 * persists: the log is the durable record, and the totals start again at zero on restart. The
 * terminal console (#61) reads them in-process; no HTTP route serves them.
 *
 * A row holds only the route and counts, never message content, the request's `user`, or a
 * credential.
 *
 * @packageDocumentation
 */

import type { Usage } from '@earendil-works/pi-ai'
import type { FailureClass } from '@proxy/config/schema'
import { proxyLogger } from '@proxy/logging'
import type { ExposedModel } from '@proxy/openai/model-exposure'
import { notifyListeners } from '@proxy/utils/listeners'

/** Logger for a listener that throws: the chat route's category, as the dispatcher records here. */
const totalsLogger = proxyLogger('server', 'chat')

/**
 * One route's running totals.
 *
 * @remarks
 * Rows are never pruned: a row for an alias that was renamed or removed from the config (read per
 * request) stays until restart or {@link clearRouteTotals}. Their number is bounded by the aliases
 * and models ever used, alias × model.
 *
 * The tokens and cost are per upstream call, `requests` per attempt. A model that refuses
 * `prompt_cache_breakpoint` (#163) is called twice in one attempt, the second time without the
 * field, and both calls' usage is added to the one request. The refusal is a 400, which reports
 * no tokens from the providers seen so far, but a provider that did report some would make those
 * rows' tokens per request look higher than one call's.
 */
export interface RouteTotals {
  /** The alias the request named, or `null` for a request that named a model. */
  readonly alias: string | null
  /** The provider of the model the attempts went to. */
  readonly provider: string
  /** The canonical `provider/model-id` of that model. */
  readonly model: string
  /** Attempts on this model under this alias, first and fallback; cooldown skips are not counted. */
  readonly requests: number
  /** Attempts that failed, of any class or none (a 400 has none). */
  readonly failures: number
  /** The failures that have a class, by class. */
  readonly failuresByClass: Readonly<Partial<Record<FailureClass, number>>>
  /** How often the chain moved on from this model to the next. */
  readonly fallbacks: number
  /** Uncached input tokens, as pi reports them. */
  readonly inputTokens: number
  /** Output tokens, reasoning included. */
  readonly outputTokens: number
  /** Input tokens read from the provider's cache. */
  readonly cacheReadTokens: number
  /** Input tokens written to the provider's cache. */
  readonly cacheWriteTokens: number
  /** Cost in US dollars, from the model's prices in pi's catalog. */
  readonly costUsd: number
}

/** The route an attempt ran on: what a row is keyed by. */
export interface RouteKey {
  /** The alias the request named, or `null`. */
  readonly alias: string | null
  /** The served model's provider. */
  readonly provider: string
  /** The served model's canonical `provider/model-id`. */
  readonly model: string
}

/** A row while it is counted: the same fields, writable. */
type MutableTotals = { -readonly [Field in keyof RouteTotals]: RouteTotals[Field] } & {
  failuresByClass: Partial<Record<FailureClass, number>>
}

/** The rows, keyed by `[alias, provider, model]` as JSON, so no separator can make two collide. */
const rows = new Map<string, MutableTotals>()
/**
 * One update to the totals, as listeners get it: an attempt, a failure, a fallback, one upstream
 * call's usage, or the totals cleared. The stats recorder (`src/stats/recorder.ts`) keeps them.
 */
export type RouteEvent =
  | { readonly kind: 'attempt'; readonly key: RouteKey }
  | { readonly kind: 'fallback'; readonly key: RouteKey }
  | { readonly kind: 'failure'; readonly key: RouteKey; readonly failure: FailureClass | undefined }
  | { readonly kind: 'usage'; readonly key: RouteKey; readonly usage: RouteUsage }
  | { readonly kind: 'cleared' }

/** One upstream call's tokens and cost, as a {@link RouteEvent} carries them. */
export interface RouteUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly costUsd: number
}

/** Who is told after each update. */
const listeners = new Set<(event: RouteEvent) => void>()
/** When counting began, in epoch milliseconds. */
let since = Date.now()

/**
 * Returns the route's row, creating an empty one the first time.
 *
 * @param key - the route
 * @returns the row
 */
function rowFor(key: RouteKey): MutableTotals {
  const id = JSON.stringify([key.alias, key.provider, key.model])
  const existing = rows.get(id)
  if (existing !== undefined) return existing
  const row: MutableTotals = {
    alias: key.alias,
    provider: key.provider,
    model: key.model,
    requests: 0,
    failures: 0,
    failuresByClass: {},
    fallbacks: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0
  }
  rows.set(id, row)
  return row
}

/**
 * Tells every listener what changed. A listener that throws is logged and skipped: the request
 * that caused the update must not fail for it.
 *
 * @param event - the update
 */
function notify(event: RouteEvent): void {
  notifyListeners(listeners, [event], totalsLogger, 'route totals')
}

/**
 * Counts one attempt on a route.
 *
 * @param key - the route
 */
export function recordRouteAttempt(key: RouteKey): void {
  rowFor(key).requests += 1
  notify({ kind: 'attempt', key })
}

/**
 * Counts one failed attempt on a route.
 *
 * @param key - the route
 * @param failure - the failure's class, or `undefined` for one with none (a 400)
 */
export function recordRouteFailure(key: RouteKey, failure: FailureClass | undefined): void {
  const row = rowFor(key)
  row.failures += 1
  if (failure !== undefined) {
    row.failuresByClass[failure] = (row.failuresByClass[failure] ?? 0) + 1
  }
  notify({ kind: 'failure', key, failure })
}

/**
 * Counts the chain moving on from a route's model to the next.
 *
 * @param key - the route of the model it moved on from
 */
export function recordRouteFallback(key: RouteKey): void {
  rowFor(key).fallbacks += 1
  notify({ kind: 'fallback', key })
}

/**
 * Adds one finished upstream call's tokens and cost to a route.
 *
 * @param key - the route
 * @param usage - the usage on pi's final assistant message
 */
export function recordRouteUsage(key: RouteKey, usage: Usage): void {
  const row = rowFor(key)
  const call: RouteUsage = {
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    costUsd: usage.cost.total
  }
  row.inputTokens += call.inputTokens
  row.outputTokens += call.outputTokens
  row.cacheReadTokens += call.cacheReadTokens
  row.cacheWriteTokens += call.cacheWriteTokens
  row.costUsd += call.costUsd
  notify({ kind: 'usage', key, usage: call })
}

/**
 * Names the route an attempt runs on.
 *
 * @param alias - the alias the request named, or `undefined`
 * @param candidate - the model the attempt goes to
 * @returns the alias (`null` for none), the provider and the canonical model ID
 */
export function routeKey(alias: string | undefined, candidate: ExposedModel): RouteKey {
  return { alias: alias ?? null, provider: candidate.model.provider, model: candidate.canonicalId }
}

/**
 * Builds the failure counter for one started stream: it counts at most one failure on the route,
 * and none once the client has left. An `error` event and a throw out of the relay can both end
 * the same stream (a write failing after the error event, say), and the attempt failed once.
 *
 * @param key - the attempt's route
 * @param signal - the client's disconnect signal
 * @returns a function that counts the stream's failure, given its class, the first time only
 */
export function streamFailureCounter(
  key: RouteKey,
  signal: AbortSignal | undefined
): (failure: FailureClass | undefined) => void {
  let counted = false
  return (failure) => {
    if (counted || signal?.aborted === true) return
    counted = true
    recordRouteFailure(key, failure)
  }
}

/**
 * Orders rows by alias (requests without one first), then model.
 *
 * @param left - one row
 * @param right - the other
 * @returns negative, zero or positive, as `Array.prototype.sort` wants
 */
function byRoute(left: RouteTotals, right: RouteTotals): number {
  if (left.alias !== right.alias) {
    if (left.alias === null) return -1
    if (right.alias === null) return 1
    return left.alias.localeCompare(right.alias)
  }
  return left.model.localeCompare(right.model)
}

/**
 * Returns a snapshot of every route's totals.
 *
 * @returns copies of the rows, ordered by alias (none first), then model
 */
export function routeTotals(): readonly RouteTotals[] {
  return [...rows.values()]
    .map((row) => ({ ...row, failuresByClass: { ...row.failuresByClass } }))
    .toSorted(byRoute)
}

/**
 * Returns when counting began.
 *
 * @returns epoch milliseconds: the process start (module load) or the last {@link clearRouteTotals}
 */
export function routeTotalsSince(): number {
  return since
}

/**
 * Subscribes to updates.
 *
 * @param listener - called after every update with what changed; read {@link routeTotals} for the
 *   new values
 * @returns a function that unsubscribes the listener
 */
export function onRouteTotalsChange(listener: (event: RouteEvent) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Drops every row and starts counting again now, then tells the listeners, which stay
 * subscribed: a console that resets the totals shows the empty table at once.
 */
export function clearRouteTotals(): void {
  rows.clear()
  since = Date.now()
  notify({ kind: 'cleared' })
}
