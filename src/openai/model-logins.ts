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
 * The operator orders a provider's logins and disables some (`routing.logins.order` and
 * `routing.logins.disabled`, #233): listed logins come first, in their order, then the others in
 * the usual order (the base, then `-2`, `-3` by number). A disabled login keeps its credential but
 * is never called; a model whose every login is disabled is left out, as if it had no credential.
 * A name that is no login of its provider is ignored and reported ({@link loginDiagnostics}).
 *
 * @packageDocumentation
 */

import type { Api, Model } from '@earendil-works/pi-ai'
import { proxyLogger } from '@proxy/logging'
import { isBuiltinProvider, parseAccountProviderId } from '@proxy/pi/accounts'
import * as z from 'zod'

/** Logger for model exposure, which login routing is part of. */
const exposureLogger = proxyLogger('openai', 'exposure')

/** How the operator routes a provider's logins (`routing.logins.order` and `.disabled`, #233). */
export interface LoginRouting {
  /** Base provider -> its logins to try first, in order. */
  readonly order: Readonly<Record<string, readonly string[]>>
  /** Logins routing never calls. */
  readonly disabled: readonly string[]
}

/** No order and nothing disabled: the logins in the usual order. */
export const DEFAULT_LOGIN_ROUTING: LoginRouting = { order: {}, disabled: [] }

/** The models that may serve one exposed model: in routing order, and the disabled ones. */
export interface LoginGroup {
  /** The model exposure sees: the base login's, or the first login's under the base's provider. */
  readonly primary: Model<Api>
  /** The models to call, one per enabled login, in routing order; never empty. */
  readonly logins: readonly Model<Api>[]
  /** The same model under each disabled login, in routing order (#233). */
  readonly disabled: readonly Model<Api>[]
}

/**
 * Returns the base provider a login belongs to.
 *
 * @param login - the login's provider ID
 * @returns the base provider ID, and the login's number (1 for the base itself)
 */
export function loginBase(login: string): { readonly base: string; readonly number: number } {
  const slot = parseAccountProviderId(login)
  return slot !== undefined && isBuiltinProvider(slot.base) ? slot : { base: login, number: 1 }
}

/**
 * Orders a provider's logins as routing tries them: the configured ones first, in their order,
 * then the others by number (both ID forms of one number, `anthropic-2` and
 * `anthropic-account-2`, by ID), so the order does not depend on pi's.
 *
 * @param base - the base provider
 * @param logins - its logins
 * @param order - `routing.logins.order`
 * @returns the logins, ordered
 */
export function orderLogins(
  base: string,
  logins: readonly string[],
  order: LoginRouting['order']
): string[] {
  const listed = order[base] ?? []
  const place = (login: string): number => {
    const index = listed.indexOf(login)
    return index === -1 ? listed.length : index
  }
  return logins.toSorted(
    (first, second) =>
      place(first) - place(second) ||
      loginBase(first).number - loginBase(second).number ||
      first.localeCompare(second)
  )
}

/**
 * Groups pi's available models by exposed model: each base provider's model with the same
 * model under its other logins, in routing order, without the disabled ones.
 *
 * @param available - pi's available models, in pi's order
 * @param routing - the configured order and disabled logins
 * @returns one group per exposed model with an enabled login, in the order the first of its
 *   logins appears
 */
export function groupLogins(
  available: readonly Model<Api>[],
  routing: LoginRouting = DEFAULT_LOGIN_ROUTING
): LoginGroup[] {
  const groups = new Map<string, { base: string; models: Map<string, Model<Api>> }>()
  for (const model of available) {
    const { base } = loginBase(model.provider)
    const key = `${base}/${model.id}`
    const group = groups.get(key) ?? { base, models: new Map<string, Model<Api>>() }
    group.models.set(model.provider, model)
    groups.set(key, group)
  }
  const disabled = new Set(routing.disabled)
  return [...groups.values()].flatMap(({ base, models }) => {
    const ordered = orderLogins(base, [...models.keys()], routing.order).flatMap((login) => {
      const model = models.get(login)
      return model === undefined ? [] : [model]
    })
    const logins = ordered.filter((model) => !disabled.has(model.provider))
    const [first] = logins
    if (first === undefined) return []
    // A model the base doesn't serve stands in under the base's name. This object only feeds
    // exposure (filtering and public IDs): every call goes through `logins`, the real models.
    const own = logins.find((model) => model.provider === base)
    return [
      {
        primary: own ?? { ...first, provider: base },
        logins,
        disabled: ordered.filter((model) => disabled.has(model.provider))
      }
    ]
  })
}

