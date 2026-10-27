/**
 * Several logins per provider (#227): `{provider}-N` providers, each a copy of one of pi's
 * built-in providers under its own ID.
 *
 * @remarks
 * pi stores one credential per provider ID. A second login to the same service therefore needs a
 * second provider: `anthropic-2`, which pi logs into and whose credential pi stores under that
 * ID. Nothing is configured: at startup, every `{provider}-N` (or `{provider}-account-N`)
 * credential in pi's store gets its provider back ({@link registerStoredAccounts}); the console's
 * login list offers the next free slot of each provider that is logged in, and logging in to it
 * registers it first ({@link registerAccountProvider}); logging out of a slot drops it again
 * ({@link unregisterAccountProvider}), so the slot is reused. Cooldowns, quota, the reserve,
 * `x_pi` and the log are all keyed by provider, so each login gets them separately; routing
 * moves a model's request from one login to the next on a rate limit
 * (`src/server/route-plan.ts`).
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
 * The idea comes from pi-rotator and pi-multi-account (MIT), whose `{provider}-account-N` logins
 * are read and served too. Neither extension is loaded.
 *
 * @packageDocumentation
 */

import type { Provider, ProviderAuth } from '@earendil-works/pi-ai'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { proxyLogger } from '@proxy/logging'
import { recordConsoleEvent } from '@proxy/server/console-events'
import { errorCode, errorMessage } from '@proxy/utils/guards'

/** Logger for account registration. */
const accountsLogger = proxyLogger('pi', 'registry')

/** The first extra login's number; number 1 is the base provider itself. */
const FIRST_EXTRA_ACCOUNT = 2

/**
 * A login slot's provider ID: the base, then `-N` (the proxy's form), or `-account-N` (pi-rotator
 * and pi-multi-account's, read so a login made through either is served). The base may itself
 * contain `-`; no built-in provider ID ends in a number, so `-N` is never part of a base.
 */
const ACCOUNT_ID = /^(?<base>[^-].*?)-(?:account-)?(?<number>[1-9]\d*)$/

/**
 * What account registration needs of pi's runtime. A slot is registered when it is a *native*
 * registration: a `models.json` entry under the slot's ID makes `getProvider` answer before any
 * registration, and composes above the copy once it is registered.
 */
export type AccountRuntime = Pick<
  ModelRuntime,
  | 'getRegisteredNativeProvider'
  | 'listCredentials'
  | 'registerNativeProvider'
  | 'unregisterProvider'
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
 * Returns the provider ID of a provider's Nth login, as the proxy names it.
 *
 * @param base - the base provider's ID
 * @param number - the login's number, from 2
 * @returns `{base}-{number}`
 */
export function accountProviderId(base: string, number: number): string {
  return `${base}-${String(number)}`
}

/**
 * Returns the provider ID of a provider's Nth login as pi-rotator and pi-multi-account name it.
 *
 * @param base - the base provider's ID
 * @param number - the login's number, from 2
 * @returns `{base}-account-{number}`
 */
