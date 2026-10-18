/**
 * The `/proxy` command (`extensions/proxy/index.ts`) routed through a fake pi, and `/proxy
 * zed-sync` (`extensions/proxy/zed-sync.ts`) against a temp Zed settings file: what each
 * subcommand shows the user and writes.
 *
 * Only subcommands that run offline are driven; `start`/`stop`/`restart`/`status` spawn or probe
 * processes and are covered elsewhere. Zed's settings path is resolved from `CUSTOM_DATA_DIR`,
 * `HOME` and `XDG_CONFIG_HOME`, all pointed at a temp dir, so the real Zed config is never read.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  ModelRegistry
} from '@earendil-works/pi-coding-agent'
import { DEFAULT_CONFIG } from '@proxy/config/schema'
import { getRuntime } from '@proxy/pi/registry'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi
} from 'vite-plus/test'

import proxyExtension from '../../extensions/proxy/index'
import { type FixtureAgentDir, loadFixtureAgentDir, offlineProvider } from '../fixtures/agent-dir'
import { fakeCommandContext, type Notification } from '../fixtures/extension-context'

vi.mock('@vx-daniel/pi-openai-proxy/config', () => import('@proxy/config/schema'))
vi.mock('@vx-daniel/pi-openai-proxy/exposure', () => import('@proxy/openai/model-exposure'))
vi.mock('@vx-daniel/pi-openai-proxy/logging', () => import('@proxy/logging'))
vi.mock('@vx-daniel/pi-openai-proxy/sync/zed', () => import('@proxy/sync/zed'))

const USAGE =
  '/proxy [start|stop|restart|status|verify|models|zed-sync|config|show|path|reset|help]'

/** The exposure error `universal` mode gives when two providers share a model ID. */
const UNIVERSAL_CONFLICT =
  "Universal mode conflict: model ID 'shared' is provided by both 'alpha' and 'beta'. Use 'collision-prefixed' or 'always-prefixed' mode, or reduce the exposed model set."

/** The Zed settings pi users start from: one unrelated key and a comment to keep. */
const ZED_SETTINGS = '{\n  // my theme\n  "theme": "One Dark"\n}\n'

type CommandHandler = (args: string, context: ExtensionCommandContext) => Promise<void>

/** Loads the extension into a fake pi and returns the `/proxy` command's handler. */
function loadProxyCommand(): CommandHandler {
  const registerCommand = vi.fn<ExtensionAPI['registerCommand']>()
  proxyExtension({ on: vi.fn(), registerCommand })
  const options = registerCommand.mock.calls[0]?.[1]
  if (options === undefined) throw new Error('the extension registered no command')
  return options.handler
}

/** Runs `/proxy <args>` and returns what it showed the user. */
async function runProxy(args: string, hasUI = false): Promise<Notification[]> {
  const { context, notifications } = fakeCommandContext({
    modelRegistry: new ModelRegistry(getRuntime()),
    hasUI
  })
  await loadProxyCommand()(args, context)
  return notifications
}

