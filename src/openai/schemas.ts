/**
 * Zod schemas for the subset of the OpenAI chat-completions request the proxy accepts.
 *
 * @remarks
 * Accepted top-level fields:
 * - Core: model, messages, stream, temperature, max_tokens, max_completion_tokens, stop, user,
 *   stream_options
 * - Tools: tools, tool_choice, parallel_tool_calls
 * - Model control: reasoning_effort, top_p, frequency_penalty, presence_penalty, seed,
 *   response_format
 * - Client interop (accepted, not interpreted): metadata, prediction
 *
 * Unknown top-level fields fail the strict schema (422 in `validate.ts`). Explicitly rejected
 * with a named error: n, logprobs, top_logprobs, logit_bias, functions, function_call.
 *
 * @packageDocumentation
 */

import { textSchema } from '@proxy/openai/text-schemas'
import * as z from 'zod'

// --- Message content parts ---

/**
 * OpenAI's `prompt_cache_breakpoint` on a content part (`PromptCacheBreakpointParam`): it marks the
 * exact end of a reusable prompt prefix. Forwarded where the API has a slot for it (OpenAI's own
 * chat completions and Responses); dropped, and logged, everywhere else (`src/pi/cache-breakpoints.ts`).
 */
const promptCacheBreakpointSchema = z.object({ mode: z.literal('explicit') }).strict()

/** A parsed `prompt_cache_breakpoint`. */
export type PromptCacheBreakpoint = z.infer<typeof promptCacheBreakpointSchema>

// Every message and part schema is strict, as the request is (#146): a field OpenAI defines that
// the proxy does not take, or one OpenAI does not define, gets a named 422 instead of being
// dropped. The two OpenAI fields pi has no equivalent for, `name` on a message and
// `image_url.detail`, are accepted and dropped, as constitution principle I lists them.

/**
 * A `text` content part of a user, system or developer message. docker-agent puts a
 * `prompt_cache_breakpoint` on each system part it sends a `gpt-*` model.
 */
const textContentPartSchema = z
  .object({
    type: z.literal('text'),
    text: textSchema,
    prompt_cache_breakpoint: promptCacheBreakpointSchema.optional()
  })
  .strict()

/** An `image_url` content part of a user message; `detail` is accepted and dropped. */
const imageUrlContentPartSchema = z
  .object({
    type: z.literal('image_url'),
    image_url: z
      .object({
        url: z.string().trim(),
        detail: z.enum(['auto', 'low', 'high']).optional()
      })
      .strict(),
    prompt_cache_breakpoint: promptCacheBreakpointSchema.optional()
  })
  .strict()

/** A user-message content part: text or image URL. */
const contentPartSchema = z.discriminatedUnion('type', [
  textContentPartSchema,
  imageUrlContentPartSchema
])

// --- Messages ---

/**
 * The content of a `system` or `developer` message: a string, or text parts, which OpenAI's chat
 * completions API accepts in place of one. docker-agent sends parts for `gpt-*` models and a
 * string for Claude ones.
 */
const instructionContentSchema = z.union([textSchema, z.array(textContentPartSchema).min(1)])

/** A message's `name`: OpenAI's participant name. Accepted and dropped, as pi has no equivalent. */
const participantNameSchema = z.string().trim().optional()

/** A `system` message with string or text-part content. */
const systemMessageSchema = z
  .object({
    role: z.literal('system'),
    content: instructionContentSchema,
    name: participantNameSchema
  })
  .strict()

/** A `developer` message with string or text-part content. */
const developerMessageSchema = z
  .object({
    role: z.literal('developer'),
    content: instructionContentSchema,
    name: participantNameSchema
  })
  .strict()

/** A `user` message: string content, or an array of text and image parts. */
const userMessageSchema = z
  .object({
    role: z.literal('user'),
    content: z.union([textSchema, z.array(contentPartSchema)]),
    name: participantNameSchema
  })
  .strict()

/**
 * An `assistant` message: optional (nullable) text content and optional function tool calls.
 * `refusal` and `audio` are accepted only as `null`, which SDKs send when they echo a reply back
 * in history; a value is refused with a named 422 (`chatRequestRejection`), as pi has nowhere to
 * put it.
 */
const assistantMessageSchema = z
  .object({
    role: z.literal('assistant'),
    content: textSchema.nullable().optional(),
    name: participantNameSchema,
    refusal: z.null().optional(),
    audio: z.null().optional(),
    tool_calls: z
      .array(
        z
          .object({
            id: z.string().trim(),
            type: z.literal('function'),
            function: z.object({ name: z.string().trim(), arguments: z.string().trim() }).strict()
          })
          .strict()
      )
      .optional()
  })
  .strict()

/** A `tool` message carrying the result for one `tool_call_id`. */
const toolMessageSchema = z
  .object({
    role: z.literal('tool'),
    content: textSchema,
    tool_call_id: z.string().trim()
  })
  .strict()

/**
 * Any accepted chat message, told apart by `role`, so an invalid field is reported at its own
 * path (`messages.2.refusal`) rather than at the message.
 */
const messageSchema = z.discriminatedUnion('role', [
  systemMessageSchema,
  developerMessageSchema,
  userMessageSchema,
  assistantMessageSchema,
  toolMessageSchema
])

/** A chat message as accepted by {@link chatCompletionRequestSchema}. */
export type OpenAIMessage = z.infer<typeof messageSchema>

