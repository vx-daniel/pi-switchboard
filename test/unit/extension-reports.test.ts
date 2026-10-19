/**
 * The `/proxy show`, `/proxy models` and `/proxy verify` reports
 * (`extensions/proxy/reports.ts`), over a fixture agent directory: what text each config and
 * model set produces.
 *
 * The extension imports the package through its published subpaths, which resolve to `dist/`;
 * these tests point them at the sources, so they run before any build.
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { ModelRegistry, SettingsManager } from '@earendil-works/pi-coding-agent'
import { DEFAULT_CONFIG } from '@proxy/config/schema'
import { getRuntime } from '@proxy/pi/registry'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vite-plus/test'

import {
  buildConfigReport,
  buildModelsReport,
  buildVerifyReport
} from '../../extensions/proxy/reports'
import type { ProxyState } from '../../extensions/proxy/state'
import { type FixtureAgentDir, loadFixtureAgentDir, offlineProvider } from '../fixtures/agent-dir'

vi.mock('@vx-daniel/pi-openai-proxy/config', () => import('@proxy/config/schema'))
vi.mock('@vx-daniel/pi-openai-proxy/exposure', () => import('@proxy/openai/model-exposure'))
vi.mock('@vx-daniel/pi-openai-proxy/logging', () => import('@proxy/logging'))

/** The server line of `/proxy show` for the default config. */
const DEFAULT_SERVER_LINE =
  'lifetime: detached | host: 127.0.0.1 | port: 4141 | auth: disabled | remote images: false | max body: 50 MB | timeout: 120s'

/** The first five public IDs, and the count of the rest, for the two-provider fixture. */
const ALL_EXPOSED_PREVIEW = 'alpha/a1, alpha/a2, alpha/a3, alpha/a4, alpha/a5 (+3 more)'

/** The exposure error `universal` mode gives when two providers share a model ID. */
const UNIVERSAL_CONFLICT =
  "Universal mode conflict: model ID 'shared' is provided by both 'alpha' and 'beta'. Use 'collision-prefixed' or 'always-prefixed' mode, or reduce the exposed model set."

/**
 * Writes `proxy-config.json` into the agent dir and returns a state over its models.
 *
 * @remarks
 * The state starts with {@link DEFAULT_CONFIG}; each report reloads the file into it.
 *
 * @param agentDir - the fixture agent dir that receives the config file
 * @param config - the raw `proxy-config.json` content
 * @param enabledModels - pi's `enabledModels` patterns; `undefined` leaves the setting unset
 * @returns a {@link ProxyState} with a fresh model registry and in-memory pi settings
 */
function stateWith(
  agentDir: FixtureAgentDir,
  config: Record<string, unknown>,
  enabledModels?: string[]
): ProxyState {
  writeFileSync(join(agentDir.path, 'proxy-config.json'), JSON.stringify(config))
  return {
    config: { ...DEFAULT_CONFIG },
    sessionProcess: undefined,
    modelRegistry: new ModelRegistry(getRuntime()),
    settingsManager: SettingsManager.inMemory(enabledModels === undefined ? {} : { enabledModels }),
    packageRoot: agentDir.path
  }
}

