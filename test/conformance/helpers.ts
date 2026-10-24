/**
 * SDK conformance test helpers: an OpenAI SDK client pointed at the Hono test app, and the test
 * models the developer's real pi login can reach, so a test can skip when there are none.
 *
 * @packageDocumentation
 */

import { getAvailableModels, initRegistry } from '@proxy/pi/registry'
import OpenAI from 'openai'

import { testApp } from '../helpers'

/** Whether {@link setup} has run. */
let initialized = false
/** The test app, created once by {@link setup}. */
let app: ReturnType<typeof testApp> | undefined

/**
 * One entry of the curated test model matrix.
 *
 * @remarks
 * Three categories per provider:
 *   fast      -- cheapest, for basic shape validation
 *   mid       -- mid-tier, for tool call and streaming tests
 *   reasoning -- reasoning-capable, for reasoning_effort tests
 *
 * Tests pick from the matrix based on what is available. The providers are OAuth subscription
 * accounts: be mindful of quota.
 */
export interface TestModel {
  readonly id: string
  readonly category: 'fast' | 'mid' | 'reasoning'
}

/** The curated test models, as `<provider>/<model ID>`; see {@link TestModel}. */
const TEST_MODEL_MATRIX: readonly TestModel[] = [
  // Anthropic (direct)
  { id: 'anthropic/claude-haiku-4-5', category: 'fast' },
  { id: 'anthropic/claude-sonnet-4-5', category: 'mid' },
  { id: 'anthropic/claude-sonnet-4-6', category: 'reasoning' },

  // Google Gemini: pi's `google` provider (API google-generative-ai). pi (1.3.0, 1.4.0) has no
  // `google-gemini-cli` provider, so the IDs that named it never resolved.
  { id: 'google/gemini-2.5-flash-lite', category: 'fast' },
  { id: 'google/gemini-2.5-flash', category: 'mid' },
  { id: 'google/gemini-2.5-pro', category: 'reasoning' },

  // OpenAI / Codex: pi 1.4.0's catalog. gpt-6-luna is the cheapest, and was measured live on a
  // ChatGPT login (PLAN "Cooldowns (#68)").
  { id: 'openai-codex/gpt-6-luna', category: 'fast' },
  { id: 'openai-codex/gpt-6-sol', category: 'mid' },
  { id: 'openai-codex/gpt-6.1-sol', category: 'reasoning' }
]

/** The matrix models pi has available, keyed by ID; filled once by {@link setup}. */
let resolvedModels: Map<string, TestModel> | undefined

// Pi 1.x initializes its model runtime asynchronously. Doing it once here, with a top-level
// await, keeps every helper below (and the tests that call them while being collected) synchronous.
await initRegistry()

/**
 * Creates the app and resolves the available test models, once.
 *
 * @returns the test app
 * @throws Error when the app was not created (it always is on the first call)
 */
export function setup(): { app: ReturnType<typeof testApp> } {
  if (!initialized) {
    app = testApp()

    const available = new Set(getAvailableModels().map((model) => `${model.provider}/${model.id}`))
    resolvedModels = new Map()
    for (const tm of TEST_MODEL_MATRIX) {
      if (available.has(tm.id)) {
        resolvedModels.set(tm.id, tm)
      }
    }

    initialized = true
  }
  if (app === undefined) {
    throw new Error('App not initialized')
  }
  return { app }
}

/**
 * Returns the available test models, optionally filtered by category.
 *
 * @param category - the category to keep; omitted, every available model
 * @returns the matrix models pi has available, in matrix order; empty when there are none
 */
export function getTestModels(category?: TestModel['category']): TestModel[] {
  setup()
  if (resolvedModels === undefined) return []
  const all = [...resolvedModels.values()]
  if (category === undefined) return all
  return all.filter((model) => model.category === category)
}

/**
 * Returns the cheapest available test model: the first "fast" one, else the first "mid" one,
 * else the first available.
 *
 * @returns the model, or `undefined` when no matrix model is available
 */
export function getCheapestModel(): TestModel | undefined {
  const fast = getTestModels('fast')
  if (fast.length > 0) return fast[0]
  const mid = getTestModels('mid')
  if (mid.length > 0) return mid[0]
  return getTestModels()[0]
}

/**
 * Returns the URL of a `fetch` input.
 *
 * @param input - the input the SDK passed to `fetch`
 * @returns the URL as a string
 */
function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

/**
 * Creates an OpenAI SDK client that sends requests through the Hono test app.
 *
 * @remarks
 * A custom `fetch` routes each request to `app.request()` instead of making real HTTP calls, so
 * the SDK's response parsing and strict validation run against the proxy's response shapes. Only
 * the URL's path is passed on; the query string is dropped. The app's answer is copied into a new
 * `globalThis.Response` with the same body, status, status text and headers.
 *
 * @param proxyApp - the app to send requests to, from {@link setup}
 * @returns the client; its API key is a placeholder the test app does not check
 */
export function createTestClient(proxyApp: ReturnType<typeof testApp>): OpenAI {
  return new OpenAI({
    apiKey: 'test-key-unused',
    baseURL: 'http://localhost:4141/v1',
    maxRetries: 0,
    fetch: async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = requestUrl(input)
      const path = new URL(url).pathname
      const method = init?.method ?? 'GET'
      const headers = init?.headers ?? {}
      const body = init?.body ?? null

      const honoRes = await proxyApp.request(path, {
        method,
        headers,
        body
      })

      return new globalThis.Response(honoRes.body, {
        status: honoRes.status,
        statusText: honoRes.statusText,
        headers: Object.fromEntries(honoRes.headers.entries())
      })
    }
  })
}

/**
 * Reports whether at least one matrix model is available, that is, has credentials configured.
 *
 * @returns whether {@link getTestModels} finds any model
 */
export function hasCredentials(): boolean {
  return getTestModels().length > 0
}
