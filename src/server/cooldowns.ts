/**
 * Cooldowns over HTTP: the shape `/healthz/models` lists them in, and `DELETE
 * /v1/switchboard/cooldowns` (#182), which ends them early without a restart.
 *
 * @remarks
 * - **What it clears.** No query ends every cooldown. `provider` names a login (`anthropic-2`), and
 *   ends its cooldown after a 429; `model` names a model (canonical or public ID), and ends its own
 *   cooldown after a 503 or 529, not its logins'. Both end both.
 * - **Unknown names.** A name that is neither exposed (a login serving an exposed model, an exposed
 *   model) nor cooling down now is a `404`, so a typo does not look like a clear. A known name with
 *   nothing cooling answers `200` with an empty list.
 * - **Routing only.** Clearing changes which candidates a fallback chain skips (principle VI); it
 *   reaches no model and calls no provider.
 *
 * @packageDocumentation
 */

import { MS_PER_SECOND } from '@proxy/config/schema'
import type { ModelExposureResult } from '@proxy/openai/model-exposure'
import { activeCooldowns, clearCooldownsFor, type Cooldown } from '@proxy/pi/cooldowns'
import { loginNotFound, modelNotFound, type OpenAIError } from '@proxy/server/errors'
import { HTTP_NOT_FOUND, HTTP_OK } from '@proxy/server/http-status'
import * as z from 'zod'

/** One active cooldown, as `/healthz/models` and the clear route show it. */
export const cooldownViewSchema = z.object({
  scope: z.enum(['provider', 'model']),
  provider: z.string().trim().meta({ description: "The login's provider ID." }),
  model: z.string().trim().nullable().meta({ description: 'The canonical ID, for a model.' }),
  reason: z.enum(['rate_limit', 'unavailable']),
  until: z.string().trim().meta({ description: 'When it ends, as an ISO 8601 time.' }),
  secondsLeft: z.int().nonnegative(),
  source: z.enum(['response', 'backoff']).meta({
    description:
      'Whether the failed response gave the time, or the growing default did (60 s, 180 s, then ' +
      'doubling).'
  })
})

/** One active cooldown, as the API shows it. */
type CooldownView = z.infer<typeof cooldownViewSchema>

/**
 * Shows a cooldown over HTTP: login and model names only, never a credential.
 *
 * @param cooldown - the cooldown
 * @param now - the current time, for the seconds left
 * @returns its view
 */
export function cooldownView(cooldown: Cooldown, now: number): CooldownView {
  return {
    scope: cooldown.scope,
    provider: cooldown.provider,
    model: cooldown.model ?? null,
    reason: cooldown.reason,
    until: new Date(cooldown.until).toISOString(),
    secondsLeft: Math.max(0, Math.ceil((cooldown.until - now) / MS_PER_SECOND)),
    source: cooldown.source
  }
}

/** The body of `DELETE /v1/switchboard/cooldowns`: the cooldowns it ended. */
export const clearedCooldownsSchema = z
  .object({
    object: z.literal('list'),
    data: z.array(cooldownViewSchema)
  })
  .meta({
    id: 'ClearedCooldowns',
    description: 'The cooldowns that were active and are now ended, soonest end first.'
  })

/** The body of `DELETE /v1/switchboard/cooldowns`. */
type ClearedCooldowns = z.infer<typeof clearedCooldownsSchema>

/** The route's answer: a status and its body. */
export type ClearCooldownsAnswer =
  | { readonly status: typeof HTTP_OK; readonly body: ClearedCooldowns }
  | { readonly status: typeof HTTP_NOT_FOUND; readonly body: OpenAIError }

/**
 * Finds the canonical ID a `model` value names: an exposed model's public or canonical ID, or a
 * model cooling down now (the exposure config may have hidden it since).
 *
 * @param model - the `model` value
 * @param cooling - the active cooldowns
 * @param exposure - reads the exposure, only when the cooldowns do not settle it
 * @returns the canonical ID, or `undefined` when nothing is known by that name
 */
async function canonicalModel(
  model: string,
  cooling: readonly Cooldown[],
  exposure: () => Promise<ModelExposureResult>
): Promise<string | undefined> {
  if (cooling.some((cooldown) => cooldown.model === model)) return model
  const { byPublicId, byCanonicalId } = await exposure()
  return (byPublicId.get(model) ?? byCanonicalId.get(model))?.canonicalId
}

/**
 * Says whether a `provider` value names a login: one serving an exposed model, or one cooling down
 * now.
 *
 * @param provider - the `provider` value
 * @param cooling - the active cooldowns
 * @param exposure - reads the exposure, only when the cooldowns do not settle it
 * @returns whether the login is known
 */
async function knownLogin(
  provider: string,
  cooling: readonly Cooldown[],
  exposure: () => Promise<ModelExposureResult>
): Promise<boolean> {
  if (cooling.some((cooldown) => cooldown.provider === provider)) return true
  const { models } = await exposure()
  return models.some((model) =>
    (model.logins ?? [model]).some((served) => served.login === provider)
  )
}

/**
 * Answers `DELETE /v1/switchboard/cooldowns`: ends the cooldowns the query names, or every one.
 *
 * @param query - the query, each name by its first value
 * @param query.provider - a login's provider ID
 * @param query.model - a model's canonical or public ID
 * @param exposure - reads the exposed models; called only to check a name no cooldown matches
 * @param now - the current time
 * @returns `200` with the cooldowns ended, or `404` for a name nothing is known by
 */
export async function clearCooldownsAnswer(
  query: { readonly provider: string | undefined; readonly model: string | undefined },
  exposure: () => Promise<ModelExposureResult>,
  now: number
): Promise<ClearCooldownsAnswer> {
  const { provider, model } = query
  const cooling = activeCooldowns(now)
  if (provider !== undefined && !(await knownLogin(provider, cooling, exposure))) {
    return { status: HTTP_NOT_FOUND, body: loginNotFound(provider) }
  }
  const canonicalId =
    model === undefined ? undefined : await canonicalModel(model, cooling, exposure)
  if (model !== undefined && canonicalId === undefined) {
    return { status: HTTP_NOT_FOUND, body: modelNotFound(model) }
  }
  const cleared = clearCooldownsFor({ provider, model: canonicalId }, now)
  return {
    status: HTTP_OK,
    body: { object: 'list', data: cleared.map((cooldown) => cooldownView(cooldown, now)) }
  }
}