describe('with models on two providers', () => {
  let agentDir: FixtureAgentDir

  beforeAll(async () => {
    agentDir = await loadFixtureAgentDir({
      modelsJson: {
        providers: {
          alpha: offlineProvider('a1', 'a2', 'a3', 'a4', 'a5', 'shared'),
          beta: offlineProvider('shared', 'b1')
        }
      }
    })
  })

  afterAll(() => {
    vi.unstubAllEnvs()
    agentDir.remove()
  })

  describe('buildConfigReport', () => {
    // Catches the defaults losing a server field or the preview losing its "+N more" count.
    test('defaults: auth disabled, every model exposed', async () => {
      const report = await buildConfigReport(stateWith(agentDir, {}))
      expect(report).toEqual(
        `${DEFAULT_SERVER_LINE}\nid mode: collision-prefixed | exposure: scoped | exposed: ${ALL_EXPOSED_PREVIEW}`
      )
    })

    // Catches the auth token, the scoped pattern count or unresolved patterns going missing.
    test('scoped with patterns and an auth token', async () => {
      const state = stateWith(agentDir, { authToken: 'notarealsecret-token', port: 5151 }, [
        'alpha/a1',
        'nothing-like-this'
      ])
      const report = await buildConfigReport(state)
      expect(report).toEqual(
        'lifetime: detached | host: 127.0.0.1 | port: 5151 | auth: enabled (token: notarealsecret-token) | remote images: false | max body: 50 MB | timeout: 120s\n' +
          'id mode: collision-prefixed | exposure: scoped | enabled: 2 pi pattern(s) | exposed: a1 | unresolved: nothing-like-this (no-match)'
      )
    })

    // Catches `/proxy show` reporting auth as "disabled" while the proxy refuses every request
    // because the file's authToken is not a string (#82).
    test('an authToken that is not a string shows as invalid', async () => {
      const report = await buildConfigReport(stateWith(agentDir, { authToken: 12345 }))
      expect(report).toEqual(
        'lifetime: detached | host: 127.0.0.1 | port: 4141 | auth: invalid (authToken in proxy-config.json is not a string: every request is refused) | remote images: false | max body: 50 MB | timeout: 120s\n' +
          `id mode: collision-prefixed | exposure: scoped | exposed: ${ALL_EXPOSED_PREVIEW}`
      )
    })

    // Catches scoped mode with an empty pattern list printing an "enabled: 0" field.
    test('scoped with an empty pattern list', async () => {
      const report = await buildConfigReport(stateWith(agentDir, {}, []))
      expect(report).toEqual(
        `${DEFAULT_SERVER_LINE}\nid mode: collision-prefixed | exposure: scoped | exposed: ${ALL_EXPOSED_PREVIEW}`
      )
    })

    // Catches the custom model count or the provider prefixes going missing.
    test('custom models and provider prefixes', async () => {
      const state = stateWith(agentDir, {
        modelExposureMode: 'custom',
        customModels: ['alpha/a1', 'beta/b1'],
        providerPrefixes: { alpha: 'al', beta: 'be' },
        publicModelIdMode: 'always-prefixed'
      })
      const report = await buildConfigReport(state)
      expect(report).toEqual(
        `${DEFAULT_SERVER_LINE}\nid mode: always-prefixed | exposure: custom | models: 2 custom | prefixes: alpha=al, beta=be | exposed: al/a1, be/b1`
      )
    })

    // Catches custom mode with no models printing a "models: 0 custom" field, or showing every
    // model as exposed when none is (#88).
    test('custom mode with no models', async () => {
      const state = stateWith(agentDir, { modelExposureMode: 'custom', customModels: [] })
      const report = await buildConfigReport(state)
      expect(report).toEqual(
        `${DEFAULT_SERVER_LINE}\nid mode: collision-prefixed | exposure: custom | exposed: none`
      )
    })

    // Catches an exposure error being dropped instead of shown.
    test('an exposure error', async () => {
      const state = stateWith(agentDir, {
        modelExposureMode: 'all',
        publicModelIdMode: 'universal'
      })
      const report = await buildConfigReport(state)
      expect(report).toEqual(
        `${DEFAULT_SERVER_LINE}\nid mode: universal | exposure: all | error: ${UNIVERSAL_CONFLICT}`
      )
    })

    // Catches the reloaded config not being stored on the state.
    test('stores the reloaded config on the state', async () => {
      const state = stateWith(agentDir, { port: 6161 })
      await buildConfigReport(state)
      expect(state.config).toEqual({ ...DEFAULT_CONFIG, port: 6161 })
    })
  })

  describe('buildModelsReport', () => {
    // Catches models being grouped under the wrong provider, or the canonical ID shown when it
    // equals the public ID.
    test('groups exposed models by provider', async () => {
      const state = stateWith(agentDir, {
        modelExposureMode: 'custom',
        customModels: ['alpha/a1', 'alpha/a2', 'beta/b1'],
        providerPrefixes: { beta: 'be' },
        publicModelIdMode: 'always-prefixed'
      })
      const report = await buildModelsReport(state)
      expect(report).toEqual({
        message:
          '3 exposed model(s)\n\n' +
          'alpha (2):\n  alpha/a1\n  alpha/a2\n\n' +
          'beta (1):\n  be/b1  (beta/b1)',
        level: 'info'
      })
    })

    // Catches an exposure error being hidden behind an empty or partial model list.
    test('an exposure error', async () => {
      const state = stateWith(agentDir, {
        modelExposureMode: 'all',
        publicModelIdMode: 'universal'
      })
      const report = await buildModelsReport(state)
      expect(report).toEqual({
        message: `Model exposure error: ${UNIVERSAL_CONFLICT}`,
        level: 'warning'
      })
    })

    // Catches the reloaded config not being stored on the state.
    test('stores the reloaded config on the state', async () => {
      const state = stateWith(agentDir, { port: 7171 })
      await buildModelsReport(state)
      expect(state.config).toEqual({ ...DEFAULT_CONFIG, port: 7171 })
    })
  })

  describe('buildVerifyReport', () => {
    // Catches a clean config reporting an issue, or the wrong exposed count.
    test('passes with every model exposed', async () => {
      const report = await buildVerifyReport(stateWith(agentDir, { modelExposureMode: 'all' }))
      expect(report).toEqual({
        message: 'Verification passed. 8 models exposed.',
        level: 'info'
      })
    })

    // Catches unavailable custom models going unreported.
    test('custom models that are not available', async () => {
      const state = stateWith(agentDir, {
        modelExposureMode: 'custom',
        customModels: ['alpha/a1', 'gamma/g1', 'beta/nope']
      })
      const report = await buildVerifyReport(state)
      expect(report).toEqual({
        message:
          'Verification found 2 issue(s):\n' +
          "Custom model 'gamma/g1' is not available (no auth or unknown).\n" +
          "Custom model 'beta/nope' is not available (no auth or unknown).",
        level: 'warning'
      })
    })

    // Catches an empty custom list going unreported. "Will expose 0 models" is today's text,
    // though the proxy exposes every model then: #88 decides which is right.
    test('custom mode with an empty list', async () => {
      const state = stateWith(agentDir, { modelExposureMode: 'custom', customModels: [] })
      const report = await buildVerifyReport(state)
      expect(report).toEqual({
        message:
          'Verification found 1 issue(s):\nCustom mode with empty model list will expose 0 models.',
        level: 'warning'
      })
    })

    // Catches an exposure error being left out of the issues.
    test('an exposure error', async () => {
      const state = stateWith(agentDir, {
        modelExposureMode: 'all',
        publicModelIdMode: 'universal'
      })
      const report = await buildVerifyReport(state)
      expect(report).toEqual({
        message: `Verification found 1 issue(s):\n${UNIVERSAL_CONFLICT}`,
        level: 'warning'
      })
    })
  })
})

