/**
 * Builds the OpenAI-compatible model list and model objects, and the pi capability list.
 *
 * @remarks
 * `/v1/models` keeps the standard OpenAI model object shape only, no x_pi extensions (PLAN.md,
 * Models endpoints). What pi knows about a model beyond that goes on `/v1/switchboard/models`.
 * Public IDs come from the model-exposure engine.
 *
 * @packageDocumentation
 */

import type { ExposedModel } from '@proxy/openai/model-exposure'
import { supportedReasoningEfforts } from '@proxy/openai/reasoning-effort'
import { REASONING_EFFORTS } from '@proxy/openai/schemas'
import { activeCooldown, type Cooldown, loginSubject } from '@proxy/pi/cooldowns'
import { providerQuota, type ProviderQuota } from '@proxy/pi/quota'
import * as z from 'zod'

/** Milliseconds per second, to turn `Date.now()` into a Unix timestamp. */
const MS_PER_SECOND = 1000
/**
 * Unix timestamp (seconds) from when the module was first loaded: every model's `created`. pi's
 * catalogue has no release dates (#176), and OpenAI's model object requires the field.
 */
const MODULE_CREATED = Math.floor(Date.now() / MS_PER_SECOND)

/** An OpenAI model object, as on `/v1/models`. Documents the response; never parsed. */
export const openAIModelSchema = z
  .object({
    id: z.string().trim().meta({ description: 'The public model ID; may contain `/`.' }),
    object: z.literal('model'),
    created: z.int().meta({
      description:
        'Unix time (seconds) the proxy started, the same for every model: not a release date, ' +
        "since pi's catalogue has none. `GET /v1/switchboard/models` has what pi knows per model."
    }),
    owned_by: z.string().trim().meta({ description: "The model's pi provider." })
  })
  .meta({ id: 'Model', description: 'An OpenAI model object.' })

/** An OpenAI model object, as on `/v1/models`. */
export type OpenAIModel = z.infer<typeof openAIModelSchema>

/** The `/v1/models` list response. Documents the response; never parsed. */
export const openAIModelListSchema = z
  .object({ object: z.literal('list'), data: z.array(openAIModelSchema) })
  .meta({ id: 'ListModelsResponse', description: 'The exposed models.' })

/** The `/v1/models` list response. */
export type OpenAIModelList = z.infer<typeof openAIModelListSchema>

/**
 * Converts an exposed model to an OpenAI model object.
 *
 * @param exposed - the exposed model
 * @returns the model object, with the public ID, the provider as `owned_by`, and the module load
 *   time as `created`
 */
export function toOpenAIModel(exposed: ExposedModel): OpenAIModel {
  return {
    id: exposed.publicId,
    object: 'model',
    created: MODULE_CREATED,
    owned_by: exposed.provider
  }
}

/**
 * Builds the `/v1/models` list response.
 *
 * @param models - the exposed models, in list order
 * @returns the list response
 */
export function buildModelList(models: readonly ExposedModel[]): OpenAIModelList {
  return {
    object: 'list',
    data: models.map(toOpenAIModel)
  }
}

/** A price in USD per million tokens. Documents the response; never parsed. */
const pricePerMillionSchema = z
  .number()
  .nonnegative()
  .meta({ description: 'USD per million tokens.' })

/** A login's cooldown on `/v1/switchboard/models`. Documents the response; never parsed. */
const cooldownSchema = z
  .object({
    reason: z.enum(['rate_limit', 'unavailable']).meta({
      description: 'The failure it is cooling down from: a 429, or a 503 or 529.'
    }),
    scope: z.enum(['provider', 'model']).meta({
      description: 'A 429 cools the whole login; an overload, the model.'
    }),
    until: z.int().nonnegative().meta({ description: 'When it ends, in Unix seconds.' })
  })
  .nullable()
  .meta({
    description:
      'The cooldown the model is under (#68), or null. A route that names the reason in its ' +
      '`fallbackOn` skips it until then; one that names neither still calls it.'
  })

/** A login's quota on `/v1/switchboard/models`. Documents the response; never parsed. */
const quotaSchema = z
  .object({
    observed_at: z
      .int()
      .nonnegative()
      .meta({ description: 'When the response that reported it arrived, in Unix seconds.' }),
    status: z.string().trim().nullable().meta({
      description: "The provider's overall status, such as Anthropic's `allowed`."
    }),
    plan: z.string().trim().nullable().meta({ description: "The plan, such as Codex's `plus`." }),
    windows: z.array(
      z.object({
        name: z.string().trim().meta({
          description: "The provider's name for the window: `5h`, `7d`, `primary`, `secondary`."
        }),
        used: z.number().min(0).max(1).meta({ description: 'The share used, from 0 to 1.' }),
        resets_at: z
          .int()
          .nonnegative()
          .nullable()
          .meta({ description: 'When it resets, in Unix seconds.' }),
        window_minutes: z.number().nonnegative().nullable(),
        status: z.string().trim().nullable()
      })
    )
  })
  .nullable()
  .meta({
    description:
      "The login's latest subscription quota, from its response headers (#69), or null when it " +
      'reports none (Google, API keys, or no call since the proxy started). A window that has ' +
      'reset since is left out.'
  })

/**
 * What pi knows about an exposed model that the OpenAI model object has no field for: pi's
 * catalogue entry, as pi resolves it (a `models.json` override included). Documents the response;
 * never parsed.
 */
