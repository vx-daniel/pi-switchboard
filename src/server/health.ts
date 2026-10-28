/**
 * Operational health endpoints. They are not part of the OpenAI-compatible surface (`/v1/*`).
 *
 * @remarks
 *   GET /healthz          Liveness. The server starts listening only after pi's model runtime has
 *                         loaded, so any answer means both. No authentication, no body beyond
 *                         `{ "status": "ok" }`, no upstream calls: cheap enough for a container
 *                         healthcheck every few seconds.
 *   GET /healthz/models   The model runtime: models.json load error, available and exposed model
 *                         counts, exposure modes, the exposure error, `enabledModels` scope
 *                         diagnostics and alias diagnostics (#66). 503 when no model is exposed,
 *                         the exposure config is invalid, or an alias is named like an exposed
 *                         model.
 *   GET /healthz/creds    Per provider: how pi is authenticated (OAuth or API key, and where the
 *                         credential came from) and how many of its models are available. Local
 *                         state only; `?verify=true` asks pi to resolve each credential now, which
 *                         may refresh an OAuth token over the network. 503 when no provider has a
 *                         credential, or a verified one fails.
 *
 * A detail check that throws (an unreadable config file, say) answers 503 rather than 500: it is a
 * failed check. Its message goes to the log, not the response.
 *
 * The detail endpoints sit behind proxy authentication when it is on (they name providers and
 * models); `/healthz` never does. None of them returns a credential.
 *
 * @packageDocumentation
 */

import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import { ModelExposureModeSchema, PublicModelIdModeSchema } from '@proxy/config/schema'
import { proxyLogger } from '@proxy/logging'
import {
  aliasDiagnosticSchema,
  familyResolutionSchema,
  MISCONFIGURED_ALIAS
} from '@proxy/openai/model-aliases'
import { computeModelExposure, type ModelExposureConfig } from '@proxy/openai/model-exposure'
import { activeCooldowns } from '@proxy/pi/cooldowns'
import { scopeDiagnosticSchema } from '@proxy/pi/model-scope'
import { providerQuota, type ProviderQuota } from '@proxy/pi/quota'
import {
  getAvailableModels,
  getCredentialStatuses,
  getLoginRegistration,
  getModelsJsonError,
  providerCredentialStatusSchema
} from '@proxy/pi/registry'
import { cooldownView, cooldownViewSchema } from '@proxy/server/cooldowns'
import { HTTP_SERVICE_UNAVAILABLE } from '@proxy/server/http-status'
import {
  credentialsQuerySchema,
  firstQueryValue,
  jsonResponse,
  OPERATIONAL_TAG,
  UNAUTHORIZED
} from '@proxy/server/openapi'
import type { ExposureConfigReader } from '@proxy/server/routes'
import type { ProxyEnv } from '@proxy/server/types'
import { errorMessage } from '@proxy/utils/guards'
import { type Context, Hono } from 'hono'
import { type DescribeRouteOptions, describeRoute, validator } from 'hono-openapi'
import * as z from 'zod'

/** Logger for health check failures. */
const healthLogger = proxyLogger('server', 'health')

/** The Hono context a health handler gets. */
type HealthContext = Context<ProxyEnv>

/** Whether a detail check passed; `unavailable` comes with a 503. */
const checkStatusSchema = z.enum(['ok', 'unavailable'])

/** `GET /healthz`'s body. Documents the response; never parsed. */
const livenessSchema = z.object({ status: z.literal('ok') }).meta({ id: 'Liveness' })

/** `GET /healthz/models`'s body. Documents the response; never parsed. */
const modelsHealthSchema = z
  .object({
    status: checkStatusSchema,
    availableModelCount: z.int(),
    exposedModelCount: z.int(),
    modelExposureMode: ModelExposureModeSchema,
    publicModelIdMode: PublicModelIdModeSchema,
    exposureError: z
      .string()
      .trim()
      .nullable()
      .meta({ description: 'Why the exposure config is invalid.' }),
    scopeDiagnostics: z.array(scopeDiagnosticSchema).meta({
      description:
        '`enabledModels` patterns that matched nothing, matched several providers, or carried an ' +
        'invalid thinking level.'
    }),
    aliasDiagnostics: z.array(aliasDiagnosticSchema).meta({
      description:
        'Aliases and alias targets left out (#66): named like an exposed model (`shadows-model`), ' +
        "set to a reasoning effort the model doesn't support (`effort-unsupported`, #230), " +
        'following a family no rule knows (`family-unknown`, #231) or pinned outside it ' +
        '(`pin-outside-family`), all of which make the check fail; naming no exposed model ' +
        "(`target-not-exposed`); or a family member whose version the rule can't read " +
        '(`family-unparsed`, never picked).'
    }),
    familyAliases: z.array(familyResolutionSchema).meta({
      description:
        'What each family alias target resolves to now (#231): its pin, else the newest exposed ' +
        'member, with a newer member the exposure config hides.'
    }),
    cooldowns: z.array(cooldownViewSchema).meta({
      description:
        'Active cooldowns after a 429 (the provider) or a 503/529 (the model), soonest end ' +
        'first (#68). They do not fail the check.'
    }),
    modelsJsonError: z.string().trim().nullable().meta({
      description: 'Why `models.json` did not load; a parse error says only where, never what.'
    })
  })
  .meta({ id: 'ModelsHealth' })

