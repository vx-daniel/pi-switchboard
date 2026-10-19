/**
 * The `/proxy settings` panel's changes (`extensions/proxy/settings-panel.ts`): what each choice
 * writes to `proxy-config.json`, and the descriptions the panel shows for the new config.
 *
 * The config file lives in a fixture agent directory (`PI_CODING_AGENT_DIR`), never the real one.
 * The extension imports the package through its published subpaths; these tests point them at the
 * sources, as `extension-reports.test.ts` does.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { SettingsManager } from '@earendil-works/pi-coding-agent'
import type { SettingItem } from '@earendil-works/pi-tui'
import { resetSync } from '@logtape/logtape'
import { DEFAULT_CONFIG, loadConfigFromFile, type ProxyConfig } from '@proxy/config/schema'
import { configureLogging } from '@proxy/logging'
import { isRecord } from '@proxy/utils/guards'
import { afterEach, assert, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

import {
  applySetting,
  buildSettingItems,
  refreshDescriptions
} from '../../extensions/proxy/settings-panel'
import type { ProxyState } from '../../extensions/proxy/state'
import { maybeAutoSyncZed } from '../../extensions/proxy/zed-sync'
import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'
import { fakeCommandContext } from '../fixtures/extension-context'

vi.mock('@vx-daniel/pi-openai-proxy/config', () => import('@proxy/config/schema'))
vi.mock('@vx-daniel/pi-openai-proxy/exposure', () => import('@proxy/openai/model-exposure'))
vi.mock('@vx-daniel/pi-openai-proxy/logging', () => import('@proxy/logging'))

/** A generated token: 16 random bytes as lowercase hex. */
const GENERATED_TOKEN = /^[0-9a-f]{32}$/u

/** A token the user already has. */
const EXISTING_TOKEN = 'notarealsecret-existing-token'

let agentDir: FixtureAgentDir
let logLines: string[] = []

beforeEach(async () => {
  agentDir = await loadFixtureAgentDir()
  logLines = []
  configureLogging({ level: 'debug', format: 'json', write: (line) => logLines.push(line) })
})

afterEach(() => {
  resetSync()
  vi.unstubAllEnvs()
  agentDir.remove()
})

/**
 * Returns a state holding this config, as the panel has it after loading.
 *
 * @param config - the fields that differ from {@link DEFAULT_CONFIG}
 * @returns a {@link ProxyState} with no model registry and empty in-memory pi settings
 */
function stateWith(config: Partial<ProxyConfig> = {}): ProxyState {
  return {
    config: { ...DEFAULT_CONFIG, ...config },
    sessionProcess: undefined,
    modelRegistry: undefined,
    settingsManager: SettingsManager.inMemory({}),
    packageRoot: agentDir.path
  }
}

/**
 * Reads the config the panel wrote to the fixture agent dir.
 *
 * @returns the parsed `proxy-config.json`
 * @throws Error when the file is missing or is not valid JSON
 */
function savedConfig(): unknown {
  return JSON.parse(readFileSync(join(agentDir.path, 'proxy-config.json'), 'utf-8'))
}

/**
 * Returns the captured warnings.
 *
 * @returns each `WARN` log record as `{ message, properties }`, in log order
 * @throws AssertionError when a captured log line is not a JSON object
 */
function warnings(): { message: unknown; properties: unknown }[] {
  return logLines.flatMap((line) => {
    const record: unknown = JSON.parse(line)
    assert(isRecord(record), 'a log line is not a JSON object')
    return record['level'] === 'WARN'
      ? [{ message: record['message'], properties: record['properties'] }]
      : []
  })
}

