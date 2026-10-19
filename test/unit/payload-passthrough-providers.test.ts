/**
 * Provider-specific payload passthrough translation in `src/pi/complete.ts`:
 *
 * - Anthropic: translated field names and formats (`collectAnthropicPayloadFields`)
 * - Google: fields patched flat onto `config` and into `config.toolConfig`
 *   (`patchGooglePayload`)
 */

import {
  collectAnthropicPayloadFields,
  patchGooglePayload,
  translateToolChoiceForAnthropic
} from '@proxy/pi/complete'
import { describe, expect, test } from 'vite-plus/test'

import { minimalRequest } from './payload-passthrough-helpers'

// --- Anthropic translation ---

describe('collectAnthropicPayloadFields', () => {
  test('translates top_p (same name, natively supported)', () => {
    const fields = collectAnthropicPayloadFields(minimalRequest({ top_p: 0.9 }))
    expect(fields).toBeDefined()
    expect(fields?.['top_p']).toBe(0.9)
  })

  test('translates stop string to stop_sequences array', () => {
    const fields = collectAnthropicPayloadFields(minimalRequest({ stop: 'END' }))
    expect(fields).toBeDefined()
    expect(fields?.['stop_sequences']).toEqual(['END'])
  })

  test('translates stop array to stop_sequences', () => {
    const fields = collectAnthropicPayloadFields(minimalRequest({ stop: ['END', 'STOP'] }))
    expect(fields).toBeDefined()
    expect(fields?.['stop_sequences']).toEqual(['END', 'STOP'])
  })

  // Catches an Anthropic translation that leaks an unsupported field (seed, penalties,
  // response_format, prediction, arbitrary metadata) into the request, which Anthropic rejects:
  // with every passthrough field set, only the translated fields may come out.
  test('sends only translated fields when every passthrough field is set', () => {
    const fields = collectAnthropicPayloadFields(
      minimalRequest({
        tool_choice: 'required',
        parallel_tool_calls: false,
        top_p: 0.9,
        seed: 42,
        stop: 'END',
        user: 'user-123',
        frequency_penalty: 0.5,
        presence_penalty: 0.5,
        metadata: { task: 'test', chat_id: 'abc' },
        response_format: { type: 'json_object' },
        prediction: { type: 'content', content: 'test' }
      })
    )
    expect(fields).toEqual({
      top_p: 0.9,
      stop_sequences: ['END'],
      tool_choice: { type: 'any', disable_parallel_tool_use: true }
    })
  })

  // Catches unsupported fields alone producing a non-empty patch.
  test('returns undefined when only unsupported fields are set', () => {
    const fields = collectAnthropicPayloadFields(
      minimalRequest({
        seed: 42,
        frequency_penalty: 0.5,
        presence_penalty: 0.5,
        metadata: { task: 'test', chat_id: 'abc' },
        response_format: { type: 'json_object' },
        prediction: { type: 'content', content: 'test' }
      })
    )
    expect(fields).toBeUndefined()
  })
})

describe('translateToolChoiceForAnthropic', () => {
  test('auto -> { type: auto }', () => {
    expect(translateToolChoiceForAnthropic('auto')).toEqual({ type: 'auto' })
  })

  test('none -> { type: none }', () => {
    expect(translateToolChoiceForAnthropic('none')).toEqual({ type: 'none' })
  })

  test('required -> { type: any }', () => {
    expect(translateToolChoiceForAnthropic('required')).toEqual({ type: 'any' })
  })

  test('named function -> { type: tool, name }', () => {
    const choice = { type: 'function' as const, function: { name: 'get_weather' } }
    expect(translateToolChoiceForAnthropic(choice)).toEqual({
      type: 'tool',
      name: 'get_weather'
    })
  })

  test('undefined -> undefined', () => {
    expect(translateToolChoiceForAnthropic(undefined)).toBeUndefined()
  })
})

describe('collectAnthropicPayloadFields: tool_choice + parallel', () => {
  test('tool_choice auto with parallel disabled', () => {
    const fields = collectAnthropicPayloadFields(
      minimalRequest({ tool_choice: 'auto', parallel_tool_calls: false })
    )
    expect(fields?.['tool_choice']).toEqual({ type: 'auto', disable_parallel_tool_use: true })
  })

  test('tool_choice required with parallel disabled', () => {
    const fields = collectAnthropicPayloadFields(
      minimalRequest({ tool_choice: 'required', parallel_tool_calls: false })
    )
    expect(fields?.['tool_choice']).toEqual({ type: 'any', disable_parallel_tool_use: true })
  })

  test('parallel disabled without explicit tool_choice defaults to auto', () => {
    const fields = collectAnthropicPayloadFields(minimalRequest({ parallel_tool_calls: false }))
    expect(fields?.['tool_choice']).toEqual({ type: 'auto', disable_parallel_tool_use: true })
  })

  test('parallel true does not add disable flag', () => {
    const fields = collectAnthropicPayloadFields(
      minimalRequest({ tool_choice: 'auto', parallel_tool_calls: true })
    )
    expect(fields?.['tool_choice']).toEqual({ type: 'auto' })
  })

  test('named function with parallel disabled', () => {
    const fields = collectAnthropicPayloadFields(
      minimalRequest({
        tool_choice: { type: 'function', function: { name: 'calc' } },
        parallel_tool_calls: false
      })
    )
    expect(fields?.['tool_choice']).toEqual({
      type: 'tool',
      name: 'calc',
      disable_parallel_tool_use: true
    })
  })
})

