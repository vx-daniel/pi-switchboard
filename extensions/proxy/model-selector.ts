/**
 * Custom-model selector submenu: a toggleable checklist of every available model,
 * with Left/Right jumping between providers.
 *
 * @packageDocumentation
 */

import { getSettingsListTheme } from '@earendil-works/pi-coding-agent'
import { type Component, type SettingItem, SettingsList } from '@earendil-works/pi-tui'
import {
  getConfigPath,
  loadConfigFromFile,
  saveConfigToFile
} from '@vx-daniel/pi-switchboard/config'
import { proxyLogger } from '@vx-daniel/pi-switchboard/logging'

import { getSessionAvailableModels, type ProxyState } from './state'

/** Rows the list needs beyond one per model. */
const MODEL_SELECTOR_EXTRA_ROWS = 2
/** Cap on visible rows in the selector. */
const MODEL_SELECTOR_MAX_ROWS = 20

/** Logger for settings changes made in the selector. */
const settingsLogger = proxyLogger('extension', 'settings')

/** Direction of a provider jump: Left is `prev`, Right is `next`. */
type JumpDirection = 'prev' | 'next'

// HACK: SettingsList (pi-tui 1.3.0) can move the selection (`selectItem`) but has no public way to
// read it, or to read the rows a search shows. Provider jumping needs both, so they are read from
// private fields through Reflect, pinned to pi-tui 1.3.0 (`settings-list.js`: `selectedIndex`,
// `items`, `filteredItems`, `searchEnabled`). Writes go through `selectItem` only. Remove the reads
// when SettingsList exposes the selected item and the displayed rows.
// The unsafe access is isolated here so jumpProvider itself is fully type-safe.

/**
 * Reads the selected row's index in the displayed rows from SettingsList's private field.
 *
 * @param list - the settings list to read
 * @returns the index, or undefined if pi-tui changed the field
 */
function getSelectedIndex(list: SettingsList): number | undefined {
  const selectedIndex: unknown = Reflect.get(list, 'selectedIndex')
  return typeof selectedIndex === 'number' ? selectedIndex : undefined
}

/**
 * Checks that a value read from SettingsList's private fields looks like a setting row.
 *
 * @param value - the raw value
 * @returns whether the value is an object with a string `id`
 */
function isSettingItem(value: unknown): value is SettingItem {
  if (value === null || typeof value !== 'object') return false
  if (!('id' in value)) return false
  const candidate: { id: unknown } = value
  return typeof candidate.id === 'string'
}

/**
 * Reads the rows SettingsList displays: the search results when search is enabled, otherwise all
 * items.
 *
 * @param list - the settings list to read
 * @returns the displayed rows, or an empty array if pi-tui changed the fields
 */
function getSettingsListItems(list: SettingsList): SettingItem[] {
  const rawSearch: unknown = Reflect.get(list, 'searchEnabled')
  const raw: unknown =
    typeof rawSearch === 'boolean' && rawSearch
      ? Reflect.get(list, 'filteredItems')
      : Reflect.get(list, 'items')
  if (!Array.isArray(raw)) return []
  const result: SettingItem[] = []
  for (const rawItem of raw) {
    if (isSettingItem(rawItem)) result.push(rawItem)
  }
  return result
}

/**
 * Finds the first row of the previous provider.
 *
 * @param display - the displayed rows
 * @param providerOrder - provider names in list order
 * @param provIdx - the current provider's index in `providerOrder` (-1 when unknown)
 * @returns the target row index; 0 when already on the first provider or none is displayed
 */
function prevProviderTarget(
  display: readonly SettingItem[],
  providerOrder: readonly string[],
  provIdx: number
): number {
  if (provIdx <= 0) return 0
  const prev = providerOrder[provIdx - 1] ?? ''
  const found = display.findIndex((item) => item.id.startsWith(`${prev}/`))
  return found === -1 ? 0 : found
}

