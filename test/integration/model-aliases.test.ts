/**
 * Aliases (#66): names from `proxy-config.json`'s `aliases` for exposed models, end to end. The
 * proxy runs as deployed, reading its config file and pi's `enabledModels` on each request, with
 * pi's OpenAI chat completions adapter calling the mock provider, which answers by model.
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createApp } from '@proxy/server/app'
import { fileConfigReader } from '@proxy/server/routes'
import type { ProxyEnv } from '@proxy/server/types'
import { isRecord } from '@proxy/utils/guards'
import type { Hono } from 'hono'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'
import {
  finishChunk,
  type MockProvider,
  sse,
  startMockProvider,
  textChunks
} from '../fixtures/mock-provider'
import { testConfig } from '../helpers'

const HTTP_OK = 200
const HTTP_NOT_FOUND = 404
const HTTP_SERVICE_UNAVAILABLE = 503
const MOCK_KEY = 'notarealsecret-mock-provider-key'
/** The alias's target, by canonical ID. */
const TARGET = 'mock/opus-mock'

let mock: MockProvider
let agentDir: FixtureAgentDir

beforeAll(async () => {
  const answer = sse([...textChunks('ok'), finishChunk('stop')])
  mock = await startMockProvider({ 'opus-mock': answer, 'haiku-mock': answer })
  agentDir = await loadFixtureAgentDir({
    modelsJson: {
      providers: {
        mock: {
          baseUrl: `${mock.origin}/v1`,
          api: 'openai-completions',
          apiKey: MOCK_KEY,
          models: [{ id: 'opus-mock', reasoning: true }, { id: 'haiku-mock' }]
        }
      }
    }
  })
})

beforeEach(() => {
  enableModels([])
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await mock.close()
  agentDir.remove()
})

/**
 * Writes the proxy's config file with these aliases (scoped exposure, the default).
 *
 * @param aliases - alias -> canonical ID
 */
function setAliases(aliases: Record<string, string>): void {
  writeFileSync(join(agentDir.path, 'proxy-config.json'), JSON.stringify({ aliases }))
}

/**
 * Writes pi's global settings with these `enabledModels`; none exposes every model.
 *
 * @param patterns - the `enabledModels` entries
 */
function enableModels(patterns: readonly string[]): void {
  writeFileSync(join(agentDir.path, 'settings.json'), JSON.stringify({ enabledModels: patterns }))
}

/**
 * Builds the proxy as deployed: exposure from its config file and pi's settings, per request.
 *
 * @returns the app
 */
function app(): Hono<ProxyEnv> {
  return createApp(testConfig(), fileConfigReader)
}

/**
 * Reads a JSON response body as an object.
 *
 * @param response - the response
 * @returns the body, or an empty object when it is not one
 */
async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json()
  return isRecord(body) ? body : {}
}

/**
 * Lists the IDs a list route returns.
 *
 * @param path - `/v1/models` or `/v1/switchboard/models`
 * @returns each entry's `id`, in list order
 */
async function listedIds(path: string): Promise<unknown[]> {
  const data = (await bodyOf(await app().request(path)))['data']
  return Array.isArray(data)
    ? data.map((listed: unknown) => (isRecord(listed) ? listed['id'] : listed))
    : []
}

/**
 * Sends one chat request and records which model the upstream was asked for.
 *
 * @param model - the request's `model`
 * @param stream - whether to ask for a stream
 * @returns the response, its body as text, and the upstream request's `model` (`undefined` when
 *   no upstream call was made)
 */
async function ask(
  model: string,
  stream: boolean
): Promise<{ status: number; text: string; upstreamModel: unknown }> {
  const before = mock.requests.length
  const response = await app().request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, stream, messages: [{ role: 'user', content: 'Say ok' }] })
  })
  const text = await response.text()
  const upstream = mock.requests.slice(before).at(0)
  const upstreamModel =
    upstream !== undefined && isRecord(upstream.body) ? upstream.body['model'] : undefined
  return { status: response.status, text, upstreamModel }
}

/**
 * Parses the JSON chunks of a streamed response, leaving out `[DONE]`.
 *
 * @param text - the response body
 * @returns each chunk, in order
 */
function chunks(text: string): Record<string, unknown>[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line) => {
      const chunk: unknown = JSON.parse(line.slice('data: '.length))
      return isRecord(chunk) ? chunk : {}
    })
}

