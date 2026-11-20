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

import { FailureClassSchema } from '@proxy/config/schema'
import type { ExposedModel } from '@proxy/openai/model-exposure'
import { supportedReasoningEfforts } from '@proxy/openai/reasoning-effort'
import { REASONING_EFFORTS } from '@proxy/openai/schemas'
import { modelAvailability } from '@proxy/pi/availability'
import { activeCooldown, type Cooldown, loginSubject } from '@proxy/pi/cooldowns'
import { providerQuota, type ProviderQuota } from '@proxy/pi/quota'
import type { RoutePreview } from '@proxy/server/route-preview'
import { MS_PER_SECOND, unixSecondsNow } from '@proxy/utils/time'
import * as z from 'zod'

/**
 * Unix timestamp (seconds) from when the module was first loaded: every model's `created`. pi's
 * catalogue has no release dates (#176), and OpenAI's model object requires the field.
 */
const MODULE_CREATED = unixSecondsNow()

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
      'The cooldown the login is under (#68), or null. A route that names the reason in its ' +
      '`fallbackOn` skips it until then; one that names neither still calls it.'
  })

/** A login's quota on `/v1/switchboard/models`. Documents the response; never parsed. */
const quotaSchema = z
  .object({
    observed_at: z
      .int()
      .nonnegative()
      .meta({ description: 'When the response that reported it arrived, in Unix seconds.' }),
    status: z
      .string()
      .trim()
      .nullable()
      .meta({
        description:
          "The provider's overall status, such as Anthropic's `allowed` or `rejected`; null once " +
          'it has reset until the next response: at `status_resets_at` when the provider sent ' +
          'it, else once any window has reset.'
      }),
    status_resets_at: z.int().nonnegative().nullable().meta({
      description: 'When the overall status resets, in Unix seconds (Anthropic, #382).'
    }),
    status_window: z
      .string()
      .trim()
      .nullable()
      .meta({
        description:
          'The window that decided the overall status, as the provider names it, such as ' +
          "Anthropic's `five_hour` (#382)."
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

/** What a request naming the model would do now (#379). Documents the response; never parsed. */
const routingSchema = z
  .object({
    next: z
      .object({
        model: z.string().trim().meta({ description: 'Its canonical ID.' }),
        login: z.string().trim().meta({ description: 'The login it would be called under.' })
      })
      .meta({
        description:
          'The model and login a request would call first: for an alias, a later target when ' +
          'the chain would move past the first.'
      }),
    skipped: z
      .array(
        z.object({
          model: z.string().trim().meta({ description: 'Its canonical ID.' }),
          login: z.string().trim().optional().meta({
            description: 'The login, when the model has more than one (#227).'
          }),
          reason: z.enum([...FailureClassSchema.options, 'quota']).meta({
            description:
              'Why it would be passed over: the failure it is cooling down from, or `quota` when ' +
              "its login has less than the config's `routing.reserve` left (#69)."
          }),
          until: z.int().nonnegative().nullable().meta({
            description: 'When its cooldown ends, in Unix seconds; null for `quota`.'
          })
        })
      )
      .meta({
        description:
          'The candidates it would pass over before `next`, in order, as `x_pi.attempts` lists ' +
          'skips.'
      })
  })
  .meta({
    description:
      'What a text request naming the model would do now (#379), by the same rules routing ' +
      "follows: the config's `fallbackOn` classes, cooldowns and `routing.reserve`. Routing never " +
      'skips every candidate, so there is always a `next`. No credential is resolved for it, so it ' +
      'assumes each one on the way resolves: a request first checks the credential of every ' +
      'candidate it reaches past cooldowns (a reserve skip included), and a refused one fails the ' +
      'request (502 `upstream_credentials_missing`) unless the hop names `auth`.'
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
    cooldown: cooldownSchema.meta({
      description:
        'The cooldown of the login a request would call now (`routing.next`, #379), or null when ' +
        "it is free. Routing passes a cooling login over when the config's `fallbackOn` names the " +
        'reason and another candidate is free, and when every one is cooling it calls the one ' +
        'that ends first: this is then that cooldown. Each login has its own in `logins`.'
    }),
    quota: quotaSchema.meta({
      description:
        "The subscription quota of `routing.next`'s login (#69, #379), or null when it reports " +
        'none. Each login has its own in `logins`.'
    }),
    routing: routingSchema,
    availability: z.enum(['verified', 'refused', 'unknown']).meta({
      description:
        'Whether the provider login serves the model, from calls this process made (#174): ' +
        '`refused` after the login refused it (answered as 404 `model_not_found`), `verified` ' +
        'after a whole answer, `unknown` before either. The latest result wins. An alias ' +
        "reports its target's."
    }),
    logins: z
      .array(
        z.object({
          id: z.string().trim().meta({
            description:
              'The login: the provider, or one of its extra logins (`anthropic-2`, #227).'
          }),
          disabled: z.boolean().meta({
            description:
              'Whether `routing.logins.disabled` names the login (#233): it keeps its ' +
              'credential, but routing never calls it.'
          }),
          cooldown: cooldownSchema,
          quota: quotaSchema
        })
      )
      .meta({
        description:
          'The logins that may serve the model, in the order routing tries them (#227), as ' +
          '`routing.logins.order` sets it (#233); then the disabled ones, which it never tries. ' +
          "Each login's own `cooldown` and `quota`; the model's are those of `routing.next`."
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
    status_resets_at:
      quota.statusResetsAt === undefined ? null : Math.ceil(quota.statusResetsAt / MS_PER_SECOND),
    status_window: quota.statusWindow ?? null,
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
 * Reports one login of a model: whether it is disabled (#233), its cooldown (#68) and its quota
 * (#69).
 *
 * @param login - the login's entry: its provider is the login
 * @param disabled - whether `routing.logins.disabled` names it
 * @returns the login's ID, whether it is disabled, its cooldown and its quota
 */
function loginField(
  login: ExposedModel,
  disabled: boolean
): PiModelList['data'][number]['logins'][number] {
  return {
    id: login.login,
    disabled,
    cooldown: cooldownField(activeCooldown(loginSubject(login))),
    quota: quotaField(providerQuota(login.login))
  }
}

/**
 * Reports what a request would do now (#379): the model and login it would call first, and the
 * candidates it would pass over.
 *
 * @param preview - the route preview
 * @returns the `routing` field
 */
function routingField(preview: RoutePreview): PiModelList['data'][number]['routing'] {
  return {
    next: { model: preview.next.canonicalId, login: preview.next.login },
    skipped: preview.skipped.map((skip) => ({ ...skip }))
  }
}

/**
 * Builds the `/v1/switchboard/models` response: every exposed model, with pi's catalogue entry,
 * each of its logins (#227) with its cooldown (#68) and quota (#69), and what a request naming it
 * would do now (#379), whose login's cooldown and quota are the model's. An alias carries its
 * first target's catalogue entry (#66), with that target's effort when it sets one (#230).
 *
 * @param models - the exposed models, in list order
 * @param previewOf - previews a model's route, as routing would take it now
 * @returns the list response
 */
export function buildPiModelList(
  models: readonly ExposedModel[],
  previewOf: (exposed: ExposedModel) => RoutePreview
): PiModelList {
  return {
    object: 'list',
    data: models.map((exposed) => {
      const { publicId, model } = exposed
      const enabled = (exposed.logins ?? [exposed]).map((login) => loginField(login, false))
      const disabled = (exposed.disabledLogins ?? []).map((login) => loginField(login, true))
      const preview = previewOf(exposed)
      const next = loginField(preview.next, false)
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
        cooldown: next.cooldown,
        quota: next.quota,
        routing: routingField(preview),
        availability: modelAvailability(exposed.canonicalId),
        logins: [...enabled, ...disabled]
      }
    })
  }
}
