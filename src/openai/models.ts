/**
 * Builds the OpenAI-compatible model list and model objects, and the pi capability list.
 *
 * @remarks
 * `/v1/models` keeps the standard OpenAI model object shape only, no x_pi extensions (PLAN.md,
 * Models endpoints). What pi knows about a model beyond that goes on `/v1/pi/models`.
 * Public IDs come from the model-exposure engine.
 *
 * @packageDocumentation
 */

import type { ExposedModel } from '@proxy/openai/model-exposure'
import { supportedReasoningEfforts } from '@proxy/openai/reasoning-effort'
import type { ReasoningEffort } from '@proxy/openai/schemas'

/** Milliseconds per second, to turn `Date.now()` into a Unix timestamp. */
const MS_PER_SECOND = 1000
/** Unix timestamp (seconds) from when the module was first loaded. */
const MODULE_CREATED = Math.floor(Date.now() / MS_PER_SECOND)

/** An OpenAI model object, as on `/v1/models`. */
export interface OpenAIModel {
  readonly id: string
  readonly object: 'model'
  readonly created: number
  readonly owned_by: string
}

/** The `/v1/models` list response. */
export interface OpenAIModelList {
  readonly object: 'list'
  readonly data: readonly OpenAIModel[]
}

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

/** What pi knows about an exposed model that the OpenAI model object has no field for. */
export interface PiModelCapabilities {
  /** The public ID, as on `/v1/models`. */
  readonly id: string
  /**
   * The `reasoning_effort` values the model runs at as asked, lowest first. Any other value is
   * accepted and clamped to the nearest level the model supports. `["none"]` for a model without
   * reasoning.
   */
  readonly reasoning_efforts: readonly ReasoningEffort[]
}

/** The `/v1/pi/models` list response. */
export interface PiModelList {
  readonly object: 'list'
  readonly data: readonly PiModelCapabilities[]
}

/**
 * Builds the `/v1/pi/models` response: every exposed model, with its capabilities.
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
