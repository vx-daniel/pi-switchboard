/**
 * Converts OpenAI chat messages into a pi Context.
 *
 * @remarks
 * - `system` and `developer` messages before the first conversation turn: the system prompt
 * - later `system` and `developer` messages: pi SystemMessages in place (#45)
 * - text parts of a `system` or `developer` message: joined with blank lines, as separate
 *   messages are
 * - `user` text, or text and base64 image parts: pi UserMessage
 * - `assistant` text and tool calls: pi AssistantMessage history
 * - `tool`: pi ToolResultMessage
 * - unsupported content parts are rejected with a param path, and so are remote image URLs: with
 *   `remoteImages` on, the chat route has already replaced them with data URIs
 *   (`@proxy/openai/remote-images`), so any left mean the setting is off
 *
 * @packageDocumentation
 */

import type {
  AssistantMessage,
  Context,
  ImageContent,
  JsonObject,
  Message,
  TextContent,
  ToolCall,
  ToolResultMessage,
  UserMessage
} from '@earendil-works/pi-ai'
import { proxyLogger } from '@proxy/logging'
import type { OpenAIMessage } from '@proxy/openai/schemas'
import * as z from 'zod'

/** Logger for message conversion. */
const messagesLogger = proxyLogger('openai', 'messages')

/** Tool-call arguments: a JSON object (pi types them as `JsonObject`), not arbitrary values. */
const toolArgsSchema = z.record(z.string().trim(), z.json())

/** Successful conversion: the pi Context. */
export interface ConversionSuccess {
  readonly ok: true
  readonly context: Context
}

/** Failed conversion: why, and the request path of the offending field. */
export interface ConversionError {
  readonly ok: false
  readonly message: string
  readonly param: string
}

/** Outcome of {@link convertMessages}, discriminated on `ok`. */
export type ConversionResult = ConversionSuccess | ConversionError

/** The content of a system or developer message, as the request schema accepts it. */
type InstructionContent = Extract<OpenAIMessage, { role: 'system' | 'developer' }>['content']

/**
 * The text of a system or developer message. Its parts are joined with blank lines, the same
 * separator as between leading messages: a client that splits its instructions into parts (one per
 * block, as docker-agent does) means separate blocks, not one run-on paragraph. A part that is
 * only whitespace is left out, so it adds no stray blank lines (text is no longer trimmed, #145).
 *
 * @param content - the message's string or text parts
 * @returns the instruction text
 */
function instructionText(content: InstructionContent): string {
  if (typeof content === 'string') return content
  return content
    .map((part) => part.text)
    .filter((partText) => partText.trim().length > 0)
    .join('\n\n')
}

/**
 * Converts an OpenAI messages array into a pi Context.
 *
 * @remarks
 * System and developer messages before the first conversation turn are joined with blank lines
 * into `systemPrompt`. A later one stays where the client put it, as a pi SystemMessage: pi keeps
 * it in place on models that accept mid-conversation instructions
 * (`supportsMidConvoSystemMessages`) and merges it into the leading prompt for the others.
 * Conversation messages are mapped to pi message types.
 *
 * @param messages - the request's `messages`
 * @returns the Context, or the first conversion error (a rejected user content part)
 */
export function convertMessages(messages: OpenAIMessage[]): ConversionResult {
  const systemParts: string[] = []
  const piMessages: Message[] = []
  const roleCounts = { system: 0, developer: 0, user: 0, assistant: 0, tool: 0 }
  let laterSystemCount = 0

  const toolCallNames = collectToolCallNames(messages)

  for (const [messageIndex, message] of messages.entries()) {
    roleCounts[message.role]++

    if (message.role === 'system' || message.role === 'developer') {
      const text = instructionText(message.content)
      // Content is kept as sent (#145), so a blank instruction ("" or only whitespace) is no
      // longer trimmed to "". It says nothing, and Anthropic refuses a blank system prompt, so it
      // is skipped.
      if (text.trim().length === 0) continue
      if (piMessages.length === 0) {
        systemParts.push(text)
      } else {
        piMessages.push({ role: 'system', content: text, timestamp: Date.now() })
        laterSystemCount++
      }
      continue
    }

    const converted = convertConversationMessage(message, messageIndex, toolCallNames)
    if (!converted.ok) return converted
    piMessages.push(converted.message)
  }

  const context: Context = {
    messages: piMessages
  }

  if (systemParts.length > 0) {
    context.systemPrompt = systemParts.join('\n\n')
  }

  messagesLogger.debug(
    'Converted {messageCount} messages to {piMessageCount} pi messages: {systemPartCount} system/developer parts in the prompt, {laterSystemCount} kept in place',
    {
      messageCount: messages.length,
      piMessageCount: piMessages.length,
      systemPartCount: systemParts.length,
      laterSystemCount,
      systemPromptChars: context.systemPrompt?.length ?? 0,
      roleCounts
    }
  )

  return { ok: true, context }
}

