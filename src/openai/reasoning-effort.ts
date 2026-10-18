/**
 * Maps OpenAI `reasoning_effort` values to pi's thinking levels.
 *
 * @remarks
 * OpenAI: "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
 * Pi: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
 *
 * "none" is pi's "off"; pi's "max" has no OpenAI effort. A model supports a subset of the levels
 * (`getSupportedThinkingLevels`): only "off" without reasoning, no "off" for a model that always
 * reasons, "xhigh" and "max" only when its definition maps them.
 *
 * @packageDocumentation
 */

import {
  type Api,
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Model,
  type ModelThinkingLevel
} from '@earendil-works/pi-ai'
import { REASONING_EFFORTS, type ReasoningEffort } from '@proxy/openai/schemas'

/** The pi thinking level each OpenAI effort asks for. */
const THINKING_LEVEL_BY_EFFORT: Readonly<Record<ReasoningEffort, ModelThinkingLevel>> = {
  none: 'off',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh'
}

/** The thinking level pi runs a model at for an effort, and whether it differs from the effort. */
export interface EffortLevel {
  readonly level: ModelThinkingLevel
  /** True when the model does not support the effort's own level. */
  readonly clamped: boolean
}

/**
 * Resolves the thinking level pi runs `model` at for an effort.
 *
 * @remarks
 * The effort's own level when the model supports it, otherwise pi's `clampThinkingLevel`: the
 * nearest supported level above it, else the nearest below. So "none" on a model that always
 * reasons is its lowest level, and any effort on a model without reasoning is "off".
 *
 * @param model - the pi model the request runs on
 * @param effort - the request's `reasoning_effort`
 * @returns the level pi uses, and whether it differs from the effort's own level
 */
export function thinkingLevelFor(model: Model<Api>, effort: ReasoningEffort): EffortLevel {
  const asked = THINKING_LEVEL_BY_EFFORT[effort]
  // clampThinkingLevel returns the level itself exactly when the model supports it.
  const level = clampThinkingLevel(model, asked)
  return { level, clamped: level !== asked }
}

/**
 * Lists the efforts `model` runs at as asked, without clamping.
 *
 * @param model - the pi model to inspect
 * @returns the supported efforts, lowest first; `["none"]` for a model without reasoning
 */
export function supportedReasoningEfforts(model: Model<Api>): ReasoningEffort[] {
  const levels = new Set(getSupportedThinkingLevels(model))
  return REASONING_EFFORTS.filter((effort) => levels.has(THINKING_LEVEL_BY_EFFORT[effort]))
}
