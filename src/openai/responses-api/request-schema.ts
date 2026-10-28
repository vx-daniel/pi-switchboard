/**
 * Zod schemas for the subset of OpenAI's Responses API request (`CreateResponse`) the proxy
 * accepts, stateless (#140).
 *
 * @remarks
 * Accepted: `model`, `input` (a string, or `message`, `function_call`, `function_call_output` and
 * `reasoning` items), `instructions`, function `tools`, `tool_choice`, `parallel_tool_calls`,
 * `temperature`, `top_p`, `max_output_tokens`, `reasoning` (`effort`, and `summary` as `auto`),
 * `text.format`, `stream`, `stream_options` (no obfuscation), `metadata`, `user`,
 * `prompt_cache_key`, `store` (`false` only: nothing is stored) and `include`
 * (`reasoning.encrypted_content` only).
 *
 * Every object is strict, as chat completions' are: a field OpenAI defines that the proxy does not
 * take gets a named 422 ({@link RESPONSES_REJECTED_FIELDS} for the top level), and one OpenAI does
 * not define gets the unknown-parameter 422. The one field accepted and dropped is `detail` on an
 * `input_image`, the Responses form of chat's `image_url.detail` (constitution principle I).
 *
 * @packageDocumentation
 */

import {
  MAX_TEMPERATURE,
  promptCacheBreakpointSchema,
  promptCacheKeySchema,
  REASONING_EFFORTS,
  storeSchema
} from '@proxy/openai/schemas'
import { textSchema } from '@proxy/openai/text-schemas'
import * as z from 'zod'

// --- Content parts ---

/** An `input_text` part of a user, system or developer message. */
const inputTextPartSchema = z
  .object({
    type: z.literal('input_text'),
    text: textSchema,
    prompt_cache_breakpoint: promptCacheBreakpointSchema.optional()
  })
  .strict()

/**
 * An `input_image` part, by URL or data URI. `detail` is accepted and dropped, as chat's
 * `image_url.detail` is: pi has no equivalent. `file_id` needs OpenAI's file store.
 */
const inputImagePartSchema = z
  .object({
    type: z.literal('input_image'),
    image_url: z.string().trim(),
    detail: z.enum(['auto', 'low', 'high', 'original']).optional(),
    prompt_cache_breakpoint: promptCacheBreakpointSchema.optional()
  })
  .strict()

/**
 * An `output_text` part of an assistant message the client sends back. The response-only
 * `annotations` and `logprobs` are accepted empty, as the proxy sends them.
 */
const outputTextPartSchema = z
  .object({
    type: z.literal('output_text'),
    text: textSchema,
    annotations: z.tuple([]).optional(),
    logprobs: z.tuple([]).optional()
  })
  .strict()

// --- Input items ---

/** An item's `status`, which the client echoes on items the proxy sent. */
const itemStatusSchema = z.enum(['in_progress', 'completed', 'incomplete']).nullable().optional()

/** A `user` message: a string, or text and image parts. */
const userMessageSchema = z
  .object({
    type: z.literal('message').optional(),
    role: z.literal('user'),
    content: z.union([textSchema, z.array(z.union([inputTextPartSchema, inputImagePartSchema]))]),
    status: itemStatusSchema
  })
  .strict()

/** A `system` or `developer` message: a string, or text parts. */
const instructionMessageSchema = z
  .object({
    type: z.literal('message').optional(),
    role: z.enum(['system', 'developer']),
    content: z.union([textSchema, z.array(inputTextPartSchema)]),
    status: itemStatusSchema
  })
  .strict()

/** An `assistant` message: a string, or the `output_text` parts of an earlier response. */
const assistantMessageSchema = z
  .object({
    type: z.literal('message').optional(),
    role: z.literal('assistant'),
    id: z.string().trim().optional(),
    content: z.union([textSchema, z.array(outputTextPartSchema)]),
    status: itemStatusSchema
  })
  .strict()

/** A `function_call` item of an earlier response: the model called a client-side tool. */
const functionCallItemSchema = z
  .object({
    type: z.literal('function_call'),
    id: z.string().trim().optional(),
    call_id: z.string().trim(),
    name: z.string().trim(),
    arguments: z.string().trim(),
    status: itemStatusSchema
  })
  .strict()

/** A `function_call_output` item: the client's result for one `call_id`. */
const functionCallOutputItemSchema = z
  .object({
    type: z.literal('function_call_output'),
    id: z.string().trim().nullable().optional(),
    call_id: z.string().trim(),
    output: z.union([textSchema, z.array(inputTextPartSchema)]),
    status: itemStatusSchema
  })
  .strict()

/**
 * A `reasoning` item of an earlier response. Its `encrypted_content` is the proxy's token
 * (`reasoning-token.ts`), which replays the reasoning to the model that produced it.
 */