/**
 * Maps each tool_call_id in the assistant messages to its function name.
 *
 * @remarks
 * An OpenAI tool message only has `tool_call_id` and content, but some providers (Google)
 * require the function name on tool results.
 *
 * @param messages - the request's `messages`
 * @returns tool_call_id to function name; a repeated ID keeps the last name
 */
function collectToolCallNames(messages: OpenAIMessage[]): Map<string, string> {
  const toolCallNames = new Map<string, string>()
  for (const message of messages) {
    if (message.role === 'assistant' && 'tool_calls' in message) {
      for (const tc of message.tool_calls ?? []) {
        toolCallNames.set(tc.id, tc.function.name)
      }
    }
  }
  return toolCallNames
}

// --- Internal converters ---

/** Outcome of converting one user message. */
type UserConversionResult = { readonly ok: true; readonly message: UserMessage } | ConversionError

/** Outcome of converting one conversation message. */
type MessageConversionResult = { readonly ok: true; readonly message: Message } | ConversionError

/** An OpenAI message that is a conversation turn rather than a system or developer instruction. */
type ConversationMessage = Exclude<OpenAIMessage, { role: 'system' | 'developer' }>

/**
 * Converts one user, assistant or tool message into its pi message.
 *
 * @param message - the conversation message
 * @param messageIndex - its index in `messages`, for error paths and logs
 * @param toolCallNames - tool_call_id to function name, from {@link collectToolCallNames}
 * @returns the pi message, or the error for a user message with a rejected part; a tool message
 *   whose call is unknown gets an empty tool name
 */
function convertConversationMessage(
  message: ConversationMessage,
  messageIndex: number,
  toolCallNames: ReadonlyMap<string, string>
): MessageConversionResult {
  if (message.role === 'user') return convertUserMessage(message.content, messageIndex)
  if (message.role === 'assistant') {
    return {
      ok: true,
      message: convertAssistantMessage(message.content ?? null, message.tool_calls)
    }
  }
  const toolName = toolCallNames.get(message.tool_call_id)
  if (toolName === undefined) {
    messagesLogger.debug(
      'Tool message {messageIndex} answers unknown tool call {toolCallId}; sending an empty tool name',
      { messageIndex, toolCallId: message.tool_call_id }
    )
  }
  return {
    ok: true,
    message: convertToolMessage(message.content, message.tool_call_id, toolName ?? '')
  }
}

/** User message content: a string or content parts. */
type UserContent = string | { type: string; text?: string; image_url?: { url: string } }[]

/** One content part of a multi-part user message. */
type UserContentPart = Exclude<UserContent, string>[number]

/** Outcome of converting one user content part. */
type PartConversionResult =
  | { readonly ok: true; readonly part: TextContent | ImageContent }
  | ConversionError

/**
 * Converts a user message's content into a pi UserMessage.
 *
 * @param content - a string, or content parts
 * @param index - the message's index in `messages`, for error paths and logs
 * @returns the pi message, or the error for the first rejected part
 */
function convertUserMessage(content: UserContent, index: number): UserConversionResult {
  if (typeof content === 'string') {
    return {
      ok: true,
      message: {
        role: 'user',
        content,
        timestamp: Date.now()
      }
    }
  }

  // Multi-part content
  const parts: (TextContent | ImageContent)[] = []

  for (const [partIndex, part] of content.entries()) {
    const converted = convertContentPart(part, index, partIndex)
    if (!converted.ok) return converted
    parts.push(converted.part)
  }

  messagesLogger.trace(
    'User message {messageIndex} has {partCount} content parts, {imageCount} images',
    {
      messageIndex: index,
      partCount: parts.length,
      imageCount: parts.filter((contentPart) => contentPart.type === 'image').length
    }
  )

  return {
    ok: true,
    message: {
      role: 'user',
      content: parts,
      timestamp: Date.now()
    }
  }
}

