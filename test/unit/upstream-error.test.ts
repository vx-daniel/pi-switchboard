import { splitUpstreamError } from '@proxy/pi/upstream-error'
import { describe, expect, test } from 'vite-plus/test'

describe('splitUpstreamError', () => {
  // Catches a match boundary that swallows the body's first character, or leaves the separator in.
  test.each([
    ['429: {"a":1}', 429, '{"a":1}'],
    ['429 {"type":"error"}', 429, '{"type":"error"}'],
    ['429 "Too Many Requests"', 429, '"Too Many Requests"'],
    ['OpenAI API error (429): {"a":1}', 429, '{"a":1}'],
    ['got status: 503. {"error":{"code":503}}', 503, '{"error":{"code":503}}'],
    ['got status: 503', 503, ''],
    ['408 status code (no body)', 408, ''],
    ['500 status code upstream broke', 500, 'upstream broke']
  ])('%s', (message, status, body) => {
    expect(splitUpstreamError(message)).toEqual({ status, body })
  })

  // Catches a number that merely starts the message being read as a status.
  test.each([
    '429 tokens per minute exceeds your tier',
    '401 messages were sent',
    'rate limit (429) reached',
    'plain failure'
  ])('no status in %s: the whole message is the body', (message) => {
    expect(splitUpstreamError(message)).toEqual({ status: undefined, body: message })
  })

  // Catches the boundary of each prefix shape drifting (#253): a separator left at the body's
  // start, a body character consumed with it, or text inside the body trimmed. The body is what
  // `retryWithoutBreakpoints` parses as JSON, so one character off loses the refusal.
  test.each([
    ['`NNN:` then a newline', '400:\n{"param":"p"}', 400, '{"param":"p"}'],
    ['`NNN:` then several spaces and a tab', '400:  \t{"a":1}', 400, '{"a":1}'],
    ['`NNN {`: the brace is kept', '400 {"a":1}', 400, '{"a":1}'],
    ['`NNN "`: the quote is kept', '503 "upstream connect error"', 503, '"upstream connect error"'],
    ['a body whose own text has spaces', '429: {"a": 1}  ', 429, '{"a": 1}  '],
    ['a multi-line body', '429: line one\nline two', 429, 'line one\nline two'],
    ['a bare `status code`', '429 status code', 429, ''],
    ['`status code` then a newline', '502 status code\nbad gateway', 502, 'bad gateway'],
    ['`(no body)` then more text', '400 status code (no body) trailing', 400, 'trailing'],
    ['a label with no space after the colon', 'OpenAI API error (400):{"a":1}', 400, '{"a":1}'],
    ['a label then a newline', 'Mistral API error (422):\n{"a":1}', 422, '{"a":1}'],
    ['`got status:` with no dot', 'got status: 429 {"a":1}', 429, '{"a":1}'],
    ['`got status:` with a dot and no space', 'got status: 429.{"a":1}', 429, '{"a":1}']
  ])('%s', (_case, message, status, body) => {
    expect(splitUpstreamError(message)).toEqual({ status, body })
  })

  // Catches a prefix loosened past pi's wording (#253): each of these only resembles a status
  // prefix, so it reports no status and its whole text is the body.
  test.each([
    '429:{"a":1}',
    '429:',
    '429 [1]',
    '4290: {"a":1}',
    '301: {"a":1}',
    '629 {"a":1}',
    '429 status codes differ',
    ' 429: {"a":1}',
    'failed\n429: {"a":1}',
    `${'L'.repeat(81)} (429): {"a":1}`,
    'Error (beta) (429): {"a":1}',
    'got status: 4290. {"a":1}'
  ])('no status in %j: the whole message is the body', (message) => {
    expect(splitUpstreamError(message)).toEqual({ status: undefined, body: message })
  })

  // Catches the positions tried in another order (#296 review): pi's leading status is the call's
  // own, and a body that quotes a labelled status (`… (429): …`) must not override it.
  test('a leading status wins over a labelled one later in the message', () => {
    expect(splitUpstreamError('400: upstream said (429): slow down')).toEqual({
      status: 400,
      body: 'upstream said (429): slow down'
    })
  })
})
