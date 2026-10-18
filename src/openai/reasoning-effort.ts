/**
 * OpenAI `reasoning_effort` against pi's thinking levels.
 *
 * OpenAI: "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
 * Pi: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
 *
 * "none" is pi's "off"; pi's "max" has no OpenAI effort. A model supports a subset of the levels
 * (`getSupportedThinkingLevels`): no reasoning at all, no "off" for a model that always reasons,
 * "xhigh" and "max" only when its definition maps them.
 */

import {
  type Api,
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Model,
  type ModelThinkingLevel
} from '@earendil-works/pi-ai'
import { REASONING_EFFORTS, type ReasoningEffort } from '@proxy/openai/schemas'

const THINKING_LEVEL_BY_EFFORT: Readonly<Record<ReasoningEffort, ModelThinkingLevel>> = {
  none: 'off',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh'
}

/** The thinking level pi runs a model at for an effort, and whether it differs from the effort's. */
export interface EffortLevel {
  readonly level: ModelThinkingLevel
  /** True when the model does not support the effort's own level. */
  readonly clamped: boolean
}

/**
 * The thinking level pi runs `model` at for this effort: the effort's own level when the model
 * supports it, otherwise pi's `clampThinkingLevel`, the nearest supported level above it, else the
 * nearest below. So "none" on a model that always reasons is its lowest level, and any effort on a
 * model without reasoning is "off".
 */
export function thinkingLevelFor(model: Model<Api>, effort: ReasoningEffort): EffortLevel {
  const asked = THINKING_LEVEL_BY_EFFORT[effort]
  // clampThinkingLevel returns the level itself exactly when the model supports it.
  const level = clampThinkingLevel(model, asked)
  return { level, clamped: level !== asked }
}

/** The efforts `model` runs at as asked, without clamping, lowest first. */
export function supportedReasoningEfforts(model: Model<Api>): ReasoningEffort[] {
  const levels = new Set(getSupportedThinkingLevels(model))
  return REASONING_EFFORTS.filter((effort) => levels.has(THINKING_LEVEL_BY_EFFORT[effort]))
}