/**
 * Converts one part of a multi-part user message into a pi text or image part.
 *
 * @param part - the content part
 * @param messageIndex - the message's index in `messages`
 * @param partIndex - the part's index in the message content
 * @returns the pi part, or the error for an unsupported part type or a rejected image
 */
function convertContentPart(
  part: UserContentPart,
  messageIndex: number,
  partIndex: number
): PartConversionResult {
  if (part.type === 'text') return { ok: true, part: { type: 'text', text: part.text ?? '' } }
  if (part.type === 'image_url') {
    return convertImagePart(part.image_url?.url ?? '', messageIndex, partIndex)
  }
  messagesLogger.warn(
    'Rejected unsupported content part type {partType} at messages[{messageIndex}].content[{partIndex}]',
    { partType: part.type, messageIndex, partIndex }
  )
  return {
    ok: false,
    message: `Unsupported content part type: '${part.type}'`,
    param: `messages[${String(messageIndex)}].content[${String(partIndex)}].type`
  }
}

/**
 * Converts an image part's URL into a pi image part.
 *
 * Only base64 data URIs are accepted. A remote URL reaching this point is rejected: with the
 * `remoteImages` setting on, the chat route has already downloaded each one and put a data URI in
 * its place, so a remote URL here means the setting is off.
 *
 * @param url - the `image_url.url` value
 * @param messageIndex - the message's index in `messages`
 * @param partIndex - the part's index in the message content
 * @returns the pi image part, or the error for a non-data URL or an invalid data URI
 */
function convertImagePart(
  url: string,
  messageIndex: number,
  partIndex: number
): PartConversionResult {
  const param = `messages[${String(messageIndex)}].content[${String(partIndex)}].image_url.url`
  if (!url.startsWith('data:')) {
    messagesLogger.warn(
      'Blocked remote image from {host} at messages[{messageIndex}].content[{partIndex}]: remote images are disabled',
      { host: imageUrlHost(url), messageIndex, partIndex }
    )
    return {
      ok: false,
      message:
        'Remote image URLs are disabled on this proxy (the remoteImages setting is off). Use base64 data URIs instead.',
      param
    }
  }

  const result = parseAndValidateDataUri(url)
  if (!result.ok) {
    messagesLogger.warn(
      'Rejected image at messages[{messageIndex}].content[{partIndex}]: {reason}',
      { messageIndex, partIndex, reason: result.message, uriChars: url.length }
    )
    return {
      ok: false,
      message: `${result.message} at messages[${String(messageIndex)}].content[${String(partIndex)}]`,
      param
    }
  }

  messagesLogger.debug(
    'Image part at messages[{messageIndex}].content[{partIndex}]: {mimeType}, {base64Chars} base64 chars',
    {
      messageIndex,
      partIndex,
      mimeType: result.parsed.mimeType,
      base64Chars: result.parsed.data.length
    }
  )
  return {
    ok: true,
    part: { type: 'image', data: result.parsed.data, mimeType: result.parsed.mimeType }
  }
}

/** An assistant tool call as it appears in request history. */
interface OpenAIToolCallInput {
  readonly id: string
  readonly type: 'function'
  readonly function: { readonly name: string; readonly arguments: string }
}

/**
 * Converts a history assistant message into a pi AssistantMessage.
 *
 * @remarks
 * Arguments that are not a JSON object become `{}`, with a warning. The message gets
 * placeholder metadata (`provider: 'proxy'`, `model: 'history'`, zero usage).
 *
 * @param textContent - the message text; `null` or empty adds no text part
 * @param toolCalls - the message's tool calls, if any
 * @returns the pi message
 */