describe('applySetting: proxy auth', () => {
  // Catches enabling auth leaving the proxy open, or not handing the user the token it set.
  test('enabling with no token generates one, saves it and returns it', () => {
    const state = stateWith()
    const token = applySetting(state, 'authToken', 'enabled')

    expect(token).toMatch(GENERATED_TOKEN)
    expect(savedConfig()).toEqual({ ...DEFAULT_CONFIG, authToken: token })
    expect(state.config).toEqual({ ...DEFAULT_CONFIG, authToken: token })
  })

  // Catches re-enabling auth replacing a token every client is already configured with.
  test('enabling with a token keeps it and generates none', () => {
    const state = stateWith({ authToken: EXISTING_TOKEN })
    const token = applySetting(state, 'authToken', 'enabled')

    expect(token).toBeUndefined()
    expect(savedConfig()).toEqual({ ...DEFAULT_CONFIG, authToken: EXISTING_TOKEN })
  })

  // Catches disabling auth leaving the old token in force.
  test('disabling clears the token', () => {
    const state = stateWith({ authToken: EXISTING_TOKEN })
    const token = applySetting(state, 'authToken', 'disabled')

    expect(token).toBeUndefined()
    expect(savedConfig()).toEqual(DEFAULT_CONFIG)
    expect(state.config).toEqual(DEFAULT_CONFIG)
  })
})

describe('applySetting: the other settings', () => {
  // Catches a panel choice not reaching the saved config, or landing in the wrong field.
  test.each<[string, string, Partial<ProxyConfig>]>([
    ['lifetime', 'session', { lifetime: 'session' }],
    ['host', '0.0.0.0', { host: '0.0.0.0' }],
    ['port', '8080', { port: 8080 }],
    ['remoteImages', 'on', { remoteImages: true }],
    ['maxBodySizeMb', '200 MB', { maxBodySizeMb: 200 }],
    ['upstreamTimeoutSec', '300s', { upstreamTimeoutSec: 300 }],
    ['logLevel', 'debug', { logLevel: 'debug' }],
    ['publicModelIdMode', 'always-prefixed', { publicModelIdMode: 'always-prefixed' }],
    ['modelExposureMode', 'custom', { modelExposureMode: 'custom' }],
    ['zed.autoSync', 'on', { zed: { ...DEFAULT_CONFIG.zed, autoSync: true } }]
  ])('%s = %s is saved', (id, value, change) => {
    const state = stateWith()
    expect(applySetting(state, id, value)).toBeUndefined()
    expect(savedConfig()).toEqual({ ...DEFAULT_CONFIG, ...change })
    expect(state.config).toEqual({ ...DEFAULT_CONFIG, ...change })
    expect(warnings()).toEqual([])
  })

  // Catches closing the model selector rewriting the models it just saved.
  test('customModels keeps the selected models', () => {
    const state = stateWith({ modelExposureMode: 'custom', customModels: ['alpha/a1'] })
    applySetting(state, 'customModels', '1 selected')

    expect(savedConfig()).toEqual({
      ...DEFAULT_CONFIG,
      modelExposureMode: 'custom',
      customModels: ['alpha/a1']
    })
  })

  // Catches an invalid value being saved, or being dropped without a word in the log.
  test('a value it cannot apply leaves the config and warns', () => {
    const state = stateWith()
    applySetting(state, 'logLevel', 'loud')

    expect(savedConfig()).toEqual(DEFAULT_CONFIG)
    expect(warnings()).toEqual([
      {
        message: 'Setting "logLevel": value "loud" not applied as given; now "info"',
        properties: { settingId: 'logLevel', value: 'loud', applied: 'info' }
      }
    ])
  })

  // Catches an unknown setting crashing the panel, corrupting the config, or warning twice (the
  // second warning claimed a value "not applied" for a setting that does not exist, #95).
  test('an unknown setting warns once and changes nothing', () => {
    const state = stateWith({ port: 5151 })
    expect(applySetting(state, 'colour', 'blue')).toBeUndefined()

    expect({
      config: state.config,
      fileWritten: existsSync(join(agentDir.path, 'proxy-config.json')),
      warnings: warnings()
    }).toEqual({
      config: { ...DEFAULT_CONFIG, port: 5151 },
      fileWritten: false,
      warnings: [
        { message: 'Unknown setting "colour"; ignored', properties: { settingId: 'colour' } }
      ]
    })
  })
})

