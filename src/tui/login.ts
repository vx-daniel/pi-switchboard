/**
 * Logins in the console (#61): pi's own login flow (`ModelRuntime.login`), shown on pi's own
 * screens. pi runs every flow and stores every credential; this module only routes pi's prompts and
 * events to the screens (constitution, Scope and principle III: a local terminal, never HTTP).
 *
 * @remarks
 * pi keeps the same routing private inside its interactive mode, so it is repeated here: which
 * providers offer which login, a choice to a selector, a pasted code or a typed answer to the login
 * dialog, and each event to the dialog's matching view. After a login, the provider's model list
 * is refreshed, as pi does, so a provider whose catalog needs the new credential lists its models.
 *
 * @packageDocumentation
 */

import type { AuthEvent, AuthPrompt, AuthType, Provider } from '@earendil-works/pi-ai'
import type {
  LoginDialogComponent,
  ModelRuntime,
  OAuthSelectorComponent
} from '@earendil-works/pi-coding-agent'
import { loadConfigFromFile, type LoginLabels, saveConfigToFile } from '@proxy/config/schema'
import { proxyLogger } from '@proxy/logging'
import {
  isBuiltinProvider,
  nextAccountSlot,
  parseAccountProviderId,
  registerAccountProvider,
  unregisterAccountProvider
} from '@proxy/pi/accounts'

/** One entry of pi's login provider selector. */
export type LoginOption = ConstructorParameters<typeof OAuthSelectorComponent>[1][number]

/** A choice pi asks for during a login, such as the login method. */
type SelectPrompt = Extract<AuthPrompt, { type: 'select' }>

/**
 * The screens a login runs on: pi's login dialog, plus a selector for pi's choices.
 *
 * @remarks
 * `dialog` is pi's own `LoginDialogComponent`; `select` shows pi's selector and resolves with the
 * chosen option's ID, or rejects when it is cancelled.
 */
export interface LoginScreens {
  readonly dialog: Pick<
    LoginDialogComponent,
    | 'signal'
    | 'showAuth'
    | 'showDeviceCode'
    | 'showWaiting'
    | 'showInfo'
    | 'showProgress'
    | 'showPrompt'
    | 'showManualInput'
  >
  select(prompt: SelectPrompt): Promise<string>
}

/** Logger for logins in the console. */
const loginLogger = proxyLogger('tui', 'login')

/** How long the catalog refresh after a login may take. */
const CATALOG_REFRESH_MS = 15_000

/**
 * Returns a provider's display name, or its ID when pi does not know it.
 *
 * @remarks
 * A login slot that is not registered yet (`anthropic-2` before its first login) is named
 * after its base, as it will be once registered.
 *
 * @param runtime - the proxy's model runtime
 * @param providerId - the provider
 * @returns the name
 */
export function providerName(runtime: ModelRuntime, providerId: string): string {
  const known = runtime.getProvider(providerId)?.name
  if (known !== undefined) return known
  const slot = parseAccountProviderId(providerId)
  if (slot === undefined) return providerId
  const base = runtime.getProvider(slot.base)
  return base === undefined ? providerId : accountName(base.name, slot.number)
}

/**
 * Names a provider's Nth login as its copy does.
 *
 * @param baseName - the base provider's display name
 * @param number - the login's number, from 2
 * @returns `{baseName} {number}`
 */
function accountName(baseName: string, number: number): string {
  return `${baseName} ${String(number)}`
}

/**
 * Says how a provider is configured, for pi's selector: `{}` when it is not.
 *
 * @param runtime - the proxy's model runtime
 * @param providerId - the provider
 * @returns the selector's `status` field, or nothing
 */
function configuredStatus(runtime: ModelRuntime, providerId: string): Pick<LoginOption, 'status'> {
  const authStatus = runtime.getProviderAuthStatus(providerId)
  if (!authStatus.configured) return {}
  const type = runtime.isUsingOAuth(providerId) ? 'oauth' : 'api_key'
  return { status: { type, source: authStatus.label ?? authStatus.source ?? 'configured' } }
}

/**
 * Appends a login's label to its name, when it has one.
 *
 * @param name - the provider's display name
 * @param label - the label, if any
 * @returns `name · label`, or the name alone
 */
