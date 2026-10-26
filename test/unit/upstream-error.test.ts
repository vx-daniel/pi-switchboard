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
})
