/**
 * Several logins per provider (#227): `{provider}-account-N` providers, each a copy of one of pi's
 * built-in providers under its own ID.
 *
 * @remarks
 * pi stores one credential per provider ID. A second login to the same service therefore needs a
 * second provider: `anthropic-account-2`, which pi logs into and whose credential pi stores under
 * that ID. Nothing is configured: at startup, every `{provider}-account-N` credential in pi's
 * store gets its provider back ({@link registerStoredAccounts}); the console's login list offers
 * the next free slot of each provider that is logged in, and logging in to it registers it first
 * ({@link registerAccountProvider}); logging out of a slot drops it again
 * ({@link unregisterAccountProvider}), so the slot is reused. Cooldowns, quota, the reserve,
 * `x_pi` and the log are all keyed by provider, so each login gets them separately; a fallback
 * chain (#67) from `anthropic/X` to `anthropic-account-2/X` moves to the second login on a rate
 * limit.
 *
 * A copy is made from a fresh built-in provider (`builtinProviders()`), not from the composed one
 * the runtime holds: the composed provider carries the base's `models.json` overrides, including
 * an `apiKey`, which must not leak into another login. A `models.json` entry under the copy's own
 * ID composes above it as for any native provider.
 *
 * The copy lists the base's catalog under its own ID and resolves auth under its own ID (the
 * runtime does that by the model's provider), but sends each request as the base provider: pi's
 * API code reads `model.provider` for provider-specific rules, such as `openai`'s ChatGPT sign-in
 * and `github-copilot`'s headers. pi's assistant message therefore names the base provider; the
 * proxy reports the login from the route it chose, never from the message.
 *
 * The idea, and the `{provider}-account-N` convention, come from pi-rotator and pi-multi-account
 * (MIT), so a login made through either appears here unchanged. Neither extension is loaded.
 *
 * @packageDocumentation
 */

import type { Provider } from '@earendil-works/pi-ai'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { proxyLogger } from '@proxy/logging'

/** Logger for account registration. */
const accountsLogger = proxyLogger('pi', 'registry')

/** The first extra login's number; number 1 is the base provider itself. */
const FIRST_EXTRA_ACCOUNT = 2

/** An account provider ID: the base, then `-account-N`. The base may itself contain `-`. */
const ACCOUNT_ID = /^(?<base>.+)-account-(?<number>[1-9]\d*)$/

/** What account registration needs of pi's runtime. */
export type AccountRuntime = Pick<
  ModelRuntime,
  'getProvider' | 'listCredentials' | 'registerNativeProvider' | 'unregisterProvider'
>

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
 * Returns the provider ID of a provider's Nth login.
 *
 * @param base - the base provider's ID
 * @param number - the login's number, from 2
 * @returns `{base}-account-{number}`
 */
export function accountProviderId(base: string, number: number): string {
  return `${base}-account-${String(number)}`
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
 * Copies a provider under the ID of its Nth login.
 *
 * @remarks
 * `base` must be a fresh instance: a provider with a dynamic catalog keeps that catalog in a
 * closure, which a copy would otherwise share with the base. The catalog is listed under the
 * copy's ID; requests are sent as `base`; a catalog refresh is translated both ways, so what the
 * copy stores and restores is keyed by its own ID while `base`'s code sees its own.
 *
 * @param base - the built-in provider to copy, freshly constructed
 * @param number - the login's number, from 2
 * @returns the copy
 */
export function accountProvider(base: Provider, number: number): Provider {
  const id = accountProviderId(base.id, number)
  const copy: Provider = {
    ...base,
    id,
    name: `${base.name} (account ${String(number)})`,
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

/**
 * Registers an account slot as a provider, if it is one and is not registered yet.
 *
 * @remarks
 * A base that is not one of pi's built-in providers is refused: a `models.json` provider is
 * composed, not built in, and its key would be copied with it.
 *
 * @param runtime - pi's model runtime
 * @param providerId - the slot, `{base}-account-N`
 * @returns whether this call registered it; `false` when it already was, or it is no slot of a
 *   built-in provider
 */
export function registerAccountProvider(runtime: AccountRuntime, providerId: string): boolean {
  const slot = parseAccountProviderId(providerId)
  if (slot === undefined || runtime.getProvider(providerId) !== undefined) return false
  const fresh = builtinProviders().find((provider) => provider.id === slot.base)
  if (fresh === undefined) {
    accountsLogger.warn('{provider} is no login slot of a built-in pi provider; not registered', {
      provider: providerId
    })
    return false
  }
  runtime.registerNativeProvider(accountProvider(fresh, slot.number))
  accountsLogger.info('Registered {provider} as a login of {base}', {
    provider: providerId,
    base: slot.base
  })
  return true
}

/**
 * Drops an account slot's provider, if it is one and is registered.
 *
 * @param runtime - pi's model runtime
 * @param providerId - the slot, `{base}-account-N`
 */
export function unregisterAccountProvider(runtime: AccountRuntime, providerId: string): void {
  if (parseAccountProviderId(providerId) === undefined) return
  if (runtime.getProvider(providerId) === undefined) return
  runtime.unregisterProvider(providerId)
  accountsLogger.info('Dropped {provider}: logged out', { provider: providerId })
}

/** A provider's next free login slot. */
export interface AccountSlot {
  /** `{base}-account-N`. */
  readonly providerId: string
  /** N, from 2. */
  readonly number: number
}

/**
 * Returns a provider's lowest account slot that is not registered.
 *
 * @param runtime - pi's model runtime
 * @param base - the base provider
 * @returns the slot, for the lowest free N from 2
 */
export function nextAccountSlot(runtime: AccountRuntime, base: string): AccountSlot {
  let number = FIRST_EXTRA_ACCOUNT
  while (runtime.getProvider(accountProviderId(base, number)) !== undefined) number += 1
  return { providerId: accountProviderId(base, number), number }
}

/** The IDs of pi's built-in providers, read once. */
let builtinIds: ReadonlySet<string> | undefined

/**
 * Says whether a provider is one of pi's built-in providers, which is what a login slot copies.
 *
 * @param providerId - the provider
 * @returns whether pi builds it in
 */
export function isBuiltinProvider(providerId: string): boolean {
  builtinIds ??= new Set(builtinProviders().map((provider) => provider.id))
  return builtinIds.has(providerId)
}

/**
 * Registers a provider for every account slot pi has a credential for.
 *
 * @remarks
 * Runs at startup, so a login made in an earlier run, or through pi-rotator or pi-multi-account,
 * is served again. A credential whose base is no built-in provider is left as it is, with a
 * warning. A store that cannot be listed (unreadable, or not within `signal`) registers nothing
 * and is logged as a warning: the proxy starts with pi's base providers, as it did before slots
 * existed, rather than not at all.
 *
 * @param runtime - pi's model runtime
 * @param signal - bounds the credential listing
 * @returns the registered provider IDs
 */
export async function registerStoredAccounts(
  runtime: AccountRuntime,
  signal: AbortSignal
): Promise<string[]> {
  let stored: readonly { readonly providerId: string }[]
  try {
    stored = await runtime.listCredentials({ signal })
  } catch (error) {
    accountsLogger.warn(
      'Could not list the stored credentials; extra logins are not registered: {reason}',
      { reason: error instanceof Error ? error.message : String(error) }
    )
    return []
  }
  return stored
    .map(({ providerId }) => providerId)
    .filter((providerId) => registerAccountProvider(runtime, providerId))
}
