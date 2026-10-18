/**
 * Build OpenAI-compatible model list and model detail responses, and the pi capability list.
 *
 * `/v1/models` keeps the standard OpenAI model object shape only, no x_pi extensions (PLAN.md,
 * Models endpoints). What pi knows about a model beyond that goes on `/v1/pi/models`.
 * Public IDs are determined by the model-exposure engine.
 */

import type { ExposedModel } from '@proxy/openai/model-exposure'
import { supportedReasoningEfforts } from '@proxy/openai/reasoning-effort'
import type { ReasoningEffort } from '@proxy/openai/schemas'

const MS_PER_SECOND = 1000
/** Unix timestamp (seconds) from when the module was first loaded. */
const MODULE_CREATED = Math.floor(Date.now() / MS_PER_SECOND)

export interface OpenAIModel {
  readonly id: string
  readonly object: 'model'
  readonly created: number
  readonly owned_by: string
}

export interface OpenAIModelList {
  readonly object: 'list'
  readonly data: readonly OpenAIModel[]
}

/**
 * Convert an ExposedModel to an OpenAI model object.
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
 * Build the full model list response.
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

export interface PiModelList {
  readonly object: 'list'
  readonly data: readonly PiModelCapabilities[]
}

/** Build the `/v1/pi/models` response: every exposed model, with its capabilities. */
export function buildPiModelList(models: readonly ExposedModel[]): PiModelList {
  return {
    object: 'list',
    data: models.map((exposed) => ({
      id: exposed.publicId,
      reasoning_efforts: supportedReasoningEfforts(exposed.model)
    }))
  }
}
