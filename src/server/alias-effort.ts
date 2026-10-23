/**
 * An alias target's reasoning effort (#230): the request each of its candidates is sent, and the
 * effort the answer reports (#175).
 *
 * @packageDocumentation
 */

import { proxyLogger } from '@proxy/logging'
import type { ExposedModel } from '@proxy/openai/model-exposure'
import { type EffortReport, effortReport } from '@proxy/openai/reasoning-effort'
import type { ChatCompletionRequest } from '@proxy/openai/schemas'

/** Logger for chat requests: the same category as the chat route's. */
const chatLogger = proxyLogger('server', 'chat')

/**
 * Aliases a replaced client `reasoning_effort` has been logged for in this process; each is
 * logged at info once (#230), as dropped temperatures are per model.
 */
const aliasesWithReplacedEffort = new Set<string>()

/**
 * Gives a candidate the request with its alias target's effort, when the target sets one (#230).
 *
 * @remarks
 * The target's effort replaces the client's `reasoning_effort` (constitution principle I lists
 * the exception): the operator chose the effort for that name, and `x_pi.reasoning_effort` and
 * the log report both. Replacing a different client value is logged at info the first time per
 * alias, then at debug, as listed drops are.
 *
 * @param request - the client's request
 * @param alias - the alias it named, for the log
 * @param candidate - the model about to be called
 * @returns the request to send it: unchanged when the target sets no effort
 */
export function withAliasEffort(
  request: ChatCompletionRequest,
  alias: string | undefined,
  candidate: ExposedModel
): ChatCompletionRequest {
  const forced = candidate.reasoningEffort
  if (forced === undefined) return request
  const requested = request.reasoning_effort
  if (requested !== undefined && requested !== forced) {
    const name = alias ?? candidate.canonicalId
    const firstForAlias = !aliasesWithReplacedEffort.has(name)
    aliasesWithReplacedEffort.add(name)
    const message =
      'Alias {alias} runs {model} at reasoning_effort {aliasEffort}, not the requested {reasoningEffort}'
    const properties = {
      alias: name,
      model: candidate.canonicalId,
      aliasEffort: forced,
      reasoningEffort: requested
    }
    if (firstForAlias) chatLogger.info(message, properties)
    else chatLogger.debug(message, properties)
  }
  return { ...request, reasoning_effort: forced }
}

/**
 * Reports the effort the candidate that answered ran at, as `x_pi.reasoning_effort`.
 *
 * @remarks
 * The model that answered decides it (#175), not the one the request named, and its alias
 * target's effort replaces the request's (#230).
 *
 * @param request - the client's request
 * @param candidate - the model that answered
 * @returns what was asked and what ran, or `undefined` when neither the request nor the target
 *   sets an effort
 */
export function answeredEffort(
  request: ChatCompletionRequest,
  candidate: ExposedModel
): EffortReport | undefined {
  return effortReport(candidate.model, request.reasoning_effort, candidate.reasoningEffort)
}