function labelled(name: string, label: string | undefined): string {
  return label === undefined ? name : `${name} · ${label}`
}

/**
 * Lists the logins pi offers, one entry per provider and login type, as pi's `/login` does.
 *
 * @remarks
 * A provider that is logged in also offers its next login slot (`Anthropic 2`, #227):
 * choosing it registers the slot and runs the same login. A slot already registered is a provider
 * like any other and is listed as itself, with its label when it has one.
 *
 * @param runtime - the proxy's model runtime
 * @param labels - provider -> the label the operator gave it
 * @returns the entries, sorted by provider name
 */
export function loginOptions(runtime: ModelRuntime, labels: LoginLabels = {}): LoginOption[] {
  const options: LoginOption[] = []
  const push = (
    provider: Pick<Provider, 'id' | 'name' | 'auth'>,
    status: Pick<LoginOption, 'status'>
  ): void => {
    const base = { id: provider.id, name: labelled(provider.name, labels[provider.id]), ...status }
    const { oauth, apiKey } = provider.auth
    if (oauth) {
      const subscription = oauth.isSubscription === true
      options.push({ ...base, authType: 'oauth', method: oauth, subscription })
    }
    if (apiKey) options.push({ ...base, authType: 'api_key', method: apiKey })
  }
  for (const provider of runtime.getProviders()) {
    // A `models.json` entry under a slot's ID (a `baseUrl` override prepared for it) is a provider
    // to pi before the slot is registered; the slot is offered once, as its base's next login.
    const slot = parseAccountProviderId(provider.id)
    const unregisteredSlot =
      slot !== undefined &&
      isBuiltinProvider(slot.base) &&
      runtime.getRegisteredNativeProvider(provider.id) === undefined
    if (unregisteredSlot) continue
    const status = configuredStatus(runtime, provider.id)
    push(provider, status)
    const offersSlot =
      status.status !== undefined && isBuiltinProvider(provider.id) && slot === undefined
    if (offersSlot) {
      const next = nextAccountSlot(runtime, provider.id)
      push(
        { id: next.providerId, name: accountName(provider.name, next.number), auth: provider.auth },
        {}
      )
    }
  }
  return options.toSorted((first, second) => first.name.localeCompare(second.name))
}

/**
 * Lists the credentials pi has stored, for logging out. Credentials from the environment or
 * models.json are not stored, so they cannot be logged out of.
 *
 * @param runtime - the proxy's model runtime
 * @param labels - provider -> the label the operator gave it
 * @returns one entry per stored credential
 */
export async function logoutOptions(
  runtime: ModelRuntime,
  labels: LoginLabels = {}
): Promise<LoginOption[]> {
  const stored = await runtime.listCredentials({ signal: AbortSignal.timeout(CATALOG_REFRESH_MS) })
  return stored.map(({ providerId, type }) => ({
    id: providerId,
    name: labelled(providerName(runtime, providerId), labels[providerId]),
    authType: type,
    status: { type, source: 'stored credential' }
  }))
}

/**
 * Reads the labels the operator gave logins, from the config file.
 *
 * @returns provider -> label
 */
export function loginLabels(): LoginLabels {
  return loadConfigFromFile().labels
}

/**
 * Saves a login's label in the config file (`labels`), or removes it.
 *
 * @remarks
 * The label is the operator's description of an account (`work`), kept beside the proxy's own
 * settings, never in pi's credential store and never sent anywhere. A label that is only
 * whitespace removes the entry.
 *
 * @param providerId - the login
 * @param label - the label; empty removes it
 * @returns whether the config file was written
 */
export function saveLoginLabel(providerId: string, label: string): boolean {
  const config = loadConfigFromFile()
  const { [providerId]: _previous, ...others } = config.labels
  const trimmed = label.trim()
  const labels = trimmed.length === 0 ? others : { ...others, [providerId]: trimmed }
  const written = saveConfigToFile({ ...config, labels })
  if (written) {
    loginLogger.info(
      trimmed.length === 0 ? 'Removed the label of {provider}' : 'Labelled {provider}',
      { provider: providerId }
    )
  }
  return written
}

