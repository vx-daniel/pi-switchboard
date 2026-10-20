/**
 * Fields inside messages, checked against OpenAI's pinned spec (#132, #146), as
 * `openai-spec.test.ts` checks the request's top-level fields. Message and part schemas are strict,
 * so each field the proxy accepts must be one OpenAI defines for that role or part, and each one
 * OpenAI defines that the proxy does not accept is listed here with what the proxy does instead. A
 * spec bump that adds one fails until it is listed or accepted.
 */

import { describe, expect, test } from 'vite-plus/test'

import {
  arrayItems,
  branchProperties,
  fieldSchema,
  openaiRequestSchema,
  openaiSchemas,
  propertiesOf,
  proxyRequestSchema
} from '../fixtures/openai-spec/schema'

/**
 * OpenAI message fields the proxy does not accept, by role, with what it does instead (#146).
 * Empty now: the proxy takes every OpenAI message field, the ones pi has nowhere to put only when
 * empty (`refusal`, `audio`, `function_call`).
 */
const MESSAGE_FIELDS_NOT_ACCEPTED: Readonly<Record<string, Readonly<Record<string, string>>>> = {}

/**
 * Message fields the proxy accepts that OpenAI's request does not define, by role, with why: each
 * is a response-message field an OpenAI SDK echoes back in history (#146).
 */
const ECHOED_RESPONSE_FIELDS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'role: assistant': {
    annotations: 'accepted only as null or []: the Python SDK dumps it on every reply'
  }
}

/** OpenAI user content-part types the proxy does not accept, with what it does instead. */
const USER_PART_TYPES_NOT_ACCEPTED: Readonly<Record<string, string>> = {
  'type: file': 'rejected (400): pi takes no file input',
  'type: input_audio': 'rejected (400): pi takes no audio input'
}

/**
 * Compares the fields of each branch two union schemas share: the proxy's must be OpenAI's or
 * allowed, and OpenAI's must be the proxy's or listed.
 *
 * @param proxy - the proxy's branches, by key
 * @param openai - OpenAI's branches, by key
 * @param notAccepted - OpenAI fields the proxy does not take, by branch key
 * @param beyondOpenai - proxy fields OpenAI's request does not define, allowed by branch key
 * @returns per shared branch, the unallowed proxy fields OpenAI lacks and the unlisted OpenAI
 *   fields missing
 */
function fieldDrift(
  proxy: Readonly<Record<string, Record<string, unknown>>>,
  openai: Readonly<Record<string, Record<string, unknown>>>,
  notAccepted: Readonly<Record<string, Readonly<Record<string, string>>>>,
  beyondOpenai: Readonly<Record<string, Readonly<Record<string, string>>>> = {}
): Record<string, { extra: string[]; unlisted: string[] }> {
  const drift: Record<string, { extra: string[]; unlisted: string[] }> = {}
  for (const [key, proxyFields] of Object.entries(proxy)) {
    const openaiFields = Object.keys(openai[key] ?? {})
    const listed = Object.keys(notAccepted[key] ?? {})
    const allowed = Object.keys(beyondOpenai[key] ?? {})
    const extra = Object.keys(proxyFields).filter(
      (fieldName) => !openaiFields.includes(fieldName) && !allowed.includes(fieldName)
    )
    const unlisted = openaiFields.filter(
      (fieldName) => !(fieldName in proxyFields) && !listed.includes(fieldName)
    )
    if (extra.length > 0 || unlisted.length > 0) drift[key] = { extra, unlisted }
  }
  return drift
}

describe('fields inside messages stay within OpenAI (#146)', () => {
  const proxyRoles = branchProperties(fieldSchema(proxyRequestSchema, 'messages', true), 'role')
  const openaiRoles = branchProperties(fieldSchema(openaiRequestSchema, 'messages', true), 'role')

  // Catches a message field the proxy accepts that OpenAI does not define, and an OpenAI message
  // field it neither accepts nor lists, so a spec bump adding one fails until it is decided.
  test('each role takes only OpenAI fields, and every other OpenAI field is listed', () => {
    expect(Object.keys(proxyRoles).length).toBeGreaterThan(0)
    expect(
      fieldDrift(proxyRoles, openaiRoles, MESSAGE_FIELDS_NOT_ACCEPTED, ECHOED_RESPONSE_FIELDS)
    ).toEqual({})
  })

  // Catches the echo allowance outliving its reason: each field accepted beyond OpenAI's request
  // must still be one OpenAI's response message carries, or it is a proxy invention.
  test('each field accepted beyond the request is on OpenAI response messages', () => {
    const responseFields = Object.keys(propertiesOf(openaiSchemas['ChatCompletionResponseMessage']))
    const echoed = Object.values(ECHOED_RESPONSE_FIELDS).flatMap((fields) => Object.keys(fields))

    expect(echoed.filter((fieldName) => !responseFields.includes(fieldName))).toEqual([])
  })

  // Catches the same one level down: the fields of a text or image part, and of `image_url`.
  test('each user content part takes only OpenAI fields, and every other is listed', () => {
    const proxyParts = branchProperties(arrayItems(proxyRoles['role: user']?.['content']), 'type')
    const openaiParts = branchProperties(arrayItems(openaiRoles['role: user']?.['content']), 'type')

    expect(Object.keys(proxyParts).toSorted()).toEqual(['type: image_url', 'type: text'])
    expect(fieldDrift(proxyParts, openaiParts, {})).toEqual({})
    expect(
      Object.keys(openaiParts)
        .filter((key) => !(key in proxyParts))
        .toSorted()
    ).toEqual(Object.keys(USER_PART_TYPES_NOT_ACCEPTED).toSorted())
    expect(
      fieldDrift(
        { image_url: propertiesOf(proxyParts['type: image_url']?.['image_url']) },
        { image_url: propertiesOf(openaiParts['type: image_url']?.['image_url']) },
        {}
      )
    ).toEqual({})
  })
})