/** `GET /healthz/models`'s body; `pi-switchboard doctor` (#299) reads the same report. */
export type ModelsHealth = z.infer<typeof modelsHealthSchema>

/** One provider's quota on `/healthz/creds` (#69). Documents the response; never parsed. */
const credentialQuotaSchema = z
  .object({
    observedAt: z.string().trim().meta({
      description: 'When the response that reported it arrived, as an ISO 8601 time.'
    }),
    status: z.string().trim().nullable(),
    plan: z.string().trim().nullable(),
    windows: z.array(
      z.object({
        name: z.string().trim(),
        used: z.number().min(0).max(1).meta({ description: 'The share used, from 0 to 1.' }),
        resetsAt: z.string().trim().nullable().meta({ description: 'An ISO 8601 time.' }),
        windowMinutes: z.number().nonnegative().nullable(),
        status: z.string().trim().nullable()
      })
    )
  })
  .nullable()
  .meta({
    description:
      "The provider's latest subscription quota, from its response headers (#69), or null when " +
      'it reports none. A window that has reset since is left out.'
  })

/** `GET /healthz/creds`'s body. Documents the response; never parsed. */
const credentialsHealthSchema = z
  .object({
    status: checkStatusSchema,
    verified: z.boolean().meta({ description: 'Whether `?verify=true` was asked for.' }),
    loginsRegistered: z.boolean().meta({
      description:
        "`false` when pi's credential store could not be listed at startup, so the `{provider}-N` " +
        'logins were not registered and stay unregistered until the proxy restarts. It does not ' +
        'change `status`.'
    }),
    loginsError: z
      .string()
      .trim()
      .optional()
      .meta({
        description:
          "With `loginsRegistered: false`: the failure's error code or name (`EACCES`, " +
          '`TimeoutError`); the message is in the proxy log.'
      }),
    providers: z.array(providerCredentialStatusSchema.extend({ quota: credentialQuotaSchema }))
  })
  .meta({ id: 'CredentialsHealth' })

/** `GET /healthz/creds`'s body; `pi-switchboard doctor` (#299) reads the same report. */
export type CredentialsHealth = z.infer<typeof credentialsHealthSchema>

/**
 * Reports a provider's quota, as `/healthz/creds` shows it.
 *
 * @param quota - the quota, or `undefined`
 * @returns its windows with ISO times, or `null`
 */
function credentialQuota(quota: ProviderQuota | undefined): z.infer<typeof credentialQuotaSchema> {
  if (quota === undefined) return null
  return {
    observedAt: new Date(quota.observedAt).toISOString(),
    status: quota.status ?? null,
    plan: quota.plan ?? null,
    windows: quota.windows.map((window) => ({
      name: window.name,
      used: window.used,
      resetsAt: window.resetsAt === undefined ? null : new Date(window.resetsAt).toISOString(),
      windowMinutes: window.windowMinutes ?? null,
      status: window.status ?? null
    }))
  }
}

/** The body of a detail check that threw. Documents the response; never parsed. */
const failedCheckSchema = z
  .object({
    status: z.literal('unavailable'),
    error: z.string().trim().meta({ description: 'Which check failed; the reason is in the log.' })
  })
  .meta({ id: 'FailedCheck' })

/** `GET /healthz`. */
const livenessDescription: DescribeRouteOptions = {
  operationId: 'getLiveness',
  tags: [OPERATIONAL_TAG],
  summary: 'Liveness',
  description:
    "Answers once the proxy listens and pi's model runtime is loaded. No upstream calls, and no " +
    'token needed: for container healthchecks.',
  security: [],
  responses: { 200: jsonResponse('The proxy is up.', livenessSchema) }
}

