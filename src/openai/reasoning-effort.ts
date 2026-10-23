/**
 * Maps OpenAI `reasoning_effort` values to pi's thinking levels.
 *
 * @remarks
 * OpenAI: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
 * Pi: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
 *
 * "none" is pi's "off"; every other effort is the pi level of the same name
 * (`src/openai/effort-levels.ts`). A model supports a subset of the levels (`getSupportedThinkingLevels`): only "off" without reasoning, no "off" for
 * a model that always reasons, "xhigh" and "max" only when its definition maps them.
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
import {
  EFFORT_BY_THINKING_LEVEL,
  effortsOfLevels,
  THINKING_LEVEL_BY_EFFORT
} from '@proxy/openai/effort-levels'
import type { ReasoningEffort } from '@proxy/openai/schemas'

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
 * What a request asked for and what it ran at, as `x_pi.reasoning_effort` reports it (#175).
 *
 * @remarks
 * `applied` is the level the proxy asks pi for, in OpenAI's vocabulary. A pi adapter can still
 * translate it for the provider (a model's `thinkingLevelMap` may send `max` as `xhigh`).
 */
export interface EffortReport {
  /** The request's `reasoning_effort`, or `null` when it set none. */
  readonly requested: ReasoningEffort | null
  /**
   * The effort the model runs at: the alias target's when it sets one (#230), else `requested`
   * when the model supports it, else the clamped level.
   */
  readonly applied: ReasoningEffort
}

/**
 * Reports the effort a request runs at on a model.
 *
 * @param model - the pi model the request runs on
 * @param requested - the request's `reasoning_effort`, or `undefined` when it set none
 * @param forced - the effort the alias's target sets, replacing the request's (#230), or
 *   `undefined`; the model supports it, as exposure checked
 * @returns what was asked and what the model runs at, or `undefined` when neither sets an effort
 */
export function effortReport(
  model: Model<Api>,
  requested: ReasoningEffort | undefined,
  forced: ReasoningEffort | undefined
): EffortReport | undefined {
  const effort = forced ?? requested
  if (effort === undefined) return undefined
  return {
    requested: requested ?? null,
    applied: EFFORT_BY_THINKING_LEVEL[thinkingLevelFor(model, effort).level]
  }
}

/**
 * Lists the efforts `model` runs at as asked, without clamping.
 *
 * @param model - the pi model to inspect
 * @returns the supported efforts, lowest first; `["none"]` for a model without reasoning
 */
export function supportedReasoningEfforts(model: Model<Api>): ReasoningEffort[] {
  return effortsOfLevels(getSupportedThinkingLevels(model))
}