const reasoningItemSchema = z
  .object({
    type: z.literal('reasoning'),
    id: z.string().trim(),
    summary: z.array(z.object({ type: z.literal('summary_text'), text: textSchema }).strict()),
    content: z
      .array(z.object({ type: z.literal('reasoning_text'), text: textSchema }).strict())
      .optional(),
    encrypted_content: z.string().trim().nullable().optional(),
    status: itemStatusSchema
  })
  .strict()

/** One input item: a message, a function call, its output, or reasoning. */
const inputItemSchema = z.union([
  userMessageSchema,
  instructionMessageSchema,
  assistantMessageSchema,
  functionCallItemSchema,
  functionCallOutputItemSchema,
  reasoningItemSchema
])

/** One accepted input item. */
export type ResponsesInputItem = z.infer<typeof inputItemSchema>

// --- Tools, formats, reasoning ---

/** A function tool, in the Responses form (`name` at the top, not under `function`). */
const responsesFunctionToolSchema = z
  .object({
    type: z.literal('function'),
    name: z.string().trim(),
    description: z.string().trim().nullable().optional(),
    parameters: z.record(z.string().trim(), z.unknown()).nullable().optional(),
    strict: z.boolean().nullable().optional()
  })
  .strict()

/** `tool_choice`: a mode, or one function by name. */
const responsesToolChoiceSchema = z.union([
  z.enum(['none', 'auto', 'required']),
  z.object({ type: z.literal('function'), name: z.string().trim() }).strict()
])

/** `text.format`: plain text, JSON, or JSON matching a schema. */
const textFormatSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text') }).strict(),
  z.object({ type: z.literal('json_object') }).strict(),
  z
    .object({
      type: z.literal('json_schema'),
      name: z.string().trim(),
      description: z.string().trim().optional(),
      schema: z.record(z.string().trim(), z.unknown()),
      strict: z.boolean().nullable().optional()
    })
    .strict()
])

/**
 * `reasoning`: the effort, and a summary as `auto` (what pi asks OpenAI for); `concise` and
 * `detailed` would need a pi option the proxy has no way to pass.
 */
const reasoningConfigSchema = z
  .object({
    effort: z.enum(REASONING_EFFORTS).nullable().optional(),
    summary: z.literal('auto').nullable().optional()
  })
  .strict()

// --- Top-level request ---

/** Strict schema for a Responses API request body; unknown keys fail parsing. */
export const createResponseRequestSchema = z
  .object({
    model: z.string().trim(),
    input: z.union([textSchema, z.array(inputItemSchema).min(1)]),
    instructions: textSchema.nullable().optional(),
    stream: z.boolean().nullable().optional(),
    stream_options: z
      .object({ include_obfuscation: z.literal(false).optional() })
      .strict()
      .nullable()
      .optional(),
    tools: z.array(responsesFunctionToolSchema).optional(),
    tool_choice: responsesToolChoiceSchema.optional(),
    parallel_tool_calls: z.boolean().nullable().optional(),
    temperature: z.number().min(0).max(MAX_TEMPERATURE).nullable().optional(),
    top_p: z.number().min(0).max(1).nullable().optional(),
    max_output_tokens: z.int().positive().nullable().optional(),
    reasoning: reasoningConfigSchema.nullable().optional(),
    text: z.object({ format: textFormatSchema.optional() }).strict().optional(),
    metadata: z.record(z.string().trim(), z.string().trim()).nullable().optional(),
    user: z.string().trim().nullable().optional(),
    prompt_cache_key: promptCacheKeySchema,
    store: storeSchema,
    include: z.array(z.literal('reasoning.encrypted_content')).nullable().optional()
  })
  .strict()

/** A parsed Responses API request body. */
export type CreateResponseRequest = z.infer<typeof createResponseRequestSchema>

// --- Rejected fields ---

/**
 * The `CreateResponse` fields the proxy refuses with a named 422, and why: each needs state the
 * proxy does not keep, or a feature pi has no equivalent for.
 */
export const RESPONSES_REJECTED_FIELDS: Readonly<Record<string, string>> = {
  previous_response_id:
    'the proxy keeps no responses; send the conversation in `input`, with `include: ["reasoning.encrypted_content"]` to carry reasoning',
  conversation: 'the proxy keeps no conversations; send the conversation in `input`',
  background: 'the proxy keeps no responses to poll',
  prompt: 'the proxy has no stored prompts',
  top_logprobs: 'the proxy returns no token probabilities',
  service_tier: 'pi chooses no service tier',
  truncation: 'the proxy does not truncate input',
  max_tool_calls: 'pi runs no tools itself',
  context_management: 'the proxy does not compact context',
  moderation: 'the proxy runs no moderation',
  access_programs: 'pi has no access programs',
  safety_identifier: 'use `user`',
  prompt_cache_retention: 'pi chooses the cache retention',
  prompt_cache_options: 'pi chooses the cache options'
}