/** `GET /healthz/models`. */
const modelsHealthDescription: DescribeRouteOptions = {
  operationId: 'getModelsHealth',
  tags: [OPERATIONAL_TAG],
  summary: 'The model runtime and the exposure it gives',
  responses: {
    200: jsonResponse('At least one model is exposed.', modelsHealthSchema),
    401: UNAUTHORIZED,
    503: jsonResponse(
      'No model is exposed or the exposure config is invalid (the same report), or the check threw.',
      z.union([modelsHealthSchema, failedCheckSchema])
    )
  }
}

/** `GET /healthz/creds`. */
const credentialsHealthDescription: DescribeRouteOptions = {
  operationId: 'getCredentialsHealth',
  tags: [OPERATIONAL_TAG],
  summary: "Each provider's credential status",
  description:
    'Local state only, unless `verify=true` asks pi to resolve each credential now, which may ' +
    'refresh an OAuth token over the network. Never returns a credential.',
  responses: {
    200: jsonResponse(
      'Every provider has a credential, verified when asked.',
      credentialsHealthSchema
    ),
    401: UNAUTHORIZED,
    503: jsonResponse(
      'No provider has a credential, or a verified one failed (the same report), or the check threw.',
      z.union([credentialsHealthSchema, failedCheckSchema])
    )
  }
}

/**
 * Answers 503 for a detail check that threw, logging its message instead of returning it.
 *
 * @param context - the request's Hono context
 * @param check - the check's name, as it appears in the log and the response
 * @param error - what the check threw
 * @returns a 503 `{ status: 'unavailable', error }` response that points to the proxy log
 */
function failedCheck(context: HealthContext, check: string, error: unknown): Response {
  healthLogger.warn('The {check} health check threw: {error}', {
    check,
    error: errorMessage(error)
  })
  return context.json(
    { status: 'unavailable', error: `the ${check} check failed; see the proxy log` },
    HTTP_SERVICE_UNAVAILABLE
  )
}

/** A health report: the body, and whether the check passed (a 200) or not (a 503). */
interface HealthReport<Body> {
  readonly body: Body
  readonly healthy: boolean
}

/**
 * Computes `GET /healthz/models`'s report: the model runtime and the exposure it gives.
 *
 * @remarks
 * The route and `pi-switchboard doctor` (#299) both read it, so the doctor's verdict is the
 * route's. It fails when no model is exposed, the exposure config is invalid, or an alias is
 * misconfigured (named like an exposed model, set to an effort its model doesn't support,
 * following an unknown family, or pinned outside it).
 *
 * @param config - the model exposure config
 * @returns the report
 * @throws Error when pi's model runtime is not initialized
 */
export function modelsHealthReport(config: ModelExposureConfig): HealthReport<ModelsHealth> {
  const available = getAvailableModels()
  const now = Date.now()
  const exposure = computeModelExposure(available, config, getSupportedThinkingLevels)
  const exposedModelCount = exposure.ok ? exposure.models.length : 0
  const aliasDiagnostics = exposure.ok ? [...exposure.aliasDiagnostics] : []
  // An alias named like a model is ignored, and the model keeps its name (#66); a target set to an
  // effort its model doesn't support is left out (#230), and so is a family no rule knows or a pin
  // outside its family (#231). Requests still work, but the config does not do what it says. A
  // target that is not exposed may be on purpose, and an unreadable family member is the
  // catalogue's doing: both are only listed.
  const misconfigured = aliasDiagnostics.some((diagnostic) =>
    MISCONFIGURED_ALIAS.has(diagnostic.code)
  )
  const healthy = exposure.ok && exposedModelCount > 0 && !misconfigured
  const body: ModelsHealth = {
    status: healthy ? 'ok' : 'unavailable',
    availableModelCount: available.length,
    exposedModelCount,
    modelExposureMode: config.modelExposureMode,
    publicModelIdMode: config.publicModelIdMode,
    exposureError: exposure.ok ? null : exposure.message,
    // `enabledModels` patterns that matched nothing, or several providers, or carried an invalid
    // thinking level. Patterns are model names from the settings file, not secrets.
    scopeDiagnostics: exposure.ok ? [...exposure.scopeDiagnostics] : [],
    // Alias names and their targets come from the config file: model names, not secrets.
    aliasDiagnostics,
    // Model names from the config and pi's catalogue, not secrets.
    familyAliases: exposure.ok ? [...exposure.familyResolutions] : [],
    // Provider and model names only, never a credential.
    cooldowns: activeCooldowns(now).map((cooldown) => cooldownView(cooldown, now)),
    modelsJsonError: getModelsJsonError() ?? null
  }
  return { body, healthy }
}

