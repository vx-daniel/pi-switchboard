/**
 * Which models the proxy's login has refused or answered (#174), kept in memory for the life of
 * the process and shown on `/v1/switchboard/models`.
 *
 * @remarks
 * - **Keyed by canonical ID.** A model's extra logins (`codex-2`, #227) are the same model, so
 *   one state covers them all; an alias reports its target's, since its entry is the target.
 * - **Latest result wins.** A refusal after a success shows `refused`, and a success after one
 *   shows `verified`: a plan can change.
 * - **Only the shared login writes it.** A request with the client's own upstream key says
 *   nothing about the login other clients use; its dispatch does not record here.
 * - **The first refusal is logged** at info, naming the model, and again only after the model
 *   was verified in between. Every refused request is still logged at error by its route.
 *
 * @packageDocumentation
 */

import type { FailureClass } from '@proxy/config/schema'
import { proxyLogger } from '@proxy/logging'

/** Logger for routing decisions. */
const availabilityLogger = proxyLogger('server', 'chat')

/** Whether the login serves a model: answered it, refused it, or never called. */
export type ModelAvailability = 'verified' | 'refused' | 'unknown'

/** Each called model's latest result, by canonical ID. */
const availability = new Map<string, 'verified' | 'refused'>()

/**
 * Records the login answering or refusing a model.
 *
 * @param canonicalId - the model's canonical ID, `provider/model-id`
 * @param state - `verified` after a successful answer, `refused` after the login refused it
 */
function recordAvailability(canonicalId: string, state: 'verified' | 'refused'): void {
  const previous = availability.get(canonicalId)
  availability.set(canonicalId, state)
  if (state === 'refused' && previous !== 'refused') {
    availabilityLogger.info('The provider login refused {model}; it shows as refused', {
      model: canonicalId
    })
  }
}

/**
 * Records what an attempt says about the login serving its model: a refusal marks the model
 * `refused`, a whole answer `verified`. A client's own upstream key is another login, so its
 * results are not recorded.
 *
 * @param canonicalId - the model called
 * @param options - the call's options, for the client's own key
 * @param options.upstreamApiKey - the client's own upstream key, if it sent one
 * @param result - `answered` for a whole answer, else the failure's class
 */
export function noteAvailability(
  canonicalId: string,
  options: { readonly upstreamApiKey?: string | undefined },
  result: 'answered' | FailureClass | undefined
): void {
  if (options.upstreamApiKey !== undefined) return
  if (result === 'answered') recordAvailability(canonicalId, 'verified')
  else if (result === 'refused') recordAvailability(canonicalId, 'refused')
}

/**
 * Reports a model's availability.
 *
 * @param canonicalId - the model's canonical ID
 * @returns its latest result, or `unknown` before any call
 */
export function modelAvailability(canonicalId: string): ModelAvailability {
  return availability.get(canonicalId) ?? 'unknown'
}

/** Forgets every result, for tests. */
export function clearAvailability(): void {
  availability.clear()
}
