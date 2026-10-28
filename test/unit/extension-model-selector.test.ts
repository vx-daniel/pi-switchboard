/**
 * The custom-model selector (`extensions/proxy/model-selector.ts`) over a fixture agent directory:
 * which row Left/Right jump to, what Space saves, and what Escape reports.
 *
 * The selector renders with pi's settings-list theme, so the tests load pi's built-in dark theme.
 * The extension imports the package through its published subpaths; these tests point them at the
 * sources, as `extension-reports.test.ts` does.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'

import { initTheme, ModelRegistry, SettingsManager } from '@earendil-works/pi-coding-agent'
import type { Component } from '@earendil-works/pi-tui'
import { DEFAULT_CONFIG } from '@proxy/config/schema'
import { getRuntime } from '@proxy/pi/registry'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vite-plus/test'

import { buildModelSelectorSubmenu } from '../../extensions/proxy/model-selector'
import type { ProxyState } from '../../extensions/proxy/state'
import { type FixtureAgentDir, loadFixtureAgentDir, offlineProvider } from '../fixtures/agent-dir'

vi.mock('@vx-daniel/pi-switchboard/config', () => import('@proxy/config/schema'))
vi.mock('@vx-daniel/pi-switchboard/exposure', () => import('@proxy/openai/model-exposure'))
vi.mock('@vx-daniel/pi-switchboard/logging', () => import('@proxy/logging'))

const LEFT = '\x1B[D'
const RIGHT = '\x1B[C'
const ESCAPE = '\x1B'
const SPACE = ' '

/** Wide enough that no row is truncated. */
const RENDER_WIDTH = 100

/** The selector's cursor, in front of the selected row. */
const CURSOR = '→ '

let agentDir: FixtureAgentDir

beforeAll(async () => {
  agentDir = await loadFixtureAgentDir({
    modelsJson: {
      providers: {
        alpha: offlineProvider('a1', 'a2', 'a3'),
        beta: offlineProvider('b1', 'b2'),
        gamma: offlineProvider('c1')
      }
    }
  })
  initTheme('dark')
})

afterAll(() => {
  vi.unstubAllEnvs()
  agentDir.remove()
})

interface Selector {
  readonly component: Component
  readonly state: ProxyState
  /** What the selector passed to `done` on closing, if it has closed. */
  readonly closedWith: () => string | undefined
}

/**
 * Opens a selector over the fixture's models in `custom` exposure mode, with these models already
 * selected.
 *
 * @param customModels - the canonical model IDs selected at the start; none when omitted
 * @returns the selector's component, its state, and what it passed to `done` on closing
 */
function openSelector(customModels: string[] = []): Selector {
  const state: ProxyState = {
    config: { ...DEFAULT_CONFIG, modelExposureMode: 'custom', customModels },
    sessionProcess: undefined,
    modelRegistry: new ModelRegistry(getRuntime()),
    settingsManager: SettingsManager.inMemory({}),
    packageRoot: agentDir.path
  }
  let closed: string | undefined
  const component = buildModelSelectorSubmenu(state, (selectedValue) => {
    closed = selectedValue
  })
  return { component, state, closedWith: () => closed }
}

/**
 * Sends each key to the selector in turn.
 *
 * @param selector - the selector that receives the keys
 * @param keys - the raw key sequences, such as {@link RIGHT} or a typed character
 */
function press(selector: Selector, ...keys: string[]): void {
  for (const key of keys) selector.component.handleInput?.(key)
}

/**
 * Reads the rendered row the cursor is on.
 *
 * @param selector - the selector to render
 * @returns the row as `<model> <checked>`, such as `alpha/a1 false`, or `undefined` when no row
 *   is shown
 */
function selectedRow(selector: Selector): string | undefined {
  const row = selector.component
    .render(RENDER_WIDTH)
    .map((line) => stripVTControlCharacters(line))
    .find((line) => line.startsWith(CURSOR))
  return row?.slice(CURSOR.length).trim().replaceAll(/\s+/gu, ' ')
}

describe('Right', () => {
  // Catches Right not skipping the rest of a provider, or overshooting the next one.
  test('jumps to the first model of each next provider, then to the last row', () => {
    const selector = openSelector()
    expect(selectedRow(selector)).toEqual('alpha/a1 false')

    press(selector, RIGHT)
    expect(selectedRow(selector)).toEqual('beta/b1 false')
    press(selector, RIGHT)
    expect(selectedRow(selector)).toEqual('gamma/c1 false')
    press(selector, RIGHT)
    expect(selectedRow(selector)).toEqual('gamma/c1 false')
  })

  // Catches jumping to a row the search has hidden: with only beta shown, Right has no next
  // provider on screen and stops on the last row shown.
  test('stays within the models a search shows', () => {
    const selector = openSelector()
    press(selector, 'b', 'e', 't', 'a')
    expect(selectedRow(selector)).toEqual('beta/b1 false')

    press(selector, RIGHT)
    expect(selectedRow(selector)).toEqual('beta/b2 false')
  })

  // Catches a key press crashing the selector when a search matches nothing.
  test('does nothing when a search shows no models', () => {
    const selector = openSelector()
    press(selector, 'z', 'z', 'z', RIGHT, LEFT)
    expect(selectedRow(selector)).toBeUndefined()
  })
})

describe('Left', () => {
  // Catches Left landing on the previous provider's last model (#91), which made it the mirror of
  // nothing: Right lands on the next provider's first. Also catches jumping more than one back.
  test('jumps to the first model of the previous provider, then stays at the top', () => {
    const selector = openSelector()
    press(selector, RIGHT, RIGHT)
    expect(selectedRow(selector)).toEqual('gamma/c1 false')

    press(selector, LEFT)
    expect(selectedRow(selector)).toEqual('beta/b1 false')
    press(selector, LEFT)
    expect(selectedRow(selector)).toEqual('alpha/a1 false')
    press(selector, LEFT)
    expect(selectedRow(selector)).toEqual('alpha/a1 false')
  })
})

describe('selecting', () => {
  // Catches a toggled model not being saved, or Escape reporting the wrong count.
  test('Space saves the model and Escape reports the count', () => {
    const selector = openSelector(['alpha/a1'])
    expect(selectedRow(selector)).toEqual('alpha/a1 true')

    press(selector, RIGHT, SPACE)
    expect(selectedRow(selector)).toEqual('beta/b1 true')
    const saved: unknown = JSON.parse(
      readFileSync(join(agentDir.path, 'proxy-config.json'), 'utf-8')
    )
    expect(saved).toEqual({
      ...DEFAULT_CONFIG,
      modelExposureMode: 'custom',
      customModels: ['alpha/a1', 'beta/b1']
    })
    expect(selector.state.config).toEqual(saved)

    press(selector, ESCAPE)
    expect(selector.closedWith()).toEqual('2 selected')
  })

  // Catches a tick shown and counted as saved when the file broke while the selector was open:
  // the save is refused (#288), so the row must go back to what the file holds.
  test('Space on a file that is no longer valid JSON undoes the tick and saves nothing', () => {
    const selector = openSelector(['alpha/a1'])
    const path = join(agentDir.path, 'proxy-config.json')
    writeFileSync(path, '{"port": 51')

    press(selector, RIGHT, SPACE)

    expect(selectedRow(selector)).toEqual('beta/b1 false')
    expect(readFileSync(path, 'utf-8')).toBe('{"port": 51')
    press(selector, ESCAPE)
    expect(selector.closedWith()).toEqual('1 selected')
  })
})