describe('with no models', () => {
  let agentDir: FixtureAgentDir

  beforeAll(async () => {
    agentDir = await loadFixtureAgentDir()
  })

  afterAll(() => {
    vi.unstubAllEnvs()
    agentDir.remove()
  })

  // Catches an empty exposure printing an empty list instead of "none".
  test('buildConfigReport shows none exposed', async () => {
    const report = await buildConfigReport(stateWith(agentDir, {}))
    expect(report).toEqual(
      `${DEFAULT_SERVER_LINE}\nid mode: collision-prefixed | exposure: scoped | exposed: none`
    )
  })

  // Catches an empty exposure printing a bare "0 exposed model(s)" header.
  test('buildModelsReport points at /proxy verify', async () => {
    const report = await buildModelsReport(stateWith(agentDir, {}))
    expect(report).toEqual({
      message: 'No models exposed. Check /proxy verify for details.',
      level: 'info'
    })
  })

  // Catches a model-less setup passing verification. The empty-custom-list line is pinned as
  // today's text (#88).
  test('buildVerifyReport reports that no model has auth', async () => {
    const report = await buildVerifyReport(stateWith(agentDir, { modelExposureMode: 'custom' }))
    expect(report).toEqual({
      message:
        'Verification found 2 issue(s):\n' +
        'No models have auth configured. The proxy will expose 0 models.\n' +
        'Custom mode with empty model list will expose 0 models.',
      level: 'warning'
    })
  })
})
