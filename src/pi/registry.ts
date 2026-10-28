/**
 * Pi ModelRuntime and SettingsManager integration.
 *
 * @remarks
 * Initializes pi's model runtime (file-based auth and models.json storage), reads the global
 * `enabledModels` setting from pi's SettingsManager, and exposes lookup functions used by the
 * proxy routes. pi's async `ModelRuntime` (pi 1.x) owns credentials, catalogs and request
 * authentication in one place.
 *
 * @packageDocumentation
 */

import type { Api, Model } from '@earendil-works/pi-ai'
import { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent'
import { proxyLogger } from '@proxy/logging'
import { registerStoredAccounts } from '@proxy/pi/accounts'
import { errorMessage } from '@proxy/utils/guards'
import * as z from 'zod'

/** Logger for runtime setup and credential lookups. */
const registryLogger = proxyLogger('pi', 'registry')

/** pi's model runtime; set by {@link initRegistry}. */
let runtime: ModelRuntime | undefined
/** pi's settings manager for the process's working directory; set by {@link initRegistry}. */
let settingsManager: SettingsManager | undefined
/**
 * Why `{provider}-N` logins were not registered at startup, or `undefined` when they were (or
 * there were none); set by {@link initRegistry}.
 */
let loginListingFailure: string | undefined

/**
 * Outcome of resolving request auth for a model: usable, or why not. `error` is already
 * summarized (`summarizeAuthError`), so a route may put it in a response.
 */
export type RequestAuthResult = { ok: true } | { ok: false; error: string }

/** pi appends the file's path to every models.json error after this separator. */
const MODELS_JSON_FILE_SEPARATOR = '\n\nFile: '
/** The start of pi's message for a models.json that is not valid JSON. */
const MODELS_JSON_PARSE_PREFIX = 'Failed to parse models.json:'
/** Where some engines' JSON.parse messages put the fault: `(line N column M)`. */
const JSON_ERROR_LINE_COLUMN = /\(line (\d+) column (\d+)\)/
/** Where other JSON.parse messages put the fault: `position N`. */
const JSON_ERROR_OFFSET = /position (\d+)/
/**
 * JavaScriptCore's JSON.parse messages (the Bun binary) that quote nothing from the file, captured
 * from Bun 1.4.4. JavaScriptCore gives no location, so this phrase is all there is to keep.
 *
 * @remarks
 * An allowlist, not a denylist: other JavaScriptCore messages quote the file (`Unexpected
 * identifier "notarealsec"`, `Invalid escape character q`, `"\uZZZZ" is not a valid unicode
 * escape`, `Unrecognized token '#'`). `Unexpected token` is kept only for JSON's own punctuation.
 */
const JSON_ERROR_JSC_REASON =
  /^JSON Parse error: (Unexpected EOF|Expected '[}\]]'|Expected ':' before value in object property definition|Unterminated string|Unexpected comma at the end of array expression|Property name must be a string literal|Unable to parse JSON string|Single quotes \('\) are not allowed in JSON|Invalid number|Invalid digits after decimal point|\\u must be followed by 4 hex digits|Unexpected token '[{}[\]:,]')$/

/**
 * Splits pi's models.json error into its message and the file's path.
 *
 * @remarks
 * The last separator is the one pi appended: a parse snippet before it is file content and could,
 * in principle, contain the same text.
 *
 * @param error - pi's models.json error
 * @returns the message, and the path or `undefined` when the error carries none
 */
function splitModelsJsonError(error: string): { detail: string; path: string | undefined } {
  const separator = error.lastIndexOf(MODELS_JSON_FILE_SEPARATOR)
  return separator === -1
    ? { detail: error, path: undefined }
    : {
        detail: error.slice(0, separator),
        path: error.slice(separator + MODELS_JSON_FILE_SEPARATOR.length)
      }
}

/**
 * Reduces pi's models.json error to what cannot quote the file.
 *
 * @remarks
 * JSON.parse messages can include a slice of the text around the fault (`Unexpected token 'o',
 * ..."apiKey": notarealsec"... is not valid JSON`), which is often a key, so a parse error keeps
 * only where it is (V8) or, when the engine gives no location (JavaScriptCore, the Bun binary),
 * its reason if that is one known to quote nothing ({@link JSON_ERROR_JSC_REASON}). Load errors
 * (the fs message) and schema errors (property paths, which name the user's providers and models,
 * and TypeBox's fixed messages) quote no values and pass through. The file's path is dropped;
 * callers that log it take it separately.
 *
 * @param error - pi's models.json error, as `ModelRuntime.getError()` returns it
 * @returns the reduced message
 */
export function describeModelsJsonError(error: string): string {
  const { detail } = splitModelsJsonError(error)
  if (!detail.startsWith(MODELS_JSON_PARSE_PREFIX)) return detail
  const lineColumn = JSON_ERROR_LINE_COLUMN.exec(detail)
  if (lineColumn !== null) {
    return `models.json is not valid JSON at line ${String(lineColumn[1])} column ${String(lineColumn[2])}`
  }
  const offset = JSON_ERROR_OFFSET.exec(detail)
  if (offset !== null) return `models.json is not valid JSON at position ${String(offset[1])}`
  const reason = JSON_ERROR_JSC_REASON.exec(detail.slice(MODELS_JSON_PARSE_PREFIX.length).trim())
  return reason === null
    ? 'models.json is not valid JSON'
    : `models.json is not valid JSON: ${String(reason[1])}`
}

/** How long listing pi's stored credentials at startup may take. */
const CREDENTIAL_LIST_TIMEOUT_MS = 15_000

/**
 * Initializes the runtime and settings. Call once at startup.
 *
 * @remarks
 * Every `{provider}-N` credential in pi's store gets its provider registered (#227) before
 * the availability snapshot is taken. A store that cannot be listed is not retried; see
 * {@link getLoginRegistration}.
 *
 * @returns the models.json error ({@link describeModelsJsonError}), or `undefined` on success
 */
export async function initRegistry(): Promise<string | undefined> {
  const cwd = process.cwd()
  runtime = await ModelRuntime.create()
  settingsManager = SettingsManager.create(cwd)
  const rawError = runtime.getError()
  const loadError = rawError === undefined ? undefined : describeModelsJsonError(rawError)
  if (rawError !== undefined) {
    registryLogger.warn('models.json failed to load; using built-in models only: {error}', {
      error: loadError,
      path: splitModelsJsonError(rawError).path
    })
  }
  const stored = await registerStoredAccounts(
    runtime,
    AbortSignal.timeout(CREDENTIAL_LIST_TIMEOUT_MS)
  )
  // Nothing re-runs the listing after startup, so a failed one stands until restart;
  // `/healthz/creds` says so rather than reading as "no logins".
  loginListingFailure = stored.listed ? undefined : stored.reason
  if (stored.listed && stored.accounts.length > 0) {
    // A registered provider is only provisionally available until the next availability pass;
    // this one settles it, from the stored credentials alone, before the snapshot is read. Should
    // it fail, the proxy starts anyway: the provisional entries stand until the next pass.
    try {
      await runtime.refresh({ allowNetwork: false })
    } catch (error) {
      registryLogger.warn('Refreshing availability after registering logins failed: {reason}', {
        reason: errorMessage(error)
      })
    }
  }
  registryLogger.info('Model runtime ready with {availableModelCount} available models', {
    availableModelCount: runtime.getAvailableSnapshot().length,
    settingsCwd: cwd,
    modelsJsonLoaded: loadError === undefined
  })
  return loadError
}

/**
 * Whether the startup registration of `{provider}-N` logins ran: `registered: false` with the
 * failure's code or name (never its message, which can quote a path).
 */
export type LoginRegistration = { registered: true } | { registered: false; reason: string }

/**
 * Says whether the startup registration of `{provider}-N` logins was skipped because pi's
 * credential store could not be listed.
 *
 * @remarks
 * Not the same as having no such login. The listing is not retried, so a failure stands until the
 * proxy restarts.
 *
 * @returns `registered: true`, or `registered: false` with the failure's code or name
 */
export function getLoginRegistration(): LoginRegistration {
  return loginListingFailure === undefined
    ? { registered: true }
    : { registered: false, reason: loginListingFailure }
}

/**
 * Returns the initialized model runtime, which also runs completions (see `src/pi/complete.ts`).
 *
 * @returns the runtime
 * @throws Error when {@link initRegistry} has not run
 */
export function getRuntime(): ModelRuntime {
  if (runtime === undefined) {
    throw new Error('ModelRuntime not initialized. Call initRegistry() first.')
  }
  return runtime
}

/**
 * Returns the initialized settings manager.
 *
 * @returns the settings manager
 * @throws Error when {@link initRegistry} has not run
 */
function getSettingsManager(): SettingsManager {
  if (settingsManager === undefined) {
    throw new Error('SettingsManager not initialized. Call initRegistry() first.')
  }
  return settingsManager
}

/**
 * Returns this installation's device ID, created on first use and kept in pi's settings, as pi's
 * own `/login` does. Sign in with ChatGPT refuses to start without one.
 *
 * @returns the device ID (a UUID)
 * @throws Error when {@link initRegistry} has not run
 */
export function getLoginDeviceId(): string {
  return getSettingsManager().getOrCreateDeviceId()
}

/**
 * Returns every model available (with auth configured).
 *
 * @remarks
 * Reads the runtime's availability snapshot. pi updates it when this process logs in or out
 * (`ModelRuntime.login`, `logout`) or refreshes availability; a credential another process adds,
 * such as pi's own `/login`, appears after a restart. Listing stays synchronous and cheap, as pi
 * 0.x's synchronous `getAvailable()` was.
 *
 * @returns a copy of the available models
 * @throws Error when {@link initRegistry} has not run
 */
export function getAvailableModels(): Model<Api>[] {
  return [...getRuntime().getAvailableSnapshot()]
}

/** Longest credential error line logged at debug. */
const MAX_AUTH_ERROR_LENGTH = 500
/** Longest summary an HTTP response carries, before the status suffix. */
const MAX_AUTH_SUMMARY_LENGTH = 200

/**
 * Pi's credential errors run `<summary>. url=…; body=…; details=…; stack=…`: the body and details
 * quote the token endpoint's response, and the stack names files of the install. The HTTP response
 * gets the summary up to the first of those fields, or the first JSON or array literal for an
 * error worded some other way, plus the upstream status when there is one.
 */
const AUTH_ERROR_DETAIL = /[;\s](?:body|details|stack|response)=|[{[\n]/
/** The upstream HTTP status in a credential error: `status=NNN`. */
const AUTH_ERROR_STATUS = /\bstatus=(\d{3})\b/

/**
 * Returns the first line of a message, capped for the debug log.
 *
 * @param message - the error message
 * @returns its first line, at most {@link MAX_AUTH_ERROR_LENGTH} characters
 */
function firstLine(message: string): string {
  const [line = message] = message.split('\n')
  return line.slice(0, MAX_AUTH_ERROR_LENGTH)
}

/**
 * Reduces a credential error to what an HTTP response may carry: no upstream body, no stack.
 *
 * @param message - pi's credential error message
 * @returns the summary (at most {@link MAX_AUTH_SUMMARY_LENGTH} characters), plus ` (HTTP NNN)`
 *   when the message names an upstream status
 */
export function summarizeAuthError(message: string): string {
  const [summary = message] = message.split(AUTH_ERROR_DETAIL)
  const trimmed = summary
    .trim()
    .replace(/[;:,]$/, '')
    .slice(0, MAX_AUTH_SUMMARY_LENGTH)
  const status = AUTH_ERROR_STATUS.exec(message)?.[1]
  return status === undefined ? trimmed : `${trimmed} (HTTP ${status})`
}

/** Which credential lookup failed: one for a model's chat request, or a provider's health check. */
interface AuthFailureSource {
  readonly action: 'resolution' | 'verification'
  readonly provider: string
  readonly modelId?: string
}

/**
 * Logs a credential failure and returns what an HTTP response may carry.
 *
 * @remarks
 * The warning names the provider (and model, for a chat request) and the summary; the raw first
 * line, which can quote the token endpoint's response, goes to debug only, like other upstream
 * error text. pi's stack trace goes nowhere.
 *
 * @param source - which lookup failed, for which provider and model
 * @param error - what the lookup threw
 * @returns the summary ({@link summarizeAuthError})
 */
function reportAuthFailure(source: AuthFailureSource, error: unknown): string {
  const message = errorMessage(error)
  const summary = summarizeAuthError(message)
  registryLogger.warn('Credential {action} failed for provider {provider}: {reason}', {
    ...source,
    reason: summary,
    credentialsResolved: false
  })
  registryLogger.debug('Credential {action} error for {provider}: {error}', {
    ...source,
    error: firstLine(message.split('; stack=')[0] ?? message)
  })
  return summary
}

/**
 * Checks that pi can authenticate a request to this model right now.
 *
 * @remarks
 * Completions resolve their own auth through the runtime (API keys, OAuth with refresh,
 * model-specific headers, dynamic models.json headers); this exists so a route can answer 401
 * before starting a response, instead of failing mid-stream with a less actionable error.
 *
 * @param model - the pi model the request is for
 * @returns `{ ok: true }`, or `{ ok: false, error }` with a summary safe for a response
 * @throws Error when {@link initRegistry} has not run
 */
export async function getRequestAuth(model: Model<Api>): Promise<RequestAuthResult> {
  const { provider, id: modelId } = model
  try {
    const credentials = await getRuntime().getAuth(model)
    if (credentials === undefined) {
      registryLogger.debug('No credentials configured for provider {provider}', {
        provider,
        modelId,
        credentialsResolved: false
      })
      return { ok: false, error: `no credentials configured for provider '${model.provider}'` }
    }
    registryLogger.debug('Credentials resolved for provider {provider}', {
      provider,
      modelId,
      credentialsResolved: true
    })
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      error: reportAuthFailure({ action: 'resolution', provider, modelId }, error)
    }
  }
}

/**
 * Reads the `enabledModels` patterns from pi's global settings, reloading them first.
 *
 * @remarks
 * Usually canonical model IDs (e.g. "anthropic/claude-sonnet-4-6") saved by pi's `/scoped-models`
 * selector (Ctrl+S by default).
 *
 * @returns the patterns, or `undefined` when no filter is configured (all models enabled)
 * @throws Error when {@link initRegistry} has not run
 */
export async function getEnabledModels(): Promise<readonly string[] | undefined> {
  const manager = getSettingsManager()
  await manager.reload()
  const enabledModels = manager.getEnabledModels()
  registryLogger.debug('Read enabledModels from pi settings: {enabledModelCount} patterns', {
    enabledModelCount: enabledModels?.length ?? 0,
    filterConfigured: enabledModels !== undefined && enabledModels.length > 0
  })
  return enabledModels
}

/**
 * Returns why models.json failed to load.
 *
 * @remarks
 * Reduced by {@link describeModelsJsonError}, so a response or a log line may carry it.
 *
 * @returns the reduced error, or `undefined` when it loaded (or there is none)
 */
export function getModelsJsonError(): string | undefined {
  const error = getRuntime().getError()
  return error === undefined ? undefined : describeModelsJsonError(error)
}

/**
 * How one provider is authenticated, for the health endpoint. Never the credential itself. The
 * schema documents `/healthz/creds` and is never parsed.
 */
export const providerCredentialStatusSchema = z.object({
  provider: z.string().trim(),
  type: z
    .enum(['oauth', 'api_key'])
    .meta({ description: '`oauth` for a subscription login, `api_key` otherwise.' }),
  source: z.string().trim().optional().meta({
    description: 'Where pi found the credential: `stored`, `environment`, `models_json_key`, …'
  }),
  availableModelCount: z.int(),
  verified: z
    .boolean()
    .optional()
    .meta({
      description:
        'Only with `?verify=true`: whether pi resolved a usable credential just now, which may ' +
        'refresh an OAuth token over the network. `error` says why not.'
    }),
  error: z.string().trim().optional()
})

/** How one provider is authenticated, for the health endpoint. Never the credential itself. */
export type ProviderCredentialStatus = z.infer<typeof providerCredentialStatusSchema>

/**
 * Resolves one provider's credential now, which may refresh an OAuth token over the network.
 *
 * @param provider - the provider ID
 * @returns `verified: true`, or `verified: false` with a summary of why
 */
async function verifyProvider(
  provider: string
): Promise<Pick<ProviderCredentialStatus, 'verified' | 'error'>> {
  try {
    const resolved = await getRuntime().getAuth(provider)
    return resolved === undefined
      ? { verified: false, error: 'no credentials configured' }
      : { verified: true }
  } catch (error) {
    return {
      verified: false,
      error: reportAuthFailure({ action: 'verification', provider }, error)
    }
  }
}

/**
 * Lists every provider pi has a credential for, with how it is configured and how many of its
 * models are available.
 *
 * @param verify - whether to resolve each credential now (which may refresh an OAuth token over
 *   the network); `false` reads local state only
 * @returns one status per configured provider; never the credential itself
 */
export async function getCredentialStatuses(verify: boolean): Promise<ProviderCredentialStatus[]> {
  const modelRuntime = getRuntime()
  const availableByProvider = new Map<string, number>()
  for (const model of modelRuntime.getAvailableSnapshot()) {
    availableByProvider.set(model.provider, (availableByProvider.get(model.provider) ?? 0) + 1)
  }
  const configured = modelRuntime
    .getProviders()
    .filter((provider) => modelRuntime.hasConfiguredAuth(provider.id))
  const statuses = await Promise.all(
    configured.map(async ({ id }): Promise<ProviderCredentialStatus> => {
      const base: ProviderCredentialStatus = {
        provider: id,
        type: modelRuntime.isUsingOAuth(id) ? 'oauth' : 'api_key',
        source: modelRuntime.getProviderAuthStatus(id).source,
        availableModelCount: availableByProvider.get(id) ?? 0
      }
      return verify ? { ...base, ...(await verifyProvider(id)) } : base
    })
  )
  registryLogger.debug('Credential status for {providerCount} providers', {
    providerCount: statuses.length,
    verify
  })
  return statuses
}