// --- Stream options ---

/** The `stream_options` object; only `include_usage` is accepted. */
const streamOptionsSchema = z.object({
  include_usage: z.boolean().optional()
})

// --- Function tool definition ---

/**
 * OpenAI function tool definition.
 *
 * @remarks
 * `parameters` is only checked to be an object here; conversion to TypeBox happens in
 * `json-schema-to-typebox.ts`.
 */
const functionToolSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string().trim(),
    description: z.string().trim().optional(),
    parameters: z.record(z.string().trim(), z.unknown()).optional(),
    strict: z.boolean().nullable().optional()
  })
})

/** A function tool definition as accepted in the request `tools` array. */
export type OpenAIFunctionTool = z.infer<typeof functionToolSchema>

// --- Tool choice ---

/** A named `tool_choice`: `{ type: "function", function: { name } }`. */
const namedToolChoiceSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string().trim()
  })
})

/** The `tool_choice` field: `"none"`, `"auto"`, `"required"`, or a named function. */
const toolChoiceSchema = z.union([z.enum(['none', 'auto', 'required']), namedToolChoiceSchema])

// --- Response format ---

/** A `json_schema` response format with its name, optional schema and `strict` flag. */
const jsonSchemaResponseFormatSchema = z.object({
  type: z.literal('json_schema'),
  json_schema: z.object({
    name: z.string().trim(),
    description: z.string().trim().optional(),
    schema: z.record(z.string().trim(), z.unknown()).optional(),
    strict: z.boolean().nullable().optional()
  })
})

/** The `response_format` field: `text`, `json_object` or `json_schema`. */
const responseFormatSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text') }),
  z.object({ type: z.literal('json_object') }),
  jsonSchemaResponseFormatSchema
])

/** Upper bound of `temperature`. */
const MAX_TEMPERATURE = 2
/** Maximum number of `stop` sequences. */
const MAX_STOP_SEQUENCES = 4
/** Lower bound of `frequency_penalty` and `presence_penalty`. */
const MIN_PENALTY = -2
/** Upper bound of `frequency_penalty` and `presence_penalty`. */
const MAX_PENALTY = 2

/**
 * Longest `prompt_cache_key` accepted: pi-ai's `OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH` (1.3.0), which
 * its root entry point does not export.
 */
const PROMPT_CACHE_KEY_MAX_LENGTH = 64

/** OpenAI's `reasoning_effort` values, lowest first (OpenAI's `ReasoningEffort` schema, #132). */
export const REASONING_EFFORTS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
] as const
/** One of the {@link REASONING_EFFORTS} values. */
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

// --- Top-level request ---

/** Strict schema for a chat-completions request body; unknown top-level keys fail parsing. */
export const chatCompletionRequestSchema = z
  .object({
    model: z.string().trim(),
    messages: z.array(messageSchema).min(1),
    stream: z.boolean().optional(),
    temperature: z.number().min(0).max(MAX_TEMPERATURE).optional(),
    max_tokens: z.int().positive().optional(),
    max_completion_tokens: z.int().positive().optional(),
    stop: z.union([textSchema, z.array(textSchema).max(MAX_STOP_SEQUENCES)]).optional(),
    user: z.string().trim().optional(),
    stream_options: streamOptionsSchema.nullable().optional(),
    // Tools and model control
    tools: z.array(functionToolSchema).optional(),
    tool_choice: toolChoiceSchema.optional(),
    parallel_tool_calls: z.boolean().optional(),
    reasoning_effort: z.enum(REASONING_EFFORTS).optional(),
    top_p: z.number().min(0).max(1).optional(),
    frequency_penalty: z.number().min(MIN_PENALTY).max(MAX_PENALTY).optional(),
    presence_penalty: z.number().min(MIN_PENALTY).max(MAX_PENALTY).optional(),
    seed: z.int().optional(),
    response_format: responseFormatSchema.optional(),
    // Prompt caching: becomes pi's `sessionId` (`buildStreamOptions`), which pi sends as the
    // provider's cache or session key where it has one (#39). At most 64 characters because pi
    // cuts a longer key to 64 itself, silently merging keys that share their first 64.
    prompt_cache_key: z
      .string()
      .trim()
      .min(1)
      .max(PROMPT_CACHE_KEY_MAX_LENGTH)
      .nullable()
      .optional(),
    // Passthrough fields sent by real clients; accepted but not interpreted
    metadata: z.record(z.string().trim(), z.unknown()).optional(),
    prediction: z
      .object({
        type: z.literal('content'),
        content: z.union([
          textSchema,
          z.array(z.object({ type: z.literal('text'), text: textSchema }))
        ])
      })
      .optional()
  })
  .strict()

/** A parsed chat-completions request body. */
export type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>

// --- Rejected fields ---

/**
 * Fields rejected with a named 422 error instead of the generic unknown-parameter error.
 *
 * @remarks
 * `n`, `logprobs`, `top_logprobs`, `logit_bias`: the proxy returns a single choice with no
 * token probability data, so accepting these would need response-side changes.
 *
 * `functions`, `function_call`: deprecated OpenAI fields, superseded by `tools` and
 * `tool_choice`.
 */
export const rejectedFields = [
  'n',
  'logprobs',
  'top_logprobs',
  'logit_bias',
  'functions',
  'function_call'
] as const
