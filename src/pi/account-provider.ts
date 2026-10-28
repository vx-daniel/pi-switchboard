/**
 * A login slot's provider (#227): a copy of one of pi's built-in providers under `{provider}-N`.
 *
 * @remarks
 * Kept apart from `src/pi/accounts.ts`, which registers the copies, so that it imports nothing but
 * pi and runs under plain Node: the live recorder (`scripts/record-fixtures.ts`) records a second
 * login through this very code (#233).
 *
 * The copy lists the base's catalog under its own ID and resolves auth under its own ID (the
 * runtime does that by the model's provider), but sends each request as the base provider: pi's
 * API code reads `model.provider` for provider-specific rules, such as `openai`'s ChatGPT sign-in
 * and `github-copilot`'s headers. pi's assistant message therefore names the base provider; the
 * proxy reports the login from the route it chose, never from the message.
 *
 * @packageDocumentation
 */

import type { Provider, ProviderAuth } from '@earendil-works/pi-ai'

/** The first extra login's number; number 1 is the base provider itself. */
export const FIRST_EXTRA_ACCOUNT = 2

/**
 * A login slot's provider ID: the base, then `-N` (the proxy's form), or `-account-N` (pi-rotator
 * and pi-multi-account's, read so a login made through either is served). The base may itself
 * contain `-`; no built-in provider ID ends in a number, so `-N` is never part of a base.
 */
const ACCOUNT_ID = /^(?<base>[^-].*?)-(?:account-)?(?<number>[1-9]\d*)$/

/** A provider's login slot. */
export interface AccountSlot {
  /** `{base}-N`, or `{base}-account-N` for a login pi-rotator or pi-multi-account made. */
  readonly providerId: string
  /** N, from 2. */
  readonly number: number
}

/**
 * Splits an account provider ID into its base and number.
 *
 * @param providerId - any provider ID
 * @returns the base and the number (from 2), or `undefined` for an ID that is not an account slot
 */
export function parseAccountProviderId(
  providerId: string
): { readonly base: string; readonly number: number } | undefined {
  const groups = ACCOUNT_ID.exec(providerId)?.groups
  if (groups?.['base'] === undefined || groups['number'] === undefined) return undefined
  const number = Number(groups['number'])
  return number < FIRST_EXTRA_ACCOUNT ? undefined : { base: groups['base'], number }
}

/**
 * Lists models under another provider ID.
 *
 * @typeParam T - the model type
 * @param models - the models
 * @param provider - the provider ID to list them under
 * @returns the models, each with `provider` replaced
 */
function under<T extends { readonly provider: string }>(
  models: readonly T[],
  provider: string
): T[] {
  return models.map((model) => ({ ...model, provider }))
}

/**
 * Translates a catalog refresh between the copy's ID and the base's.
 *
 * @param base - the base provider, whose `refreshModels` runs
 * @param id - the copy's ID
 * @returns the copy's `refreshModels`
 */
function refreshAs(base: Provider, id: string): NonNullable<Provider['refreshModels']> {
  return (context) =>
    base.refreshModels?.({
      ...context,
      ...(context.stored === undefined
        ? {}
        : { stored: { ...context.stored, models: under(context.stored.models, base.id) } }),
      publish: (publication) =>
        context.publish({
          ...publication,
          ...(publication.persist === undefined || publication.persist === null
            ? {}
            : {
                persist: { ...publication.persist, models: under(publication.persist.models, id) }
              })
        })
    }) ?? Promise.resolve()
}

/**
 * Limits a provider's API-key auth to the login's own stored credential.
 *
 * @remarks
 * A built-in provider's API-key auth falls back to ambient sources when no key is stored:
 * `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, AWS profiles. Those belong to the base login. Shared
 * with a copy, they would configure `anthropic-2` too, and a login whose credential went away
 * would quietly serve on the base's account. Without a stored credential, the copy is not
 * configured. OAuth resolves from the stored credential only, so it is kept as it is.
 *
 * Only "no credential" needs catching: pi's `resolveProviderAuth` (pi-ai 1.4.0) sends a stored
 * credential to the handler of its own type, so `apiKey.resolve` sees an `api_key` credential or
 * none, never an OAuth one, and a failed OAuth refresh never falls back to it.
 *
 * @param auth - the base provider's auth
 * @returns the copy's auth
 */
function storedOnly(auth: ProviderAuth): ProviderAuth {
  const { apiKey } = auth
  if (apiKey === undefined) return auth
  // Bound, so the copy calls pi's method as pi would, whatever it does with `this`.
  const check = apiKey.check?.bind(apiKey)
  return {
    ...auth,
    apiKey: {
      ...apiKey,
      resolve: (input) =>
        input.credential === undefined ? Promise.resolve(undefined) : apiKey.resolve(input),
      ...(check === undefined
        ? {}
        : {
            check: (input) =>
              input.credential === undefined ? Promise.resolve(undefined) : check(input)
          })
    }
  }
}

/**
 * Copies a provider under the ID of one of its logins.
 *
 * @remarks
 * `base` must be a fresh instance: a provider with a dynamic catalog keeps that catalog in a
 * closure, which a copy would otherwise share with the base. The catalog is listed under the
 * copy's ID; requests are sent as `base`; a catalog refresh is translated both ways, so what the
 * copy stores and restores is keyed by its own ID while `base`'s code sees its own.
 *
 * @param base - the built-in provider to copy, freshly constructed
 * @param slot - the login's ID, of either form, and its number
 * @returns the copy
 */
export function accountProvider(base: Provider, slot: AccountSlot): Provider {
  const { providerId: id, number } = slot
  // A shallow copy: pi 1.4.0's built-in providers are plain objects of closures (`createProvider`),
  // so no method relies on `this` or a prototype. The unit tests stream and refresh through the
  // copy, so a pi change that broke this would fail them.
  const copy: Provider = {
    ...base,
    id,
    name: `${base.name} ${String(number)}`,
    auth: storedOnly(base.auth),
    getModels: () => under(base.getModels(), id),
    stream: (model, context, options) =>
      base.stream({ ...model, provider: base.id }, context, options),
    streamSimple: (model, context, options) =>
      base.streamSimple({ ...model, provider: base.id }, context, options)
  }
  if (base.getAllModels !== undefined) {
    copy.getAllModels = () => under(base.getAllModels?.() ?? [], id)
  }
  if (base.refreshModels !== undefined) copy.refreshModels = refreshAs(base, id)
  return copy
}
