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
import * as z from 'zod'

/** Milliseconds per second, to turn `Date.now()` into a Unix timestamp. */
const MS_PER_SECOND = 1000
/** Unix timestamp (seconds) from when the module was first loaded. */
const MODULE_CREATED = Math.floor(Date.now() / MS_PER_SECOND)

/** An OpenAI model object, as on `/v1/models`. Documents the response; never parsed. */
export const openAIModelSchema = z
  .object({
    id: z.string().trim().meta({ description: 'The public model ID; may contain `/`.' }),
    object: z.literal('model'),
    created: z.int().meta({ description: 'Unix time (seconds) the proxy started.' }),
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

/**
 * What pi knows about an exposed model that the OpenAI model object has no field for. Documents
 * the response; never parsed.
 */
const piModelCapabilitiesSchema = z
  .object({
    id: z.string().trim().meta({ description: 'The public ID, as on `/v1/models`.' }),
    reasoning_efforts: z.array(z.enum(REASONING_EFFORTS)).meta({
      description:
        'The `reasoning_effort` values the model runs at as asked, lowest first. Any other value ' +
        'is accepted and clamped to the nearest level the model supports. `["none"]` for a ' +
        'model without reasoning.'
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
 * Builds the `/v1/switchboard/models` response: every exposed model, with its capabilities.
 *
 * @param models - the exposed models, in list order
 * @returns the list response
 */
export function buildPiModelList(models: readonly ExposedModel[]): PiModelList {
  return {
    object: 'list',
    data: models.map((exposed) => ({
      id: exposed.publicId,
      reasoning_efforts: supportedReasoningEfforts(exposed.model)
    }))
  }
}
