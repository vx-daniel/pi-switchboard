/**
 * Converts OpenAI function tool definitions to pi `Tool` definitions.
 *
 * @remarks
 * Parameter schemas go through `json-schema-to-typebox`, which rejects unsupported JSON Schema
 * constructs. `tool_choice` is not converted here; `src/pi/payload-fields.ts` maps it per API.
 *
 * @packageDocumentation
 */

import {
  type ConstrainedSamplingConfig,
  type Tool,
  type TSchema,
  Type
} from '@earendil-works/pi-ai'
import { proxyLogger } from '@proxy/logging'
import { jsonSchemaToTypebox } from '@proxy/openai/json-schema-to-typebox'
import type { OpenAIFunctionTool } from '@proxy/openai/schemas'

/** Logger for tool conversion. */
const toolsLogger = proxyLogger('openai', 'tools')

/**
 * pi's constrained sampling for a tool sent with `strict: true`.
 *
 * @remarks
 * "prefer": strict wherever pi can make it so (the model is strict-capable and the schema fits
 * the provider's strict subset); otherwise the tool is sent without strict rather than the
 * request being refused. "require" would refuse every strict tool on the many models pi does not
 * mark strict-capable, breaking clients that send `strict: true` by default (#44).
 */
const STRICT_SAMPLING: ConstrainedSamplingConfig = { type: 'json_schema', strict: 'prefer' }

/** Successful conversion: the pi tools, in request order. */
export interface ToolConversionSuccess {
  readonly ok: true
  readonly tools: Tool[]
}

/** Failed conversion: why, and the request path of the offending schema node. */
export interface ToolConversionError {
  readonly ok: false
  readonly message: string
  readonly param: string
}

/** Outcome of {@link convertTools}, discriminated on `ok`. */
export type ToolConversionResult = ToolConversionSuccess | ToolConversionError

/**
 * Converts OpenAI function tool definitions to pi `Tool` definitions.
 *
 * @remarks
 * A tool without `parameters` gets an empty object schema and a missing `description` becomes
 * `''`. `strict: true` adds {@link STRICT_SAMPLING}. Stops at the first schema that fails to
 * convert.
 *
 * @param openaiTools - the request's `tools` array
 * @returns the pi tools, or the first conversion error with a path like
 *   `tools[0].function.parameters.city`
 */
export function convertTools(openaiTools: OpenAIFunctionTool[]): ToolConversionResult {
  const piTools: Tool[] = []

  for (let toolIndex = 0; toolIndex < openaiTools.length; toolIndex++) {
    const tool = openaiTools[toolIndex]
    if (tool === undefined) continue

    const fn = tool.function
    let parameters: TSchema

    if (fn.parameters === undefined) {
      // No parameters specified: empty object schema
      parameters = Type.Object({})
    } else {
      const result = jsonSchemaToTypebox(
        fn.parameters,
        `tools[${String(toolIndex)}].function.parameters`
      )
      if (!result.ok) {
        toolsLogger.warn('Rejected parameters schema of tool {toolName} at {path}: {reason}', {
          toolName: fn.name,
          toolIndex,
          path: result.path,
          reason: result.message
        })
        return {
          ok: false,
          message: result.message,
          param: result.path
        }
      }
      parameters = result.schema
    }

    piTools.push({
      name: fn.name,
      description: fn.description ?? '',
      parameters,
      // `strict: true` asks for strict schema adherence: pi makes the schema strict in each API's
      // own shape where it can (see STRICT_SAMPLING).
      ...(fn.strict === true ? { constrainedSampling: STRICT_SAMPLING } : {})
    })
  }

  toolsLogger.debug('Converted {toolCount} tools', () => ({
    toolCount: piTools.length,
    toolNames: piTools.map((tool) => tool.name),
    withoutParameters: openaiTools.filter((tool) => tool.function.parameters === undefined).length,
    strictToolCount: piTools.filter((tool) => tool.constrainedSampling !== undefined).length
  }))

  return { ok: true, tools: piTools }
}