/**
 * Answers `GET /healthz/models`: the model runtime and the exposure it gives.
 *
 * @param context - the request's Hono context
 * @param configReader - where the model exposure config comes from
 * @returns 200 with the model report, or 503 with the same report when it fails
 *   ({@link modelsHealthReport})
 */
async function checkModels(
  context: HealthContext,
  configReader: ExposureConfigReader
): Promise<Response> {
  const { body, healthy } = modelsHealthReport(await configReader())
  if (!healthy) {
    healthLogger.warn(
      'Model health check failed: {exposedModelCount} of {availableModelCount} models exposed',
      {
        exposedModelCount: body.exposedModelCount,
        availableModelCount: body.availableModelCount,
        exposureValid: body.exposureError === null,
        misconfiguredAliasCount: body.aliasDiagnostics.filter((diagnostic) =>
          MISCONFIGURED_ALIAS.has(diagnostic.code)
        ).length
      }
    )
    return context.json(body, HTTP_SERVICE_UNAVAILABLE)
  }
  return context.json(body)
}

/**
 * Computes `GET /healthz/creds`'s report: each provider's credential status, verified when asked.
 *
 * @remarks
 * The route and `pi-switchboard doctor --verify` (#299) both read it. It fails when no provider
 * has a credential, or a verified one fails. Never a credential: provider IDs, how each is
 * configured, and for a failed verification a summary safe for a response.
 *
 * @param verify - whether to resolve each credential now, which may refresh an OAuth token over
 *   the network
 * @returns the report
 * @throws Error when pi's model runtime is not initialized
 */
export async function credentialsHealthReport(
  verify: boolean
): Promise<HealthReport<CredentialsHealth>> {
  const providers = await getCredentialStatuses(verify)
  const healthy = providers.length > 0 && providers.every((provider) => provider.verified !== false)
  const logins = getLoginRegistration()
  const body: CredentialsHealth = {
    status: healthy ? 'ok' : 'unavailable',
    verified: verify,
    loginsRegistered: logins.registered,
    ...(logins.registered ? {} : { loginsError: logins.reason }),
    // Usage shares, reset times and plan names only, never a credential or an account ID.
    providers: providers.map((provider) => ({
      ...provider,
      quota: credentialQuota(providerQuota(provider.provider))
    }))
  }
  return { body, healthy }
}

/**
 * Answers `GET /healthz/creds`: each provider's credential status, verified when `?verify=true`.
 *
 * @param context - the request's Hono context
 * @param verify - whether `?verify=true` asked pi to resolve each credential now
 * @returns 200 with the provider list, or 503 with the same list when it fails
 *   ({@link credentialsHealthReport})
 */
async function checkCredentials(context: HealthContext, verify: boolean): Promise<Response> {
  const { body, healthy } = await credentialsHealthReport(verify)
  if (!healthy) {
    healthLogger.warn(
      'Credential health check failed: {providerCount} providers, {failedCount} failed to verify',
      {
        providerCount: body.providers.length,
        failedCount: body.providers.filter((provider) => provider.verified === false).length,
        verify
      }
    )
    return context.json(body, HTTP_SERVICE_UNAVAILABLE)
  }
  return context.json(body)
}

/**
 * Builds the health routes: `GET /healthz`, `GET /healthz/models` and `GET /healthz/creds`.
 *
 * @remarks
 * Proxy auth for the detail endpoints is applied in `createApp`, not here.
 *
 * @param configReader - where `/healthz/models` reads the model exposure config from
 * @returns a Hono app to mount at `/`
 */
export function createHealthRoutes(configReader: ExposureConfigReader): Hono<ProxyEnv> {
  const routes = new Hono<ProxyEnv>()

  routes.get('/healthz', describeRoute(livenessDescription), (context) =>
    context.json({ status: 'ok' })
  )

  routes.get('/healthz/models', describeRoute(modelsHealthDescription), async (context) => {
    try {
      return await checkModels(context, configReader)
    } catch (error) {
      return failedCheck(context, 'models', error)
    }
  })

  routes.get(
    '/healthz/creds',
    describeRoute(credentialsHealthDescription),
    validator('query', credentialsQuerySchema),
    async (context) => {
      const { verify } = context.req.valid('query')
      try {
        return await checkCredentials(context, firstQueryValue(verify) === 'true')
      } catch (error) {
        return failedCheck(context, 'credentials', error)
      }
    }
  )

  return routes
}
