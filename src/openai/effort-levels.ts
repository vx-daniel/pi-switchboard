/**
 * OpenAI's `reasoning_effort` values and pi's thinking levels, both ways, without loading pi.
 *
 * @remarks
 * "none" is pi's "off"; every other effort is the pi level of the same name. Model exposure, which
 * the pi extension loads inside pi's own process, needs these without a runtime import of pi
 * (#165): it is given pi's `getSupportedThinkingLevels` instead.
 *
 * @packageDocumentation
 */

import type { Api, Model, ModelThinkingLevel } from '@earendil-works/pi-ai'
import { REASONING_EFFORTS, type ReasoningEffort } from '@proxy/openai/schemas'

/** The pi thinking level each OpenAI effort asks for. */
export const THINKING_LEVEL_BY_EFFORT: Readonly<Record<ReasoningEffort, ModelThinkingLevel>> = {
  none: 'off',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max'
}

/** The OpenAI effort each pi thinking level is reported as: the inverse of the map above. */
export const EFFORT_BY_THINKING_LEVEL: Readonly<Record<ModelThinkingLevel, ReasoningEffort>> = {
  off: 'none',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max'
}

/** pi's `getSupportedThinkingLevels`: the thinking levels a model runs at as asked. */
export type ThinkingLevelsOf = (model: Model<Api>) => readonly ModelThinkingLevel[]

/**
 * Lists the efforts a model runs at as asked, from its thinking levels.
 *
 * @param levels - the model's supported thinking levels (pi's `getSupportedThinkingLevels`)
 * @returns the efforts, lowest first
 */
export function effortsOfLevels(levels: readonly ModelThinkingLevel[]): ReasoningEffort[] {
  return REASONING_EFFORTS.filter((effort) => levels.includes(THINKING_LEVEL_BY_EFFORT[effort]))
}
