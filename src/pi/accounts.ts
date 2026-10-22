/**
 * Several logins per provider (#227): `{provider}-account-N` providers, each a copy of one of pi's
 * built-in providers under its own ID.
 *
 * @remarks
 * pi stores one credential per provider ID. A second login to the same service therefore needs a
 * second provider: `accounts: { "anthropic": 2 }` in the config registers `anthropic-account-2`,
 * which pi logs into (the console's login screen lists it) and whose credential pi stores under
 * that ID. Cooldowns, quota, the reserve, `x_pi` and the log are all keyed by provider, so each
 * login gets them separately; a fallback chain (#67) from `anthropic/X` to `anthropic-account-2/X`
 * moves to the second login on a rate limit.
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
import type { Accounts } from '@proxy/config/schema'
import { proxyLogger } from '@proxy/logging'

/** Logger for account registration. */
const accountsLogger = proxyLogger('pi', 'registry')

/** The first extra login's number; number 1 is the base provider itself. */
const FIRST_EXTRA_ACCOUNT = 2

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
 * Registers the configured extra logins as providers of the runtime.
 *
 * @remarks
 * A base that is not one of pi's built-in providers is skipped with a warning: a `models.json`
 * provider is composed, not built in, and its key would be copied with it.
 *
 * @param runtime - pi's model runtime
 * @param accounts - provider -> how many logins it has, the base one included
 * @returns the registered provider IDs
 */
export function registerAccounts(
  runtime: Pick<ModelRuntime, 'registerNativeProvider'>,
  accounts: Accounts
): string[] {
  const registered: string[] = []
  for (const [base, logins] of Object.entries(accounts)) {
    for (let number = FIRST_EXTRA_ACCOUNT; number <= logins; number += 1) {
      const fresh = builtinProviders().find((provider) => provider.id === base)
      if (fresh === undefined) {
        accountsLogger.warn(
          'accounts.{base} names no built-in pi provider; its extra logins are not registered',
          { base }
        )
        break
      }
      const copy = accountProvider(fresh, number)
      runtime.registerNativeProvider(copy)
      registered.push(copy.id)
    }
  }
  if (registered.length > 0) {
    accountsLogger.info('Registered {count} extra login(s): {providers}', {
      count: registered.length,
      providers: registered
    })
  }
  return registered
}
