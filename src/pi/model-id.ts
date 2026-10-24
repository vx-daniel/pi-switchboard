/**
 * The canonical internal model ID, `provider/model-id`: how the proxy names a pi model in its
 * config, its logs and its own routes (AGENTS.md "Core constraints").
 *
 * @remarks
 * Its own module, importing nothing of the proxy's, so every layer can name a model the same way
 * without a cycle through model exposure.
 *
 * @packageDocumentation
 */

import type { Api, Model } from '@earendil-works/pi-ai'

/**
 * Names a pi model canonically: `provider/model-id`.
 *
 * @param model - the model, or anything with its `provider` and `id`
 * @returns the canonical ID
 */
export function canonicalModelId(model: Pick<Model<Api>, 'provider' | 'id'>): string {
  return `${model.provider}/${model.id}`
}