describe('/proxy with models on two providers', () => {
  let agentDir: FixtureAgentDir
  let zedRoot: string
  let zedSettingsPath: string

  /** Writes `proxy-config.json` into the fixture agent dir. */
  function writeProxyConfig(config: Record<string, unknown>): void {
    writeFileSync(join(agentDir.path, 'proxy-config.json'), JSON.stringify(config))
  }

  beforeAll(async () => {
    agentDir = await loadFixtureAgentDir({
      modelsJson: {
        providers: {
          alpha: offlineProvider('a1', 'shared'),
          beta: offlineProvider('shared', 'b1')
        }
      }
    })
  })

  beforeEach(() => {
    zedRoot = mkdtempSync(join(tmpdir(), 'pi-proxy-zed-'))
    const zedDir = join(zedRoot, 'zed')
    mkdirSync(zedDir)
    zedSettingsPath = join(zedDir, 'settings.json')
    vi.stubEnv('CUSTOM_DATA_DIR', zedDir)
    vi.stubEnv('HOME', zedRoot)
    vi.stubEnv('XDG_CONFIG_HOME', zedRoot)
    vi.stubEnv('PI_PROXY_EXTENSION_LOG_FILE', '')
    writeProxyConfig({ modelExposureMode: 'all' })
  })

  afterEach(() => {
    rmSync(zedRoot, { recursive: true, force: true })
  })

  afterAll(() => {
    vi.unstubAllEnvs()
    agentDir.remove()
  })

  // Catches `/proxy help` showing nothing or a stale subcommand list.
  test('help shows the usage line', async () => {
    expect(await runProxy('help')).toEqual([{ message: USAGE, level: 'info' }])
  })

  // Catches a typo silently doing nothing instead of showing the usage line as a warning.
  test('an unknown subcommand shows the usage line', async () => {
    expect(await runProxy('  bogus extra')).toEqual([{ message: USAGE, level: 'warning' }])
  })

  // Catches an inherited object key being run as a subcommand.
  test('an object prototype key is unknown', async () => {
    expect(await runProxy('toString')).toEqual([{ message: USAGE, level: 'warning' }])
  })

  // Catches the settings panel opening without an interactive UI (pi print/RPC mode).
  test.each(['', 'config'])('%j without a UI points at /proxy show', async (args) => {
    expect(await runProxy(args)).toEqual([
      { message: '/proxy requires interactive mode. Use /proxy show instead.', level: 'warning' }
    ])
  })

  // Catches `/proxy path` showing a path other than the config file pi reads.
  test('path shows the config file', async () => {
    expect(await runProxy('path')).toEqual([
      { message: join(agentDir.path, 'proxy-config.json'), level: 'info' }
    ])
  })

  // Catches `/proxy reset` keeping an invalid authToken (#82): the reset is an explicit choice, so
  // it must write the defaults, auth off included, rather than leave every request refused.
  test('reset replaces an invalid authToken with the defaults', async () => {
    writeProxyConfig({ authToken: 12345, port: 5151 })

    expect(await runProxy('reset')).toEqual([
      { message: 'Proxy settings reset to defaults', level: 'info' }
    ])
    expect(JSON.parse(readFileSync(join(agentDir.path, 'proxy-config.json'), 'utf-8'))).toEqual(
      DEFAULT_CONFIG
    )
  })

  // Catches `/proxy models` being routed to the wrong report.
  test('models lists the exposed models', async () => {
    expect(await runProxy('models')).toEqual([
      {
        message:
          '4 exposed model(s)\n\nalpha (2):\n  alpha/a1\n  alpha/shared\n\n' +
          'beta (2):\n  beta/shared\n  beta/b1',
        level: 'info'
      }
    ])
  })

  describe('zed-sync', () => {
    // Catches a dry run writing Zed's settings, not saying what it would change, or saying it is a
    // dry run twice (#92).
    test('--dry-run reports the change and leaves the file alone', async () => {
      writeFileSync(zedSettingsPath, ZED_SETTINGS)
      expect(await runProxy('zed-sync --dry-run')).toEqual([
        {
          message: `Zed sync: [dry-run] 4 added (${zedSettingsPath})`,
          level: 'info'
        }
      ])
      expect(readFileSync(zedSettingsPath, 'utf-8')).toEqual(ZED_SETTINGS)
    })

    // Catches a sync that reports success but writes no models, or drops the user's comment.
    test('writes the models into Zed settings', async () => {
      writeFileSync(zedSettingsPath, ZED_SETTINGS)
      expect(await runProxy('zed-sync')).toEqual([
        { message: `Zed sync: 4 added (${zedSettingsPath})`, level: 'info' }
      ])
      const written = readFileSync(zedSettingsPath, 'utf-8')
      expect(written).toContain('// my theme')
      expect(written).toContain('"api_url": "http://127.0.0.1:4141/v1"')
      expect(written).toContain('"name": "alpha/shared"')
    })

    // Catches an exposure error being synced as a partial model list instead of shown.
    test('an exposure error is shown and nothing is written', async () => {
      writeFileSync(zedSettingsPath, ZED_SETTINGS)
      writeProxyConfig({ modelExposureMode: 'all', publicModelIdMode: 'universal' })
      expect(await runProxy('zed-sync')).toEqual([
        { message: `Zed sync: Model exposure error: ${UNIVERSAL_CONFLICT}`, level: 'error' }
      ])
      expect(readFileSync(zedSettingsPath, 'utf-8')).toEqual(ZED_SETTINGS)
    })

    // Catches a missing Zed install being reported as success.
    test('missing Zed settings is an error', async () => {
      expect(await runProxy('zed-sync')).toEqual([
        {
          message:
            'Zed sync: Zed settings.json not found. Checked ~/.config/zed/settings.json and $XDG_CONFIG_HOME/zed/settings.json',
          level: 'error'
        }
      ])
    })
  })
})

describe('/proxy zed-sync with no models', () => {
  let agentDir: FixtureAgentDir

  beforeAll(async () => {
    agentDir = await loadFixtureAgentDir()
    const zedRoot = join(agentDir.path, 'zed-home')
    vi.stubEnv('CUSTOM_DATA_DIR', zedRoot)
    vi.stubEnv('HOME', zedRoot)
    vi.stubEnv('XDG_CONFIG_HOME', zedRoot)
    vi.stubEnv('PI_PROXY_EXTENSION_LOG_FILE', '')
  })

  afterAll(() => {
    vi.unstubAllEnvs()
    agentDir.remove()
  })

  // Catches an empty model set wiping the Zed provider block instead of stopping.
  test('reports nothing to sync', async () => {
    expect(await runProxy('zed-sync')).toEqual([
      { message: 'Zed sync: No models exposed. Nothing to sync.', level: 'error' }
    ])
  })
})
