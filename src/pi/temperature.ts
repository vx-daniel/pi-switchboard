/**
 * The `temperature` the proxy gives pi, and the two places it does not reach the provider.
 *
 * @remarks
 * Both drops are listed in constitution principle I, and each is logged: at info the first time
 * per model, so the operator sees it, then at debug, as a client that always sends a temperature
 * would otherwise log a line per request.
 * - The Codex backend rejects temperature ("Unsupported parameter: temperature"), though pi 1.3.0
 *   forwards it. The proxy drops it there, so clients that always send one keep working on Codex
 *   models (#49).
 * - pi's Anthropic adapter leaves it out itself on Claude models that refuse it, and whenever
 *   thinking is on. The proxy still passes it to pi, which decides; it only says so in the log
 *   (#147), so a drift between this copy of pi's rule and pi changes the log, never the request.
 *
 * @packageDocumentation
 */

import type { Api, Model } from '@earendil-works/pi-ai'
import { proxyLogger } from '@proxy/logging'
import { canonicalModelId } from '@proxy/pi/model-id'

/** Logger for upstream calls. */
const completeLogger = proxyLogger('pi', 'complete')

/**
 * Models, as `provider/id`, a dropped temperature has been logged for in this process; each is
 * logged at info once. Two providers can serve the same model ID.
 */
const modelsWithDroppedTemperature = new Set<string>()

/**
 * Says whether `model` is on the Anthropic Messages API, narrowing its `compat` to Anthropic's.
 *
 * @param model - the pi model
 * @returns whether its API is `anthropic-messages`
 */
function isAnthropicModel(model: Model<Api>): model is Model<'anthropic-messages'> {
  return model.api === 'anthropic-messages'
}

/**
 * Says why pi's Anthropic adapter will not send `temperature` for `model`, if it will not.
 *
 * @remarks
 * Mirrors pi-ai 1.3.0's `buildParams` (`api/anthropic-messages.js`): temperature is sent only
 * with thinking off, and only to a model whose compat neither sets `supportsMidConvoEffort` nor
 * clears `supportsTemperature`. pi's catalog marks Claude 4.7 and later that way, and Claude
 * refuses a temperature below 1 on them (#147).
 *
 * @param model - the pi model
 * @param thinking - whether the request turns thinking on
 * @returns the reason, or `undefined` when pi sends it (or the model is not on Anthropic's API)
 */
function anthropicTemperatureDropReason(model: Model<Api>, thinking: boolean): string | undefined {
  if (!isAnthropicModel(model)) return undefined
  if (thinking) return 'thinking is on'
  if (
    model.compat?.supportsMidConvoEffort === true ||
    model.compat?.supportsTemperature === false
  ) {
    return 'the model does not accept it'
  }
  return undefined
}

/**
 * Logs a temperature that does not reach the provider: at info the first time per model, then at
 * debug.
 *
 * @param model - the pi model
 * @param temperature - the request's temperature
 * @param reason - why it does not reach the provider
 */
function logDroppedTemperature(model: Model<Api>, temperature: number, reason: string): void {
  const key = canonicalModelId(model)
  const firstForModel = !modelsWithDroppedTemperature.has(key)
  modelsWithDroppedTemperature.add(key)
  const dropped = 'Dropped temperature {temperature} for {modelId}: {reason}'
  const properties = { temperature, modelId: model.id, api: model.api, reason }
  if (firstForModel) completeLogger.info(dropped, properties)
  else completeLogger.debug(dropped, properties)
}

/**
 * Returns the temperature to give pi for `model`, and logs when it will not reach the provider.
 *
 * @param model - the pi model
 * @param temperature - the request's temperature
 * @param thinking - whether the request turns thinking on
 * @returns `temperature`, or `undefined` when the proxy drops it (Codex models)
 */
export function upstreamTemperature(
  model: Model<Api>,
  temperature: number,
  thinking: boolean
): number | undefined {
  if (model.api === 'openai-codex-responses') {
    logDroppedTemperature(model, temperature, 'the Codex backend does not accept it')
    return undefined
  }
  const reason = anthropicTemperatureDropReason(model, thinking)
  if (reason !== undefined) {
    logDroppedTemperature(model, temperature, `pi does not send it, as ${reason}`)
  }
  return temperature
}
