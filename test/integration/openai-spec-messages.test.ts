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
  propertiesOf,
  proxyRequestSchema
} from '../fixtures/openai-spec/schema'

/** OpenAI message fields the proxy does not accept, by role, with what it does instead (#146). */
const MESSAGE_FIELDS_NOT_ACCEPTED: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'role: assistant': {
    function_call: 'rejected as an unknown parameter (422): deprecated, superseded by `tool_calls`'
  }
}

/** OpenAI user content-part types the proxy does not accept, with what it does instead. */
const USER_PART_TYPES_NOT_ACCEPTED: Readonly<Record<string, string>> = {
  'type: file': 'rejected (400): pi takes no file input',
  'type: input_audio': 'rejected (400): pi takes no audio input'
}

/**
 * Compares the fields of each branch two union schemas share: the proxy's must be OpenAI's, and
 * OpenAI's must be the proxy's or listed.
 *
 * @param proxy - the proxy's branches, by key
 * @param openai - OpenAI's branches, by key
 * @param notAccepted - OpenAI fields the proxy does not take, by branch key
 * @returns per shared branch, the proxy fields OpenAI lacks and the unlisted OpenAI fields missing
 */
function fieldDrift(
  proxy: Readonly<Record<string, Record<string, unknown>>>,
  openai: Readonly<Record<string, Record<string, unknown>>>,
  notAccepted: Readonly<Record<string, Readonly<Record<string, string>>>>
): Record<string, { extra: string[]; unlisted: string[] }> {
  const drift: Record<string, { extra: string[]; unlisted: string[] }> = {}
  for (const [key, proxyFields] of Object.entries(proxy)) {
    const openaiFields = Object.keys(openai[key] ?? {})
    const listed = Object.keys(notAccepted[key] ?? {})
    const extra = Object.keys(proxyFields).filter((fieldName) => !openaiFields.includes(fieldName))
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
    expect(fieldDrift(proxyRoles, openaiRoles, MESSAGE_FIELDS_NOT_ACCEPTED)).toEqual({})
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
