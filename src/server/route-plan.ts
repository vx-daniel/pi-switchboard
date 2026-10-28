/**
 * Plans a chat request's route (#67, #227): the candidates it may run on, in order, and the
 * failures that move between them. The dispatch (`src/server/chat-dispatch.ts`) runs them.
 *
 * @packageDocumentation
 */

import type { FailureClass } from '@proxy/config/schema'
import { proxyLogger } from '@proxy/logging'
import type { ExposedModel } from '@proxy/openai/model-exposure'
import type { ChatCompletionRequest } from '@proxy/openai/schemas'
import type { RouteHops } from '@proxy/server/route-hops'

/** Logger for chat requests: the same category as the chat route's. */
const chatLogger = proxyLogger('server', 'chat')

/**
 * The models a request may run on, in order, and the failures that move between them: an alias's
 * between models, `routing.logins.fallbackOn` between a model's logins (#227).
 */
export interface ChatRoute extends RouteHops {
  readonly candidates: readonly ExposedModel[]
}

/**
 * Says whether a request carries an image.
 *
 * @param request - the validated request
 * @returns whether any message has an `image_url` part
 */
function hasImage(request: ChatCompletionRequest): boolean {
  return request.messages.some(
    (message) =>
      Array.isArray(message.content) && message.content.some((part) => part.type === 'image_url')
  )
}

/**
 * Expands an exposed model into one candidate per login (#227), each knowing the choice it is
 * part of.
 *
 * @param exposed - the exposed model, or an alias's target
 * @returns its logins in order, or the model alone when it has one login
 */
function perLogin(exposed: ExposedModel): readonly ExposedModel[] {
  const { logins, reasoningEffort } = exposed
  if (logins === undefined) return [exposed]
  // A login's entry is the model's, not the alias target's: carry the target's effort (#230).
  const effort = reasoningEffort === undefined ? {} : { reasoningEffort }
  return logins.map((login) => ({ ...login, logins, ...effort }))
}

/**
 * Plans the models a request may run on: the resolved model alone, or an alias's chain, each
 * under every login that may serve it.
 *
 * @remarks
 * An image request skips the chain's text-only models when another one takes images; with none,
 * it keeps the whole chain. A per-request upstream key keeps the first target only, with no
 * fallback and no login expansion: the key is the client's own, so no login of the proxy's is
 * chosen.
 *
 * @param resolved - the exposed model or alias the request named
 * @param request - the validated request
 * @param upstreamApiKey - the `X-Switchboard-Upstream-Api-Key` value, or `undefined`
 * @param loginFallbackOn - `routing.logins.fallbackOn`
 * @returns the candidates, never empty, and the failures that move between them
 */
export function planRoute(
  resolved: ExposedModel,
  request: ChatCompletionRequest,
  upstreamApiKey: string | undefined,
  loginFallbackOn: readonly FailureClass[]
): ChatRoute {
  const chain = resolved.route
  const targets = chain === undefined ? [resolved] : chain.candidates
  const [first] = targets
  if (upstreamApiKey !== undefined && first !== undefined) {
    if (chain !== undefined) {
      chatLogger.debug('No fallback for {alias}: the request carries its own upstream key', {
        alias: resolved.alias
      })
    }
    return { candidates: [first], fallbackOn: new Set(), loginFallbackOn: new Set() }
  }
  const imageCapable = targets.filter((candidate) => candidate.model.input.includes('image'))
  const skipTextOnly = hasImage(request) && imageCapable.length > 0
  if (skipTextOnly && imageCapable.length < targets.length) {
    chatLogger.debug('Skipping {skippedCount} text-only models of {alias} for an image request', {
      alias: resolved.alias,
      skippedCount: targets.length - imageCapable.length
    })
  }
  return {
    candidates: (skipTextOnly ? imageCapable : targets).flatMap(perLogin),
    fallbackOn: new Set(chain?.fallbackOn ?? []),
    loginFallbackOn: new Set(loginFallbackOn)
  }
}