/**
 * A login setting that does not do what it says (#233). `/healthz/models` lists these; the schema
 * documents that response and is never parsed.
 */
export const loginDiagnosticSchema = z.object({
  code: z.enum(['unknown-login', 'all-logins-disabled']),
  setting: z.enum(['routing.logins.order', 'routing.logins.disabled']),
  provider: z
    .string()
    .trim()
    .nullable()
    .meta({
      description:
        'The base provider: the `routing.logins.order` key, or the provider whose every login is ' +
        'disabled; null for an unknown name in `routing.logins.disabled`.'
    }),
  login: z.string().trim().nullable().meta({
    description: 'The name as written; null for `all-logins-disabled`.'
  }),
  message: z.string().trim()
})

/** A login setting that does not do what it says. */
export type LoginDiagnostic = z.infer<typeof loginDiagnosticSchema>

/** The unknown names the last warning listed: exposure is computed per request. */
let lastWarned = '[]'

/**
 * Warns about the names `routing.logins` lists that are no login, once per distinct set.
 *
 * @param diagnostics - this computation's login diagnostics
 */
function warnUnknownLogins(diagnostics: readonly LoginDiagnostic[]): void {
  const named = diagnostics
    .filter((diagnostic) => diagnostic.code === 'unknown-login')
    .map((diagnostic) => `${diagnostic.setting}: ${diagnostic.login ?? ''}`)
  const key = JSON.stringify(named)
  // A set that clears and comes back is warned again.
  if (key === lastWarned) return
  lastWarned = key
  if (named.length === 0) return
  exposureLogger.warn('Ignoring names in routing.logins that are no login: {logins}', {
    loginCount: named.length,
    logins: named
  })
}

/**
 * Checks `routing.logins` against the logins pi has: a name that is no login of its provider,
 * and a provider whose every login is disabled (its models leave `/v1/models`). Warns about the
 * unknown names once per distinct set.
 *
 * @param available - pi's available models: every login with a credential has some
 * @param routing - the configured order and disabled logins
 * @returns the diagnostics: unknown names in config order, then the all-disabled providers
 */
export function loginDiagnostics(
  available: readonly Model<Api>[],
  routing: LoginRouting
): LoginDiagnostic[] {
  const loginsOf = new Map<string, Set<string>>()
  for (const { provider } of available) {
    const { base } = loginBase(provider)
    loginsOf.set(base, (loginsOf.get(base) ?? new Set()).add(provider))
  }
  const diagnostics: LoginDiagnostic[] = []
  for (const [provider, listed] of Object.entries(routing.order)) {
    for (const login of listed.filter((named) => loginsOf.get(provider)?.has(named) !== true)) {
      diagnostics.push({
        code: 'unknown-login',
        setting: 'routing.logins.order',
        provider,
        login,
        message: `"${login}" is no login of ${provider}; it is ignored.`
      })
    }
  }
  const known = new Set(available.map((model) => model.provider))
  for (const login of routing.disabled.filter((named) => !known.has(named))) {
    diagnostics.push({
      code: 'unknown-login',
      setting: 'routing.logins.disabled',
      provider: null,
      login,
      message: `"${login}" is no login; it is ignored.`
    })
  }
  const disabled = new Set(routing.disabled)
  for (const [provider, logins] of loginsOf) {
    if (![...logins].every((login) => disabled.has(login))) continue
    diagnostics.push({
      code: 'all-logins-disabled',
      setting: 'routing.logins.disabled',
      provider,
      login: null,
      message: `Every login of ${provider} is disabled, so its models are not listed or served.`
    })
  }
  warnUnknownLogins(diagnostics)
  return diagnostics
}