function convertAssistantMessage(
  textContent: string | null,
  toolCalls: OpenAIToolCallInput[] | undefined
): AssistantMessage {
  const content: (TextContent | ToolCall)[] = []

  if (textContent !== null && textContent.length > 0) {
    content.push({ type: 'text', text: textContent })
  }

  if (toolCalls !== undefined) {
    for (const tc of toolCalls) {
      let args: JsonObject = {}
      try {
        const parsed = toolArgsSchema.safeParse(JSON.parse(tc.function.arguments))
        if (parsed.success) {
          args = parsed.data
        } else {
          messagesLogger.warn(
            'Arguments of history tool call {toolCallId} ({toolName}) are not a JSON object; sending empty arguments',
            { toolCallId: tc.id, toolName: tc.function.name }
          )
        }
      } catch {
        // Best-effort: keep empty args when the arguments are not valid JSON
        messagesLogger.warn(
          'Arguments of history tool call {toolCallId} ({toolName}) are not valid JSON; sending empty arguments',
          {
            toolCallId: tc.id,
            toolName: tc.function.name,
            argumentsChars: tc.function.arguments.length
          }
        )
      }
      content.push({
        type: 'toolCall',
        id: tc.id,
        name: tc.function.name,
        arguments: args
      })
    }
  }

  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'proxy',
    model: 'history',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: 'stop',
    timestamp: Date.now()
  }
}

/**
 * Converts an OpenAI tool message into a pi ToolResultMessage (never marked as an error).
 *
 * @param content - the tool output text
 * @param toolCallId - the call it answers
 * @param toolName - the call's function name, or `''` when unknown
 * @returns the pi tool result
 */
function convertToolMessage(
  content: string,
  toolCallId: string,
  toolName: string
): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId,
    toolName,
    content: [{ type: 'text', text: content }],
    isError: false,
    timestamp: Date.now()
  }
}

// --- Helpers ---

/**
 * Returns the host of a remote image URL, for logs: never the path or query, which may carry
 * tokens.
 *
 * @param url - the image URL
 * @returns the host, or `(unparseable URL)`
 */
export function imageUrlHost(url: string): string {
  return URL.canParse(url) ? new URL(url).host : '(unparseable URL)'
}

/** Supported image MIME types, for base64 data URIs and fetched remote images. */
export const SUPPORTED_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp'
])

/** Bytes per kilobyte. */
const BYTES_PER_KILOBYTE = 1024
/** Bytes per megabyte. */
const BYTES_PER_MEGABYTE = BYTES_PER_KILOBYTE * BYTES_PER_KILOBYTE
/** Maximum base64 payload size in megabytes. */
const MAX_BASE64_PAYLOAD_MEGABYTES = 20
/** Maximum base64 payload length in characters (20 MiB of base64 text, about 15 MiB decoded). */
export const MAX_BASE64_PAYLOAD_SIZE = MAX_BASE64_PAYLOAD_MEGABYTES * BYTES_PER_MEGABYTE

/** The MIME type and base64 payload of a data URI. */
interface ParsedDataUri {
  readonly data: string
  readonly mimeType: string
}

/** A rejected data URI and why. */
interface DataUriError {
  readonly ok: false
  readonly message: string
}

/** A valid data URI, parsed. */
interface DataUriSuccess {
  readonly ok: true
  readonly parsed: ParsedDataUri
}

/** Outcome of {@link parseAndValidateDataUri}. */
type DataUriResult = DataUriSuccess | DataUriError

/**
 * Parses a base64 image data URI and checks its MIME type and size.
 *
 * @param uri - a URI starting with `data:`
 * @returns the MIME type and payload, or the error for a malformed URI, an unsupported MIME type
 *   or a payload over {@link MAX_BASE64_PAYLOAD_SIZE} characters
 */
function parseAndValidateDataUri(uri: string): DataUriResult {
  // Accepts only data:<mediatype>;base64,<data>
  const match = /^data:([^;]+);base64,(.+)$/.exec(uri)
  if (match === null) {
    return { ok: false, message: 'Invalid base64 data URI format' }
  }
  const mimeType = match[1]
  const data = match[2]
  if (mimeType === undefined || data === undefined) {
    return { ok: false, message: 'Invalid base64 data URI format' }
  }

  // Reject unsupported MIME types
  if (!SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
    return {
      ok: false,
      message: `Unsupported image MIME type '${mimeType}'. Supported: ${[...SUPPORTED_IMAGE_MIME_TYPES].join(', ')}`
    }
  }

  // Reject oversized payloads
  if (data.length > MAX_BASE64_PAYLOAD_SIZE) {
    return {
      ok: false,
      message: `Image data exceeds the maximum of ${String(MAX_BASE64_PAYLOAD_SIZE)} base64 characters`
    }
  }

  return { ok: true, parsed: { data, mimeType } }
}