describe('refreshDescriptions', () => {
  /**
   * Builds the panel's rows whose descriptions depend on the config, plus one that does not.
   *
   * @returns one row per setting ID, each with the description `stale`
   */
  function items(): SettingItem[] {
    return ['publicModelIdMode', 'modelExposureMode', 'customModels', 'authToken', 'host'].map(
      (settingId) => ({ id: settingId, label: settingId, description: 'stale', currentValue: '' })
    )
  }

  /**
   * Builds the rows with these descriptions, in the order `items()` builds them.
   *
   * @param descriptions - the expected descriptions; rows past the last one stay `stale`
   * @returns the rows from `items()` with the given descriptions
   */
  function described(...descriptions: string[]): SettingItem[] {
    return items().map((row, index) => ({ ...row, description: descriptions[index] ?? 'stale' }))
  }

  // Catches the panel describing the previous mode, or showing a whole token on screen.
  test('custom exposure, prefixed IDs and a token', () => {
    const rows = items()
    refreshDescriptions(rows, {
      ...DEFAULT_CONFIG,
      publicModelIdMode: 'always-prefixed',
      modelExposureMode: 'custom',
      authToken: EXISTING_TOKEN
    })

    expect(rows).toEqual(
      described(
        'Always provider/model-id for every model',
        'Expose only manually selected models',
        'Press Enter to open model selector',
        'Token: notarea... (use /proxy token to copy)'
      )
    )
  })

  // Catches the defaults offering the model selector, or a token preview with no token.
  test('defaults', () => {
    const rows = items()
    refreshDescriptions(rows, DEFAULT_CONFIG)

    expect(rows).toEqual(
      described(
        'Short names; adds provider/ prefix only when models collide',
        "Expose models from pi's configured auth (default)",
        "Switch exposure mode to 'custom' to select models",
        'Require bearer token for all requests'
      )
    )
  })
})

describe('an invalid authToken in the file (#82)', () => {
  /**
   * Writes a `proxy-config.json` whose `authToken` is not a string, and loads it as the panel
   * does.
   *
   * @returns a state holding the loaded config
   */
  function stateFromInvalidFile(): ProxyState {
    writeFileSync(
      join(agentDir.path, 'proxy-config.json'),
      JSON.stringify({ authToken: 12345, port: 4141 })
    )
    return { ...stateWith(), config: loadConfigFromFile() }
  }

  // Catches the panel showing a token the proxy refuses requests for as "disabled", or Enter on
  // that row going to `disabled` first, which would turn auth off with one key press.
  test('the auth row says invalid, and Enter goes to enabled first', () => {
    const row = buildSettingItems(stateFromInvalidFile()).find(
      (settingRow) => settingRow.id === 'authToken'
    )

    expect(row).toEqual({
      id: 'authToken',
      label: 'Proxy auth',
      description:
        'authToken in proxy-config.json is not a string: every request is refused. Enable to set a new token',
      currentValue: 'invalid',
      values: ['enabled', 'disabled']
    })
  })

  // Catches changing another setting writing the repaired '' and so turning auth off for good.
  test('changing another setting keeps it in the file', () => {
    applySetting(stateFromInvalidFile(), 'port', '8080')

    expect(savedConfig()).toEqual({ ...DEFAULT_CONFIG, port: 8080, authToken: 12345 })
  })

  // Catches enabling auth from the invalid state not replacing it with a usable token.
  test('enabling replaces it with a generated token', () => {
    const state = stateFromInvalidFile()
    const token = applySetting(state, 'authToken', 'enabled')

    expect(token).toMatch(GENERATED_TOKEN)
    expect(savedConfig()).toEqual({ ...DEFAULT_CONFIG, authToken: token })
  })

  // Catches an explicit disable on the auth row not being able to clear it.
  test('disabling replaces it with off', () => {
    applySetting(stateFromInvalidFile(), 'authToken', 'disabled')

    expect(savedConfig()).toEqual(DEFAULT_CONFIG)
  })
})

describe('Zed auto-sync after a change', () => {
  // Catches auto-sync rejecting when it cannot run (#111): the panel does not wait for it, so a
  // rejection would go unhandled, and at session start it would stop the status refresh. It is
  // logged as a warning and shown nowhere.
  test('with no model registry yet: resolves, warns, shows nothing', async () => {
    const state = stateWith({ zed: { ...DEFAULT_CONFIG.zed, autoSync: true } })
    const { context, notifications } = fakeCommandContext({})

    await expect(maybeAutoSyncZed(state, context)).resolves.toBeUndefined()

    expect({ notifications, warned: warnings().map((warning) => warning.message) }).toEqual({
      notifications: [],
      warned: [expect.stringMatching(/^Zed auto-sync failed: /u) as string]
    })
  })
})
