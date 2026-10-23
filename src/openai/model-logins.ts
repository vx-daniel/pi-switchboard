/**
 * One exposed model, several logins (#227): a `{provider}-N` login's models are the base
 * provider's models under another credential, so they are not exposed as models of their own.
 * The base's model stands for all of them, and routing picks the login.
 *
 * @remarks
 * `groupLogins` runs on pi's available models before exposure filters them: in `scoped` mode the
 * operator's `enabledModels` patterns name the base provider, and a login's models are matched
 * through it. A login whose base is not available (logged out of `anthropic`, still logged in to
 * `anthropic-2`) stands in for it, under the base's name.
 *
 * @packageDocumentation
 */

import type { Api, Model } from '@earendil-works/pi-ai'
import { isBuiltinProvider, parseAccountProviderId } from '@proxy/pi/accounts'

/** The models that may serve one exposed model: the base login's first, then each slot's. */
export interface LoginGroup {
  /** The model exposure sees: the base login's, or the first slot's under the base's provider. */
  readonly primary: Model<Api>
  /** The models to call, one per login, in login order. */
  readonly logins: readonly Model<Api>[]
}

/**
 * Returns the base provider a model belongs to: its own, or the base of its login slot.
 *
 * @param model - the model
 * @returns the base provider ID, and the slot number (1 for the base itself)
 */
function loginOf(model: Model<Api>): { readonly base: string; readonly number: number } {
  const slot = parseAccountProviderId(model.provider)
  return slot !== undefined && isBuiltinProvider(slot.base)
    ? slot
    : { base: model.provider, number: 1 }
}

/**
 * Groups pi's available models by exposed model: each base provider's model with the same
 * model under its login slots.
 *
 * @param available - pi's available models, in pi's order
 * @returns one group per exposed model, in the order the first of its logins appears
 */
export function groupLogins(available: readonly Model<Api>[]): LoginGroup[] {
  const groups = new Map<
    string,
    { base: string; logins: { model: Model<Api>; number: number }[] }
  >()
  for (const model of available) {
    const { base, number } = loginOf(model)
    const key = `${base}/${model.id}`
    const group = groups.get(key) ?? { base, logins: [] }
    group.logins.push({ model, number })
    groups.set(key, group)
  }
  return [...groups.values()].map(({ base, logins }) => {
    // A number can exist in both ID forms (`anthropic-2` and `anthropic-account-2`): both serve,
    // in ID order, so the order does not depend on pi's.
    const ordered = logins.toSorted(
      (first, second) =>
        first.number - second.number || first.model.provider.localeCompare(second.model.provider)
    )
    const [first] = ordered
    if (first === undefined) throw new Error('A login group has at least one model')
    return {
      primary: first.model.provider === base ? first.model : { ...first.model, provider: base },
      logins: ordered.map((login) => login.model)
    }
  })
}