/**
 * Rejects when `signal` aborts, with pi's own cancel message.
 *
 * @param signal - the prompt's signal
 */
function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const cancel = (): void => reject(new Error('Login cancelled'))
    if (signal.aborted) cancel()
    else signal.addEventListener('abort', cancel, { once: true })
  })
}

/**
 * Shows one of pi's login prompts and returns the answer.
 *
 * @param screens - the login's screens
 * @param prompt - what pi asks
 * @returns the answer: the chosen option's ID, the pasted code, or the typed text
 */
async function answer(screens: LoginScreens, prompt: AuthPrompt): Promise<string> {
  let response: Promise<string>
  if (prompt.type === 'select') response = screens.select(prompt)
  else if (prompt.type === 'manual_code') response = screens.dialog.showManualInput(prompt.message)
  else response = screens.dialog.showPrompt(prompt.message, prompt.placeholder)
  return prompt.signal === undefined
    ? response
    : Promise.race([response, rejectOnAbort(prompt.signal)])
}

/**
 * Shows one of pi's login events on the dialog.
 *
 * @param screens - the login's screens
 * @param event - what pi reports
 */
function show({ dialog }: LoginScreens, event: AuthEvent): void {
  switch (event.type) {
    case 'auth_url':
      dialog.showAuth(event.url, event.instructions)
      break
    case 'device_code':
      dialog.showDeviceCode(event)
      dialog.showWaiting('Waiting for authentication...')
      break
    case 'info':
      dialog.showInfo(event.message, event.links)
      break
    case 'progress':
      dialog.showProgress(event.message)
      break
  }
}

/**
 * Runs pi's login for one provider on the given screens, then refreshes its model list.
 *
 * @remarks
 * pi stores the credential in its `auth.json` and updates the runtime the server answers from, so
 * the provider's models are served at once, with no restart. A failed catalog refresh is logged
 * and keeps the cached list, as pi does. A login slot (`anthropic-2`, #227) is registered
 * as a provider first, and dropped again if its login fails or is cancelled.
 *
 * @param runtime - the proxy's model runtime
 * @param login - the provider, the login type, and this installation's device ID
 * @param screens - where pi's prompts and events show; the dialog's `signal` cancels the login
 * @throws Error when the login fails or is cancelled (`Login cancelled`)
 */
export async function runLogin(
  runtime: ModelRuntime,
  login: { readonly providerId: string; readonly type: AuthType; readonly deviceId: () => string },
  screens: LoginScreens
): Promise<void> {
  const { providerId, type, deviceId } = login
  const registered = registerAccountProvider(runtime, providerId)
  try {
    await runtime.login(
      providerId,
      type,
      {
        signal: screens.dialog.signal,
        prompt: (prompt) => answer(screens, prompt),
        notify: (event) => show(screens, event)
      },
      { getDeviceId: deviceId }
    )
  } catch (error) {
    if (registered) unregisterAccountProvider(runtime, providerId)
    throw error
  }
  loginLogger.info('Logged in to {provider} ({type})', { provider: providerId, type })
  const refreshed = await runtime.refresh({
    providers: [providerId],
    signal: AbortSignal.timeout(CATALOG_REFRESH_MS)
  })
  if (refreshed.aborted || refreshed.errors.size > 0) {
    loginLogger.warn(
      'Model catalog for {provider} not refreshed after login; using cached models',
      {
        provider: providerId
      }
    )
  }
}

/**
 * Logs out of one provider: pi removes its stored credential. A login slot (#227) is dropped as a
 * provider too, so its number is free for the next login, and the login's label goes with the
 * credential: the next login under the same ID may be another account.
 *
 * @param runtime - the proxy's model runtime
 * @param providerId - the provider
 * @param signal - bounds pi's logout
 * @throws Error when pi's logout fails
 */
export async function runLogout(
  runtime: ModelRuntime,
  providerId: string,
  signal: AbortSignal
): Promise<void> {
  await runtime.logout(providerId, { signal })
  loginLogger.info('Logged out of {provider}', { provider: providerId })
  unregisterAccountProvider(runtime, providerId)
  if (loginLabels()[providerId] !== undefined) saveLoginLabel(providerId, '')
}