// --- Google patching ---

describe('patchGooglePayload', () => {
  /**
   * Builds a minimal payload shaped as pi 1.3.0 builds it for Google: generation fields flat on
   * `config`.
   *
   * @param config - the initial `config`; empty by default
   * @returns a fresh payload with `model`, empty `contents`, and `config`
   */
  function googlePayload(config: Record<string, unknown> = {}): Record<string, unknown> {
    return { model: 'gemini-2.5-flash', contents: [], config }
  }

  // Catches a field translated to the wrong name or format, or written anywhere but flat on
  // `config`, where @google/genai reads it (#110): a nested `config.generationConfig` is dropped.
  test.each([
    { field: 'top_p', request: { top_p: 0.9 }, config: { topP: 0.9 } },
    { field: 'stop (string)', request: { stop: 'END' }, config: { stopSequences: ['END'] } },
    {
      field: 'stop (array)',
      request: { stop: ['END', 'STOP'] },
      config: { stopSequences: ['END', 'STOP'] }
    },
    { field: 'seed', request: { seed: 42 }, config: { seed: 42 } },
    {
      field: 'frequency_penalty',
      request: { frequency_penalty: 0.5 },
      config: { frequencyPenalty: 0.5 }
    },
    {
      field: 'presence_penalty',
      request: { presence_penalty: -0.5 },
      config: { presencePenalty: -0.5 }
    },
    {
      field: 'tool_choice auto',
      request: { tool_choice: 'auto' as const },
      config: { toolConfig: { functionCallingConfig: { mode: 'AUTO' } } }
    },
    {
      field: 'tool_choice none',
      request: { tool_choice: 'none' as const },
      config: { toolConfig: { functionCallingConfig: { mode: 'NONE' } } }
    },
    {
      field: 'tool_choice required',
      request: { tool_choice: 'required' as const },
      config: { toolConfig: { functionCallingConfig: { mode: 'ANY' } } }
    }
  ])('$field', ({ request, config }) => {
    const payload = googlePayload()

    const patched = patchGooglePayload(payload, minimalRequest(request))

    expect({ patched, config: payload['config'] }).toEqual({ patched: true, config })
  })

  // Catches the patch replacing pi's own generation fields instead of adding beside them.
  test("keeps pi's own config fields", () => {
    const payload = googlePayload({ temperature: 0.7, maxOutputTokens: 1024 })

    patchGooglePayload(payload, minimalRequest({ top_p: 0.9 }))

    expect(payload['config']).toEqual({ temperature: 0.7, maxOutputTokens: 1024, topP: 0.9 })
  })

  // Catches pi's value winning over the client's for the same key: the client asked for that
  // value, so the request field overrides one pi set (none does in pi 1.3.0).
  test('a request field overrides the same key set by pi', () => {
    const payload = googlePayload({ topP: 0.1, seed: 1 })

    patchGooglePayload(payload, minimalRequest({ top_p: 0.9, seed: 42 }))

    expect(payload['config']).toEqual({ topP: 0.9, seed: 42 })
  })

  // Catches a request without Google fields reported as patched, or the payload changed.
  test('returns false and changes nothing when no field is set', () => {
    const payload = googlePayload({ temperature: 0.7 })

    const patched = patchGooglePayload(payload, minimalRequest())

    expect({ patched, payload }).toEqual({
      patched: false,
      payload: googlePayload({ temperature: 0.7 })
    })
  })

  // Catches a payload without `config` gaining one, or the call throwing.
  test('returns false when payload has no config', () => {
    const payload: Record<string, unknown> = { model: 'test' }

    const patched = patchGooglePayload(payload, minimalRequest({ top_p: 0.9 }))

    expect({ patched, payload }).toEqual({ patched: false, payload: { model: 'test' } })
  })

  // Catches a named tool_choice mapped to AUTO (the model could then skip the tool) or dropped:
  // Google cannot force one function, so the closest is ANY.
  test('maps a named tool_choice to mode ANY', () => {
    const payload = googlePayload()
    const patched = patchGooglePayload(
      payload,
      minimalRequest({ tool_choice: { type: 'function', function: { name: 'get_weather' } } })
    )
    expect(patched).toBe(true)
    expect(payload).toEqual({
      model: 'gemini-2.5-flash',
      contents: [],
      config: { toolConfig: { functionCallingConfig: { mode: 'ANY' } } }
    })
  })

  // Catches an unsupported field (user, metadata, response_format, prediction,
  // parallel_tool_calls) leaking into Google's payload, or a supported one landing in the wrong
  // place: with every passthrough field set, the whole payload is pinned.
  test('patches only supported fields when every passthrough field is set', () => {
    const payload = googlePayload()
    patchGooglePayload(
      payload,
      minimalRequest({
        tool_choice: 'required',
        parallel_tool_calls: false,
        top_p: 0.9,
        seed: 42,
        stop: 'END',
        user: 'user-123',
        frequency_penalty: 0.5,
        presence_penalty: -0.5,
        metadata: { task: 'test' },
        response_format: { type: 'json_object' },
        prediction: { type: 'content', content: 'test' }
      })
    )
    expect(payload).toEqual({
      model: 'gemini-2.5-flash',
      contents: [],
      config: {
        topP: 0.9,
        stopSequences: ['END'],
        seed: 42,
        frequencyPenalty: 0.5,
        presencePenalty: -0.5,
        toolConfig: { functionCallingConfig: { mode: 'ANY' } }
      }
    })
  })
})
