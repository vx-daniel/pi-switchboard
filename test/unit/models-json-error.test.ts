/**
 * `describeModelsJsonError` on the messages pi 1.3.0 produces, captured from real runs. The
 * JSON.parse wording differs between engines (V8 by Node version, JavaScriptCore in the Bun
 * binary), so each form is pinned here directly rather than through whichever one the test
 * runner's engine gives.
 */

import { describeModelsJsonError } from '@proxy/pi/registry'
import { describe, expect, test } from 'vite-plus/test'

const FILE = '\n\nFile: /home/someone/.pi/agent/models.json'

describe('describeModelsJsonError', () => {
  // Catches the parse error's quote of the file (here, most of a key) surviving the reduction.
  test('drops the quoted text of a parse error', () => {
    const error = `Failed to parse models.json: Unexpected token 'o', ..."apiKey": notarealsec"... is not valid JSON${FILE}`

    expect(describeModelsJsonError(error)).toBe('models.json is not valid JSON')
  })

  test('keeps the line and column over the offset when both are given', () => {
    const error = `Failed to parse models.json: Expected double-quoted property name in JSON at position 54 (line 1 column 55)${FILE}`

    expect(describeModelsJsonError(error)).toBe('models.json is not valid JSON at line 1 column 55')
  })

  test('keeps the offset when it is all the parser gives', () => {
    const error = `Failed to parse models.json: Expected double-quoted property name in JSON at position 62${FILE}`

    expect(describeModelsJsonError(error)).toBe('models.json is not valid JSON at position 62')
  })

  // Catches the Bun binary (JavaScriptCore, which gives no location) always reporting the bare
  // `not valid JSON`, losing what is wrong with the file (#249). Captured from Bun 1.4.4.
  test.each([
    ['{', "Expected '}'"],
    ['[1 2]', "Expected ']'"],
    ['{"a"', "Expected ':' before value in object property definition"],
    ['{"a":}', "Unexpected token '}'"],
    ['[1,]', 'Unexpected comma at the end of array expression'],
    ['{"a":1,}', 'Property name must be a string literal'],
    ['', 'Unexpected EOF'],
    ['{"a":"x', 'Unterminated string'],
    ['{"a":1}}', 'Unable to parse JSON string'],
    ["{'a':1}", "Single quotes (') are not allowed in JSON"]
  ])('keeps the reason JavaScriptCore gives for %j', (_text, reason) => {
    const error = `Failed to parse models.json: JSON Parse error: ${reason}${FILE}`

    expect(describeModelsJsonError(error)).toBe(`models.json is not valid JSON: ${reason}`)
  })

  // Catches a JavaScriptCore message that quotes the file (an identifier, a character, an escape)
  // surviving the reduction: the quoted text can be part of a key.
  test.each([
    'Unexpected identifier "notarealsec"',
    "Unrecognized token '#'",
    'Invalid escape character q',
    '"\\uZZZZ" is not a valid unicode escape'
  ])('drops JavaScriptCore reason %j, which quotes the file', (reason) => {
    const error = `Failed to parse models.json: JSON Parse error: ${reason}${FILE}`

    expect(describeModelsJsonError(error)).toBe('models.json is not valid JSON')
  })

  // Catches the reduction hiding errors that quote no values, which tell the operator what to fix.
  test('passes load and schema errors through without the file path', () => {
    expect(
      describeModelsJsonError(
        `Failed to load models.json: EACCES: permission denied, open '/home/someone/.pi/agent/models.json'${FILE}`
      )
    ).toBe(
      "Failed to load models.json: EACCES: permission denied, open '/home/someone/.pi/agent/models.json'"
    )
    expect(
      describeModelsJsonError(
        `Invalid models.json schema:\n  - providers.x.apiKey: must be string${FILE}`
      )
    ).toBe('Invalid models.json schema:\n  - providers.x.apiKey: must be string')
  })
})
