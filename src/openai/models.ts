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
import { activeCooldown, type Cooldown } from '@proxy/pi/cooldowns'
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
        'model without reasoning.'
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
    cooldown: z
      .object({
        reason: z.enum(['rate_limit', 'unavailable']).meta({
          description: 'The failure it is cooling down from: a 429, or a 503 or 529.'
        }),
        scope: z.enum(['provider', 'model']).meta({
          description: 'A 429 cools the whole provider (its login); an overload, the model.'
        }),
        until: z.int().nonnegative().meta({ description: 'When it ends, in Unix seconds.' })
      })
      .nullable()
      .meta({
        description:
          'The cooldown the model is under (#68), or null. An alias chain that names the reason ' +
          'in `fallbackOn` skips it until then; a request that names the model still calls it.'
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
 * Builds the `/v1/switchboard/models` response: every exposed model, with pi's catalogue entry and
 * its cooldown (#68). An alias carries its target's (#66).
 *
 * @param models - the exposed models, in list order
 * @returns the list response
 */
export function buildPiModelList(models: readonly ExposedModel[]): PiModelList {
  return {
    object: 'list',
    data: models.map((exposed) => {
      const { publicId, model } = exposed
      return {
        id: publicId,
        provider: model.provider,
        reasoning: model.reasoning,
        reasoning_efforts: supportedReasoningEfforts(model),
        input: [...model.input],
        context_window: model.contextWindow,
        max_output_tokens: model.maxTokens,
        cost: {
          input: model.cost.input,
          output: model.cost.output,
          cache_read: model.cost.cacheRead,
          cache_write: model.cost.cacheWrite
        },
        cooldown: cooldownField(activeCooldown(exposed))
      }
    })
  }
}