/**
 * Finds the first row of the next provider.
 *
 * @param display - the displayed rows
 * @param providerOrder - provider names in list order
 * @param provIdx - the current provider's index in `providerOrder` (-1 when unknown)
 * @returns the target row index; the last row when already on the last provider or none is
 *   displayed
 */
function nextProviderTarget(
  display: readonly SettingItem[],
  providerOrder: readonly string[],
  provIdx: number
): number {
  const lastRow = display.length - 1
  if (provIdx >= providerOrder.length - 1) return lastRow
  const next = providerOrder[provIdx + 1] ?? ''
  const found = display.findIndex((item) => item.id.startsWith(`${next}/`))
  return found === -1 ? lastRow : found
}

/**
 * Moves the selection to the first row of the previous or next provider.
 *
 * @remarks
 * Does nothing when the selection or the displayed rows cannot be read.
 *
 * @param list - the settings list to move
 * @param providerOrder - provider names in list order
 * @param direction - which way to jump
 */
function jumpProvider(
  list: SettingsList,
  providerOrder: readonly string[],
  direction: JumpDirection
): void {
  const selectedIndex = getSelectedIndex(list)
  if (selectedIndex === undefined) return
  const display = getSettingsListItems(list)
  if (display.length === 0) return

  const current = display[selectedIndex]
  if (current === undefined) return
  const currentProv = current.id.split('/')[0] ?? ''
  const provIdx = providerOrder.indexOf(currentProv)

  const target =
    direction === 'prev'
      ? prevProviderTarget(display, providerOrder, provIdx)
      : nextProviderTarget(display, providerOrder, provIdx)
  const targetItem = display[target]
  if (targetItem !== undefined) list.selectItem(targetItem.id)
}

/**
 * Builds the submenu for selecting custom models: every available model as a toggleable
 * checklist, with search.
 *
 * @remarks
 * Each toggle saves `customModels` to the config file immediately. Left/Right jump between
 * providers.
 *
 * @param state - the extension state; its config holds the current selection
 * @param done - called on close with a summary such as `3 selected`
 * @returns the submenu component
 * @throws Error when the session's model registry is not available yet
 */
export function buildModelSelectorSubmenu(
  state: ProxyState,
  done: (selectedValue?: string) => void
): Component {
  const models = getSessionAvailableModels(state)
  const selected = new Set(state.config.customModels)

  // Providers in the order they first appear in the model list
  const providerOrder: string[] = []
  for (const model of models) {
    if (!providerOrder.includes(model.provider)) providerOrder.push(model.provider)
  }

  const items: SettingItem[] = models.map((model) => {
    const canonical = `${model.provider}/${model.id}`
    return {
      id: canonical,
      label: canonical,
      description: `Provider: ${model.provider}  |  Left/Right: jump provider`,
      currentValue: selected.has(canonical) ? 'true' : 'false',
      values: ['true', 'false']
    }
  })

  const list = new SettingsList(
    items,
    Math.min(items.length + MODEL_SELECTOR_EXTRA_ROWS, MODEL_SELECTOR_MAX_ROWS),
    getSettingsListTheme(),
    (id: string, newValue: string) => {
      if (newValue === 'true') {
        selected.add(id)
      } else {
        selected.delete(id)
      }
      state.config = { ...state.config, customModels: [...selected] }
      saveConfigToFile(state.config)
      state.config = loadConfigFromFile()
      settingsLogger.info('Custom model {modelId} {action}; {selectedCount} selected', {
        modelId: id,
        action: newValue === 'true' ? 'selected' : 'deselected',
        selectedCount: selected.size,
        configPath: getConfigPath()
      })
    },
    () => done(`${String(selected.size)} selected`),
    { enableSearch: true }
  )

  return {
    render(width: number): string[] {
      return list.render(width)
    },
    invalidate(): void {
      list.invalidate()
    },
    handleInput(data: string): void {
      if (data === '\x1B[D') {
        jumpProvider(list, providerOrder, 'prev')
      } else if (data === '\x1B[C') {
        jumpProvider(list, providerOrder, 'next')
      } else {
        list.handleInput(data)
      }
    }
  }
}