const piModelCapabilitiesSchema = z
  .object({
    id: z.string().trim().meta({ description: 'The public ID, as on `/v1/models`.' }),
    provider: z.string().trim().meta({ description: "The model's pi provider." }),
    reasoning: z.boolean().meta({ description: 'Whether the model reasons.' }),
    reasoning_efforts: z.array(z.enum(REASONING_EFFORTS)).meta({
      description:
        'The `reasoning_effort` values the model runs at as asked, lowest first. Any other value ' +
        'is accepted and clamped to the nearest level the model supports. `["none"]` for a ' +
        'model without reasoning. For an alias whose first target sets its effort, that effort ' +
        'alone.'
    }),
    reasoning_effort_fixed: z.boolean().meta({
      description:
        "True for an alias whose first target sets its effort (#230): a request's " +
        '`reasoning_effort` is replaced by the one listed. A fallback chain lists its first ' +
        "target; a later target runs at its own effort, or the request's. False otherwise."
    }),
    input: z.array(z.enum(['text', 'image'])).meta({ description: 'What the model accepts.' }),
    context_window: z.int().nonnegative().meta({ description: 'The context window, in tokens.' }),
    max_output_tokens: z
      .int()
      .nonnegative()
      .meta({ description: 'The most output tokens one response can have.' }),
    cost: z
      .object({
        input: pricePerMillionSchema,
        output: pricePerMillionSchema,
        cache_read: pricePerMillionSchema,
        cache_write: pricePerMillionSchema
      })
      .meta({
        description:
          "pi's prices, in USD per million tokens: uncached input, output, cache reads and " +
          'cache writes. 0 where pi has no price.'
      }),
    cooldown: cooldownSchema,
    quota: quotaSchema,
    logins: z
      .array(
        z.object({
          id: z.string().trim().meta({
            description:
              'The login: the provider, or one of its extra logins (`anthropic-2`, #227).'
          }),
          cooldown: cooldownSchema,
          quota: quotaSchema
        })
      )
      .meta({
        description:
          'The logins that may serve the model, in the order routing tries them (#227). The ' +
          "model's own `cooldown` and `quota` are the first login's."
      })
  })
  .meta({ id: 'ModelCapabilities', description: 'What pi knows about an exposed model.' })

/** The `/v1/switchboard/models` list response. Documents the response; never parsed. */
export const piModelListSchema = z
  .object({ object: z.literal('list'), data: z.array(piModelCapabilitiesSchema) })
  .meta({
    id: 'ListModelCapabilitiesResponse',
    description: 'Each exposed model, with its capabilities.'
  })

/** The `/v1/switchboard/models` list response. */
export type PiModelList = z.infer<typeof piModelListSchema>

/**
 * Reports a model's active cooldown, as `/v1/switchboard/models` shows it.
 *
 * @param cooldown - the active cooldown, or `undefined`
 * @returns the cooldown's reason, scope and end in Unix seconds, or `null`
 */
function cooldownField(cooldown: Cooldown | undefined): PiModelList['data'][number]['cooldown'] {
  if (cooldown === undefined) return null
  return {
    reason: cooldown.reason,
    scope: cooldown.scope,
    until: Math.ceil(cooldown.until / MS_PER_SECOND)
  }
}

/**
 * Reports a provider's latest quota, as `/v1/switchboard/models` shows it.
 *
 * @param quota - the quota, or `undefined`
 * @returns its windows with times in Unix seconds, or `null`
 */
function quotaField(quota: ProviderQuota | undefined): PiModelList['data'][number]['quota'] {
  if (quota === undefined) return null
  return {
    observed_at: Math.floor(quota.observedAt / MS_PER_SECOND),
    status: quota.status ?? null,
    plan: quota.plan ?? null,
    windows: quota.windows.map((window) => ({
      name: window.name,
      used: window.used,
      resets_at: window.resetsAt === undefined ? null : Math.ceil(window.resetsAt / MS_PER_SECOND),
      window_minutes: window.windowMinutes ?? null,
      status: window.status ?? null
    }))
  }
}

/**
 * Reports one login of a model: its cooldown (#68) and its quota (#69).
 *
 * @param login - the login's entry: its provider is the login
 * @returns the login's ID, cooldown and quota
 */
function loginField(login: ExposedModel): PiModelList['data'][number]['logins'][number] {
  return {
    id: login.login,
    cooldown: cooldownField(activeCooldown(loginSubject(login))),
    quota: quotaField(providerQuota(login.login))
  }
}

/**
 * Builds the `/v1/switchboard/models` response: every exposed model, with pi's catalogue entry,
 * its cooldown (#68) and its provider's quota (#69), and each of its logins (#227). An alias
 * carries its first target's (#66), with that target's effort when it sets one (#230).
 *
 * @param models - the exposed models, in list order
 * @returns the list response
 */
export function buildPiModelList(models: readonly ExposedModel[]): PiModelList {
  return {
    object: 'list',
    data: models.map((exposed) => {
      const { publicId, model } = exposed
      const logins = (exposed.logins ?? [exposed]).map(loginField)
      const [first] = logins
      return {
        id: publicId,
        provider: exposed.provider,
        reasoning: model.reasoning,
        // An alias's forced effort replaces any the request sends (#230).
        reasoning_efforts:
          exposed.reasoningEffort === undefined
            ? supportedReasoningEfforts(model)
            : [exposed.reasoningEffort],
        reasoning_effort_fixed: exposed.reasoningEffort !== undefined,
        input: [...model.input],
        context_window: model.contextWindow,
        max_output_tokens: model.maxTokens,
        cost: {
          input: model.cost.input,
          output: model.cost.output,
          cache_read: model.cost.cacheRead,
          cache_write: model.cost.cacheWrite
        },
        cooldown: first?.cooldown ?? null,
        quota: first?.quota ?? null,
        logins
      }
    })
  }
}
