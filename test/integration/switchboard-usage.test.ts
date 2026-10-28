/**
 * `GET /v1/switchboard/usage` (#224): the stats file's usage over a window, behind proxy auth.
 */

import { usageSchema } from '@proxy/server/usage'
import { statsFilePath } from '@proxy/stats/recorder'
import { openStatsStore } from '@proxy/stats/store'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'
import { jsonBody, testApp, testConfig } from '../helpers'

/** Milliseconds in a minute. */
const MINUTE = 60_000

let agentDir: FixtureAgentDir

beforeEach(async () => {
  agentDir = await loadFixtureAgentDir()
})

afterEach(() => {
  vi.unstubAllEnvs()
  agentDir.remove()
})

/**
 * Writes one minute of traffic to the stats file in the fixture agent dir:
 * - two requests through `coding`, served by `p/b` after one fell back from `p/a`;
 * - one direct request to `p/a` that failed;
 * - three requests rejected with 404.
 */
function recordTraffic(): void {
  const minute = Math.floor(Date.now() / MINUTE)
  const zeroTimes = {
    durationMsTotal: 0,
    durationMsMax: 0,
    firstEventMsTotal: 0,
    firstEventCount: 0,
    promptCacheKeyRequests: 0
  }
  const store = openStatsStore(statsFilePath())
  store.add({
    requests: [
      {
        minute,
        alias: 'coding',
        model: 'p/b',
        outcome: 'ok',
        status: 0,
        requests: 2,
        durationMsTotal: 3000,
        durationMsMax: 2000,
        firstEventMsTotal: 800,
        firstEventCount: 2,
        promptCacheKeyRequests: 1
      },
      { minute, alias: '', model: 'p/a', outcome: 'failed', status: 0, requests: 1, ...zeroTimes },
      {
        minute,
        alias: '',
        model: 'gpt-4o',
        outcome: 'rejected',
        status: 404,
        requests: 3,
        ...zeroTimes
      }
    ],
    attempts: [
      { ...attempt(minute, 'coding', 'p/a'), attempts: 1, failures: 1, fallbacks: 1 },
      {
        ...attempt(minute, 'coding', 'p/b'),
        attempts: 2,
        inputTokens: 100,
        outputTokens: 40,
        cacheReadTokens: 10,
        cacheWriteTokens: 4,
        costUsd: 0.5
      },
      { ...attempt(minute, '', 'p/a'), attempts: 1, failures: 1 }
    ],
    failures: [{ minute, model: 'p/a', failureClass: 'rate_limit', failures: 2 }]
  })
  store.close()
}

/**
 * Builds an attempt row with every count zero.
 *
 * @param minute - the minute
 * @param alias - the alias, or '' for none
 * @param model - the model
 * @returns the row
 */
function attempt(minute: number, alias: string, model: string) {
  return {
    minute,
    alias,
    provider: 'p',
    model,
    attempts: 0,
    failures: 0,
    fallbacks: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0
  }
}

describe('GET /v1/switchboard/usage', () => {
  // Catches the endpoint adding up the wrong rows: an alias's fallback attempts counted under the
  // wrong route, a direct request missing from the aliases, or rejected requests counted as served.
  test('reports usage per alias and per model, with errors and a timeline', async () => {
    recordTraffic()
    const app = testApp({ ...testConfig(), statsEnabled: true })

    const response = await app.request('/v1/switchboard/usage?window=all')
    const body = await jsonBody(response)

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      object: 'switchboard.usage',
      window: 'all',
      bucket_minutes: 1440,
      aliases: [
        {
          alias: 'coding',
          requests: 2,
          failed: 0,
          attempts: 3,
          fallbacks: 1,
          input_tokens: 100,
          output_tokens: 40,
          cache_read_tokens: 10,
          cache_write_tokens: 4,
          cost_usd: 0.5,
          average_ms: 1500,
          slowest_ms: 2000,
          average_first_event_ms: 400
        },
        { alias: null, requests: 1, failed: 1, attempts: 1, average_first_event_ms: null }
      ],
      models: [
        { model: 'p/b', requests: 2, attempts: 2, fallbacks: 0, cost_usd: 0.5 },
        { model: 'p/a', requests: 1, failed: 1, attempts: 2, fallbacks: 1 }
      ],
      failures: [{ class: 'rate_limit', count: 2 }],
      rejected: [{ status: 404, count: 3 }]
    })
    // The body is what the OpenAPI document says it is, and its timeline holds every request.
    const { timeline } = usageSchema.parse(body)
    expect(timeline.reduce((total, bucket) => total + bucket.requests, 0)).toBe(6)
    expect(timeline.reduce((total, bucket) => total + bucket.rejected, 0)).toBe(3)
  })

  // Catches an unknown window answered with today's numbers, or in hono-openapi's error shape
  // instead of OpenAI's.
  test('refuses an unknown window with 400', async () => {
    const app = testApp({ ...testConfig(), statsEnabled: true })

    const response = await app.request('/v1/switchboard/usage?window=year')

    expect(response.status).toBe(400)
    expect(await jsonBody(response)).toMatchObject({
      error: { type: 'invalid_request_error', param: 'window' }
    })
  })

  // Catches a repeated `window` failing the query validator into hono-openapi's own 400 shape, or
  // its later value used: the first one counts, as with `verify` on /healthz/creds.
  test.each([
    ['window=week&window=year', 200],
    ['window=year&window=week', 400]
  ])('?%s counts by the first value', async (query, status) => {
    const app = testApp({ ...testConfig(), statsEnabled: true })

    const response = await app.request(`/v1/switchboard/usage?${query}`)

    expect(response.status).toBe(status)
  })

  // Catches `--no-stats` answered with empty numbers, which would read as a proxy with no traffic.
  test('answers 503 when stats are off', async () => {
    const app = testApp({ ...testConfig(), statsEnabled: false })

    const response = await app.request('/v1/switchboard/usage')

    expect(response.status).toBe(503)
    expect(await jsonBody(response)).toMatchObject({ error: { code: 'stats_unavailable' } })
  })

  // Catches the usage readable without the proxy token: it names aliases, models and cost.
  test('needs the proxy token when auth is on', async () => {
    recordTraffic()
    const token = 'notarealsecret-usage-token'
    const app = testApp({
      ...testConfig(),
      statsEnabled: true,
      proxyAuth: { kind: 'token', token }
    })

    const refused = await app.request('/v1/switchboard/usage')
    const allowed = await app.request('/v1/switchboard/usage', {
      headers: { Authorization: `Bearer ${token}` }
    })

    expect(refused.status).toBe(401)
    expect(allowed.status).toBe(200)
  })
})