function legacyAccountProviderId(base: string, number: number): string {
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
 * Limits a provider's API-key auth to the login's own stored credential.
 *
 * @remarks
 * A built-in provider's API-key auth falls back to ambient sources when no key is stored:
 * `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, AWS profiles. Those belong to the base login. Shared
 * with a copy, they would configure `anthropic-2` too, and a login whose credential went away
 * would quietly serve on the base's account. Without a stored credential, the copy is not
 * configured. OAuth resolves from the stored credential only, so it is kept as it is.
 *
 * Only "no credential" needs catching: pi's `resolveProviderAuth` (pi-ai 1.3.0) sends a stored
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
  // A shallow copy: pi 1.3.0's built-in providers are plain objects of closures (`createProvider`),
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

/**
 * Registers an account slot as a provider, if it is one and is not registered yet.
 *
 * @remarks
 * A base that is not one of pi's built-in providers is refused: a `models.json` provider is
 * composed, not built in, and its key would be copied with it. Only the explicit
 * `{base}-account-N` form is warned about; a `{base}-N` ID of an unknown base is most likely a
 * provider whose name ends in a number (`local-2`), and stays its own, silently.
 *
 * @param runtime - pi's model runtime
 * @param providerId - the slot, `{base}-N` or `{base}-account-N`
 * @returns whether this call registered it; `false` when it already was, or it is no slot of a
 *   built-in provider
 */
export function registerAccountProvider(runtime: AccountRuntime, providerId: string): boolean {
  const slot = parseAccountProviderId(providerId)
  if (slot === undefined || runtime.getRegisteredNativeProvider(providerId) !== undefined) {
    return false
  }
  const fresh = builtinProviders().find((provider) => provider.id === slot.base)
  if (fresh === undefined) {
    if (providerId === legacyAccountProviderId(slot.base, slot.number)) {
      accountsLogger.warn('{provider} is no login slot of a built-in pi provider; not registered', {
        provider: providerId
      })
    }
    return false
  }
  runtime.registerNativeProvider(accountProvider(fresh, { providerId, number: slot.number }))
  accountsLogger.info('Registered {provider} as a login of {base}', {
    provider: providerId,
    base: slot.base
  })
  recordConsoleEvent(`Registered ${providerId} as a login of ${slot.base}`)
  return true
}

/**
 * Drops an account slot's provider, if it is one and is registered.
 *
 * @param runtime - pi's model runtime
 * @param providerId - the slot, `{base}-N`
 */
export function unregisterAccountProvider(runtime: AccountRuntime, providerId: string): void {
  if (parseAccountProviderId(providerId) === undefined) return
  if (runtime.getRegisteredNativeProvider(providerId) === undefined) return
  runtime.unregisterProvider(providerId)
  // No console event: the console's logout says "Logged out of …" itself, and a login that failed
  // drops its slot here too, where "logged out" would not be true (#266).
  accountsLogger.info('Dropped {provider}: logged out', { provider: providerId })
}

/** A provider's login slot. */
export interface AccountSlot {
  /** `{base}-N`, or `{base}-account-N` for a login pi-rotator or pi-multi-account made. */
  readonly providerId: string
  /** N, from 2. */
  readonly number: number
}

/**
 * Returns a provider's lowest login number that is not registered under either ID form.
 *
 * @param runtime - pi's model runtime
 * @param base - the base provider
 * @returns the slot, for the lowest free N from 2, under the proxy's own ID form
 */
export function nextAccountSlot(runtime: AccountRuntime, base: string): AccountSlot {
  let number = FIRST_EXTRA_ACCOUNT
  const taken = (id: string): boolean => runtime.getRegisteredNativeProvider(id) !== undefined
  while (taken(accountProviderId(base, number)) || taken(legacyAccountProviderId(base, number))) {
    number += 1
  }
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
 * What {@link registerStoredAccounts} did: the providers it registered, or that the store could not
 * be listed, which is not the same as having no `{provider}-N` credential.
 *
 * `reason` is the error's code or name (`EACCES`, `TimeoutError`), never its message, which can
 * quote a path; the full message is in the log.
 */
export type StoredAccountsResult =
  | { readonly listed: true; readonly accounts: readonly string[] }
  | { readonly listed: false; readonly reason: string }

/**
 * Registers a provider for every account slot pi has a credential for.
 *
 * @remarks
 * Runs at startup, so a login made in an earlier run, or through pi-rotator or pi-multi-account,
 * is served again. A credential whose base is no built-in provider is left as it is, with a
 * warning. A store that cannot be listed (unreadable, or not within `signal`) registers nothing,
 * is logged as a warning and is reported as `listed: false`, so the caller can tell it from a store
 * with no slot credentials: the proxy starts with pi's base providers, as it did before slots
 * existed, rather than not at all.
 *
 * @param runtime - pi's model runtime
 * @param signal - bounds the credential listing
 * @returns the registered provider IDs, or `listed: false` with the failure's code or name
 */
export async function registerStoredAccounts(
  runtime: AccountRuntime,
  signal: AbortSignal
): Promise<StoredAccountsResult> {
  let stored: readonly { readonly providerId: string }[]
  try {
    stored = await runtime.listCredentials({ signal })
  } catch (error) {
    accountsLogger.warn(
      'Could not list the stored credentials; extra logins are not registered: {reason}',
      { reason: errorMessage(error) }
    )
    return { listed: false, reason: errorCode(error) }
  }
  return {
    listed: true,
    accounts: stored
      .map(({ providerId }) => providerId)
      .filter((providerId) => registerAccountProvider(runtime, providerId))
  }
}
