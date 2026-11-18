/**
 * SDK conformance: tool schemas as the client wrote them, on every provider family (#360).
 *
 * Since #360 a tool's `parameters` reach the provider as written: an `enum` and a nullable
 * `type: ["string", "null"]` are no longer rewritten as `anyOf` unions. This calls one model of
 * each family with such a tool and `tool_choice: "required"`, so a provider that refuses the schema,
 * or a model that cannot follow it, fails here. A family without a login is skipped, and says so.
 * Not a named choice: on Codex that fails for another reason (#365).
 */

import { isRecord } from '@proxy/utils/guards'
import type OpenAI from 'openai'
import { assert, describe, expect, test } from 'vite-plus/test'

import { createTestClient, getTestModels, setup } from './helpers'

/** The provider families the check covers, as the matrix's provider prefixes. */
const FAMILIES = ['anthropic', 'google', 'openai-codex', 'openai'] as const

const UNITS = ['celsius', 'fahrenheit']

const thermostatTool: OpenAI.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'set_thermostat',
    description: 'Set the thermostat of one room, or of the whole house',
    parameters: {
      type: 'object',
      properties: {
        unit: { type: 'string', enum: UNITS, description: 'Temperature unit' },
        room: {
          type: ['string', 'null'],
          description: 'The room, or null for the whole house'
        },
        target: { type: 'number', description: 'Target temperature' }
      },
      required: ['unit', 'room', 'target']
    }
  }
}

/**
 * Picks the family's model for the check: its first available mid-tier model, else its first.
 *
 * @param family - the provider prefix, such as `anthropic`
 * @returns the canonical model ID, or `undefined` when the family has no available test model
 */
function familyModel(family: string): string | undefined {
  const models = getTestModels().filter((model) => model.id.startsWith(`${family}/`))
  return (models.find((model) => model.category === 'mid') ?? models[0])?.id
}

describe('SDK tool schema conformance (#360)', () => {
  test.for(FAMILIES)(
    '%s accepts an enum and a nullable field, and the call follows them',
    async (family, { skip }) => {
      const modelId = familyModel(family)
      if (modelId === undefined) {
        skip(`no ${family} login with a test model`)
        return
      }

      const client = createTestClient(setup().app)
      const completion = await client.chat.completions.create({
        model: modelId,
        messages: [{ role: 'user', content: 'Set the whole house to 21 degrees celsius.' }],
        tools: [thermostatTool],
        tool_choice: 'required',
        max_completion_tokens: 256
      })

      const call = completion.choices[0]?.message.tool_calls?.[0]
      assert(call?.type === 'function', `${modelId} made no function call`)
      expect(call.function.name).toBe('set_thermostat')
      const args: unknown = JSON.parse(call.function.arguments)
      expect(args).toMatchObject({ unit: expect.toBeOneOf(UNITS) })
      const room = isRecord(args) ? args['room'] : undefined
      expect(room === null || typeof room === 'string').toBe(true)
    }
  )
})
