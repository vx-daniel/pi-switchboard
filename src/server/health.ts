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

import { ModelExposureModeSchema, PublicModelIdModeSchema } from '@proxy/config/schema'
import { proxyLogger } from '@proxy/logging'
import { aliasDiagnosticSchema } from '@proxy/openai/model-aliases'
import { computeModelExposure } from '@proxy/openai/model-exposure'
import { scopeDiagnosticSchema } from '@proxy/pi/model-scope'
import {
  getAvailableModels,
  getCredentialStatuses,
  getModelsJsonError,
  providerCredentialStatusSchema
} from '@proxy/pi/registry'
import { HTTP_SERVICE_UNAVAILABLE } from '@proxy/server/http-status'
import {
  credentialsQuerySchema,
  jsonResponse,
  OPERATIONAL_TAG,
  UNAUTHORIZED
} from '@proxy/server/openapi'
import type { ExposureConfigReader } from '@proxy/server/routes'
import type { ProxyEnv } from '@proxy/server/types'
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
        'Aliases left out (#66): named like an exposed model (`shadows-model`, which makes the ' +
        'check fail), or naming no exposed model (`target-not-exposed`).'
    }),
    modelsJsonError: z.string().trim().nullable().meta({
      description: 'Why `models.json` did not load; a parse error says only where, never what.'
    })
  })
  .meta({ id: 'ModelsHealth' })

/** `GET /healthz/models`'s body. */
type ModelsHealth = z.infer<typeof modelsHealthSchema>

/** `GET /healthz/creds`'s body. Documents the response; never parsed. */
const credentialsHealthSchema = z
  .object({
    status: checkStatusSchema,
    verified: z.boolean().meta({ description: 'Whether `?verify=true` was asked for.' }),
    providers: z.array(providerCredentialStatusSchema)
  })
  .meta({ id: 'CredentialsHealth' })

/** `GET /healthz/creds`'s body. */
type CredentialsHealth = z.infer<typeof credentialsHealthSchema>

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
    error: error instanceof Error ? error.message : String(error)
  })
  return context.json(
    { status: 'unavailable', error: `the ${check} check failed; see the proxy log` },
    HTTP_SERVICE_UNAVAILABLE
  )
}

/**
 * Answers `GET /healthz/models`: the model runtime and the exposure it gives.
 *
 * @param context - the request's Hono context
 * @param configReader - where the model exposure config comes from
 * @returns 200 with the model report, or 503 with the same report when no model is exposed, the
 *   exposure config is invalid, or an alias is named like an exposed model
 */
async function checkModels(
  context: HealthContext,
  configReader: ExposureConfigReader
): Promise<Response> {
  const config = await configReader()
  const available = getAvailableModels()
  const exposure = computeModelExposure(available, config)
  const exposedModelCount = exposure.ok ? exposure.models.length : 0
  const aliasDiagnostics = exposure.ok ? [...exposure.aliasDiagnostics] : []
  // An alias named like a model is ignored, and the model keeps its name: requests still work, but
  // the config does not do what it says (#66).
  const shadowingAliasCount = aliasDiagnostics.filter(
    (diagnostic) => diagnostic.code === 'shadows-model'
  ).length
  const healthy = exposure.ok && exposedModelCount > 0 && shadowingAliasCount === 0
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
    modelsJsonError: getModelsJsonError() ?? null
  }
  if (!healthy) {
    healthLogger.warn(
      'Model health check failed: {exposedModelCount} of {availableModelCount} models exposed',
      {
        exposedModelCount,
        availableModelCount: available.length,
        exposureValid: exposure.ok,
        shadowingAliasCount
      }
    )
    return context.json(body, HTTP_SERVICE_UNAVAILABLE)
  }
  return context.json(body)
}

/**
 * Answers `GET /healthz/creds`: each provider's credential status, verified when `?verify=true`.
 *
 * @param context - the request's Hono context
 * @param verify - whether `?verify=true` asked pi to resolve each credential now
 * @returns 200 with the provider list, or 503 with the same list when no provider has a credential
 *   or a verified one fails
 */
async function checkCredentials(context: HealthContext, verify: boolean): Promise<Response> {
  const providers = await getCredentialStatuses(verify)
  const failed = providers.filter((provider) => provider.verified === false)
  const healthy = providers.length > 0 && failed.length === 0
  const body: CredentialsHealth = {
    status: healthy ? 'ok' : 'unavailable',
    verified: verify,
    providers
  }
  if (!healthy) {
    healthLogger.warn(
      'Credential health check failed: {providerCount} providers, {failedCount} failed to verify',
      { providerCount: providers.length, failedCount: failed.length, verify }
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
      // A repeated `verify` counts by its first value (`credentialsQuerySchema`).
      const verifyValue = Array.isArray(verify) ? verify[0] : verify
      try {
        return await checkCredentials(context, verifyValue === 'true')
      } catch (error) {
        return failedCheck(context, 'credentials', error)
      }
    }
  )

  return routes
}
