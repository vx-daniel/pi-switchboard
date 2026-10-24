/**
 * The token a Responses API `reasoning` item carries as `encrypted_content` (#140): pi's thinking
 * block, so a stateless client can send it back and the model keeps its reasoning across turns.
 *
 * @remarks
 * pi replays a thinking block only to the model that produced it, and only with its signature
 * (pi-ai 1.3.0 `transformMessages`): for OpenAI's Responses APIs the signature is OpenAI's own
 * reasoning item, encrypted content included; for Anthropic it is the thinking signature. The
 * token is that block with the model it came from, base64url JSON. It is opaque to the client but
 * not encrypted by the proxy: it holds the thinking text the client already received, and OpenAI's
 * encrypted payload as OpenAI sent it. A token the client altered can only change what its own
 * conversation replays; a malformed one is refused with a 400.
 *
 * @packageDocumentation
 */

import type { Api, ThinkingContent } from '@earendil-works/pi-ai'
import { isRecord, parseJsonOrUndefined } from '@proxy/utils/guards'

/** The token's version: a token of another version is refused, not misread. */
const TOKEN_VERSION = 1

/** What a token carries: a thinking block and the model that produced it. */
export interface ReasoningToken {
  readonly provider: string
  readonly api: Api
  readonly model: string
  readonly thinking: ThinkingContent
}

/**
 * Encodes a thinking block as a reasoning item's `encrypted_content`.
 *
 * @param token - the block and the model it came from
 * @returns the token, base64url
 */
export function encodeReasoningToken(token: ReasoningToken): string {
  const { thinking } = token
  const payload = {
    version: TOKEN_VERSION,
    provider: token.provider,
    api: token.api,
    model: token.model,
    thinking: thinking.thinking,
    ...(thinking.thinkingSignature === undefined ? {} : { signature: thinking.thinkingSignature }),
    ...(thinking.redacted === true ? { redacted: true } : {})
  }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

/**
 * Reads a string field of a decoded token.
 *
 * @param payload - the decoded token
 * @param key - the field
 * @returns its value, or `undefined` when it is not a string
 */
function stringField(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * Decodes a reasoning item's `encrypted_content` back into the thinking block.
 *
 * @remarks
 * `provider`, `api` and `model` are taken as written: they only name the model the block came
 * from. pi replays a thinking block only when all three match the model it is calling
 * (`transformMessages`), so a value no model has means the block is dropped, never sent elsewhere.
 *
 * @param encoded - the token, as the client sent it
 * @returns the block and its model, or `undefined` when it is not a token this proxy wrote
 */
export function decodeReasoningToken(encoded: string): ReasoningToken | undefined {
  const payload = parseJsonOrUndefined(Buffer.from(encoded, 'base64url').toString('utf8'))
  if (!isRecord(payload) || payload['version'] !== TOKEN_VERSION) return undefined
  const provider = stringField(payload, 'provider')
  const api = stringField(payload, 'api')
  const model = stringField(payload, 'model')
  const thinking = stringField(payload, 'thinking')
  const signature = payload['signature']
  if (
    provider === undefined ||
    api === undefined ||
    model === undefined ||
    thinking === undefined
  ) {
    return undefined
  }
  if (signature !== undefined && typeof signature !== 'string') return undefined
  return {
    provider,
    api,
    model,
    thinking: {
      type: 'thinking',
      thinking,
      ...(signature === undefined ? {} : { thinkingSignature: signature }),
      ...(payload['redacted'] === true ? { redacted: true } : {})
    }
  }
}
