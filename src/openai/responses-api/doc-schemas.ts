/**
 * Schemas that document the Responses API's answers (#140) in the OpenAPI document; never parsed.
 * The answers themselves are checked against OpenAI's pinned spec
 * (`test/integration/openai-spec.test.ts`).
 *
 * @packageDocumentation
 */

import { REASONING_EFFORTS } from '@proxy/openai/schemas'
import * as z from 'zod'

/** One `output` item: a message, a function call, or reasoning. */
const outputItemSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('message'),
    id: z.string().trim(),
    role: z.literal('assistant'),
    status: z.enum(['in_progress', 'completed', 'incomplete']),
    content: z.array(
      z.object({
        type: z.literal('output_text'),
        text: z.string().trim(),
        annotations: z.array(z.unknown()),
        logprobs: z.array(z.unknown())
      })
    )
  }),
  z.object({
    type: z.literal('function_call'),
    id: z.string().trim(),
    call_id: z.string().trim().meta({ description: 'Send it back in `function_call_output`.' }),
    name: z.string().trim(),
    arguments: z.string().trim(),
    status: z.enum(['in_progress', 'completed', 'incomplete'])
  }),
  z.object({
    type: z.literal('reasoning'),
    id: z.string().trim(),
    summary: z.array(z.object({ type: z.literal('summary_text'), text: z.string().trim() })),
    encrypted_content: z
      .string()
      .trim()
      .optional()
      .meta({
        description:
          'With `include: ["reasoning.encrypted_content"]`: the token that replays this reasoning ' +
          'to the model that produced it, when sent back in `input`. base64url JSON, not ' +
          'encrypted by the proxy: the thinking text is readable in it.'
      })
  })
])

/** A `Response` object: documents the answer; never parsed. */
export const responseObjectSchema = z
  .object({
    id: z.string().trim(),
    object: z.literal('response'),
    created_at: z.int(),
    status: z.enum(['in_progress', 'completed', 'incomplete', 'failed']),
    error: z.object({ code: z.string().trim(), message: z.string().trim() }).nullable(),
    incomplete_details: z.object({ reason: z.literal('max_output_tokens') }).nullable(),
    model: z.string().trim().meta({ description: 'The canonical ID of the model that answered.' }),
    output: z.array(outputItemSchema),
    usage: z
      .object({
        input_tokens: z.int(),
        input_tokens_details: z.object({ cached_tokens: z.int(), cache_write_tokens: z.int() }),
        output_tokens: z.int(),
        output_tokens_details: z.object({ reasoning_tokens: z.int() }),
        total_tokens: z.int()
      })
      .nullable(),
    instructions: z.string().trim().nullable(),
    metadata: z.record(z.string(), z.string().trim()),
    parallel_tool_calls: z.boolean(),
    temperature: z.number().nullable(),
    top_p: z.number().nullable(),
    tool_choice: z.unknown(),
    tools: z.array(z.unknown()),
    reasoning: z
      .object({
        effort: z.enum(REASONING_EFFORTS).nullable(),
        summary: z.string().trim().nullable()
      })
      .nullable(),
    store: z.literal(false),
    x_pi: z.record(z.string(), z.unknown()).meta({
      description:
        "Not OpenAI's: pi's cost and cache counts, and the route, as on chat completions."
    })
  })
  .meta({ id: 'Response', description: 'A Responses API response (experimental, #140).' })

/** One server-sent event of a streamed response: documents the stream; never parsed. */
export const responseStreamEventSchema = z
  .object({
    type: z
      .string()
      .trim()
      .meta({
        description:
          '`response.created`, `response.in_progress`, `response.output_item.added`/`.done`, ' +
          '`response.content_part.added`/`.done`, `response.output_text.delta`/`.done`, ' +
          '`response.function_call_arguments.delta`/`.done`, ' +
          '`response.reasoning_summary_part.added`/`.done`, ' +
          '`response.reasoning_summary_text.delta`/`.done`, and one of `response.completed`, ' +
          '`response.incomplete` or `response.failed`.'
      }),
    sequence_number: z.int()
  })
  .loose()
  .meta({ id: 'ResponseStreamEvent', description: 'One event of a streamed response.' })