describe('a chat request for an alias', () => {
  // Catches an alias that is listed but not resolved, resolved to the wrong model, or reported as
  // the alias in `model`, so a client could not tell which model answered.
  test('non-streamed: answered by the target, `model` is its canonical ID, x_pi.alias the alias', async () => {
    setAliases({ coding: TARGET })

    const answer = await ask('coding', false)

    expect(answer.status).toBe(HTTP_OK)
    expect(answer.upstreamModel).toBe('opus-mock')
    const body: unknown = JSON.parse(answer.text)
    expect(body).toMatchObject({ model: TARGET, x_pi: { alias: 'coding' } })
  })

  // Catches the alias reported on the non-streamed response only: streamed and non-streamed
  // responses say the same, in every chunk, so a client reading any one of them sees it.
  test('streamed: every chunk has the canonical ID and x_pi.alias', async () => {
    setAliases({ coding: TARGET })

    const answer = await ask('coding', true)

    expect(answer.status).toBe(HTTP_OK)
    expect(answer.upstreamModel).toBe('opus-mock')
    const streamed = chunks(answer.text)
    expect(streamed.length).toBeGreaterThan(1)
    for (const chunk of streamed) {
      expect(chunk).toMatchObject({ model: TARGET, x_pi: { alias: 'coding' } })
    }
  })

  // Catches x_pi.alias on responses that named no alias: asked by its own ID, a model's response
  // carries no alias, even while an alias names that model.
  test.each([
    ['non-streamed', false],
    ['streamed', true]
  ])('%s: a request by the model ID carries no alias', async (_mode, stream) => {
    setAliases({ coding: TARGET })

    const answer = await ask('opus-mock', stream)

    expect(answer.status).toBe(HTTP_OK)
    expect(answer.text).not.toContain('"alias"')
  })
})

describe('listing an alias', () => {
  // Catches an alias missing from any route that lists models: a client discovering models, or
  // their capabilities, sees the same names it can request.
  test('appears on /v1/models, /v1/models/{alias} and /v1/switchboard/models, as its target', async () => {
    setAliases({ coding: TARGET })

    expect(await listedIds('/v1/models')).toEqual(['opus-mock', 'haiku-mock', 'coding'])
    const detail = await app().request('/v1/models/coding')
    expect(detail.status).toBe(HTTP_OK)
    expect(await bodyOf(detail)).toMatchObject({ id: 'coding', owned_by: 'mock' })
    const capabilities = (await bodyOf(await app().request('/v1/switchboard/models')))['data']
    const byId = new Map(
      (Array.isArray(capabilities) ? capabilities : []).map((capability: unknown) => [
        isRecord(capability) ? capability['id'] : capability,
        isRecord(capability) ? capability['reasoning_efforts'] : undefined
      ])
    )
    expect(byId.get('coding')).toEqual(byId.get('opus-mock'))
  })

  // Catches an alias reaching a model the exposure config hides (CONSTITUTION.md, principle IV):
  // with its target left out of enabledModels, the alias is not listed, not found, and not
  // answered, and /healthz/models says why without failing.
  test('disappears when its target is not exposed', async () => {
    setAliases({ coding: TARGET })
    enableModels(['mock/haiku-mock'])

    expect(await listedIds('/v1/models')).toEqual(['haiku-mock'])
    expect((await app().request('/v1/models/coding')).status).toBe(HTTP_NOT_FOUND)
    const answer = await ask('coding', false)
    expect(answer.status).toBe(HTTP_NOT_FOUND)
    expect(answer.upstreamModel).toBeUndefined()
    const health = await app().request('/healthz/models')
    expect(health.status).toBe(HTTP_OK)
    expect((await bodyOf(health))['aliasDiagnostics']).toEqual([
      expect.objectContaining({ code: 'target-not-exposed', alias: 'coding', target: TARGET })
    ])
  })
})

describe('an alias named like an exposed model', () => {
  // Catches an alias silently shadowing a model, or the collision taking the proxy down: the
  // model keeps its name, the alias is ignored, and /healthz/models fails, naming it.
  test.each([
    ['public ID', 'haiku-mock'],
    ['canonical ID', 'mock/haiku-mock']
  ])('a %s: the model still answers it; /healthz/models is 503', async (_case, name) => {
    setAliases({ [name]: TARGET })

    const answer = await ask(name, false)
    expect(answer.status).toBe(HTTP_OK)
    expect(answer.upstreamModel).toBe('haiku-mock')
    expect(answer.text).not.toContain('"alias"')

    const health = await app().request('/healthz/models')
    expect(health.status).toBe(HTTP_SERVICE_UNAVAILABLE)
    expect((await bodyOf(health))['aliasDiagnostics']).toEqual([
      expect.objectContaining({ code: 'shadows-model', alias: name, target: TARGET })
    ])
    expect(await listedIds('/v1/models')).toEqual(['opus-mock', 'haiku-mock'])
  })
})
