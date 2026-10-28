/**
 * Ordering and disabling a provider's logins from the console's Accounts view (#233): where each
 * login stands in its provider's routing order, and the `routing.logins.order` and
 * `routing.logins.disabled` writes the account menu's **Use first**, **Disable** and **Enable**
 * make in `proxy-config.json`.
 *
 * @remarks
 * The proxy reads the config file on every request (`fileConfigReader`), so a change is used by
 * the next request without a restart, as an alias edit is. A disabled login keeps its credential
 * in pi's store: nothing here logs out. Each write is logged at info with the login's name.
 *
 * @packageDocumentation
 */

import { loadConfigFromFile, type LoginsConfig, saveConfigToFile } from '@proxy/config/schema'
import { proxyLogger } from '@proxy/logging'
import { loginBase, type LoginRouting, orderLogins } from '@proxy/openai/model-logins'

/** Logger for the console's login routing edits: the config category, as saves to the file are. */
const configLogger = proxyLogger('config')

/** Where a login stands among its provider's logins, in routing order. */
export interface LoginPlace {
  /** The login's place, from 1, among its provider's logins (disabled ones included). */
  readonly position: number
  /** How many logins its provider has. */
  readonly count: number
  /** Whether routing calls it first: the first of its provider's enabled logins. */
  readonly first: boolean
  /** Whether `routing.logins.disabled` names it. */
  readonly disabled: boolean
  /** Whether it is its provider's only enabled login: disabling it withdraws the models. */
  readonly lastEnabled: boolean
}

/**
 * Lists a login's provider's logins, in routing order.
 *
 * @param login - the login
 * @param logins - every login pi has a credential for
 * @param order - `routing.logins.order`
 * @returns its provider's logins in routing order, `login` among them
 */
function providerLogins(
  login: string,
  logins: readonly string[],
  order: LoginRouting['order']
): string[] {
  const { base } = loginBase(login)
  const siblings = logins.filter((other) => loginBase(other).base === base)
  return orderLogins(base, siblings.includes(login) ? siblings : [...siblings, login], order)
}

/**
 * Places every login in its provider's routing order.
 *
 * @param logins - every login pi has a credential for
 * @param routing - the configured order and disabled logins
 * @returns login -> its place
 */
export function loginPlaces(
  logins: readonly string[],
  routing: LoginRouting
): ReadonlyMap<string, LoginPlace> {
  const disabled = new Set(routing.disabled)
  const places = new Map<string, LoginPlace>()
  for (const login of logins) {
    const ordered = providerLogins(login, logins, routing.order)
    const enabled = ordered.filter((other) => !disabled.has(other))
    places.set(login, {
      position: ordered.indexOf(login) + 1,
      count: ordered.length,
      first: enabled[0] === login,
      disabled: disabled.has(login),
      lastEnabled: enabled.length === 1 && enabled[0] === login
    })
  }
  return places
}

/**
 * Writes the config's `routing.logins`, keeping everything else in the file.
 *
 * @param change - rewrites the section, from the file's state now
 * @returns whether the file was written
 */
function writeLogins(change: (logins: LoginsConfig) => LoginsConfig): boolean {
  const config = loadConfigFromFile()
  return saveConfigToFile({
    ...config,
    routing: { ...config.routing, logins: change(config.routing.logins) }
  })
}

/**
 * Puts a login first among its provider's logins (`routing.logins.order`), the others after it in
 * their current order.
 *
 * @param login - the login to call first
 * @param logins - every login pi has a credential for
 * @returns whether the file was written
 */
export function saveLoginFirst(login: string, logins: readonly string[]): boolean {
  const { base } = loginBase(login)
  const written = writeLogins((section) => {
    const ordered = providerLogins(login, logins, section.order)
    const order = [login, ...ordered.filter((other) => other !== login)]
    return { ...section, order: { ...section.order, [base]: order } }
  })
  if (written) {
    configLogger.info('Routing calls {login} first of {provider}', { login, provider: base })
  }
  return written
}

/**
 * Disables a login, so routing never calls it, or enables it again (`routing.logins.disabled`).
 * Its credential stays in pi's store.
 *
 * @param login - the login
 * @param disabled - whether to disable it
 * @returns whether the file was written
 */
export function saveLoginDisabled(login: string, disabled: boolean): boolean {
  const written = writeLogins((section) => {
    const others = section.disabled.filter((other) => other !== login)
    return { ...section, disabled: disabled ? [...others, login] : others }
  })
  if (written) {
    configLogger.info(disabled ? 'Disabled login {login}' : 'Enabled login {login}', { login })
  }
  return written
}
