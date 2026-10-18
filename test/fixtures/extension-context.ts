/**
 * A fake pi `ExtensionCommandContext` for driving extension code without pi's TUI: it records what
 * the extension shows (`ui.notify`, `ui.setStatus`) and fails loudly if anything else is touched.
 */

import type { ExtensionCommandContext, ModelRegistry } from '@earendil-works/pi-coding-agent'
import { vi } from 'vite-plus/test'

/** One `ui.notify` call. */
export interface Notification {
  readonly message: string
  readonly level: 'info' | 'warning' | 'error' | undefined
}

/** One `ui.setStatus` call. */
export interface StatusUpdate {
  readonly key: string
  readonly text: string | undefined
}

export interface FakeContextOptions {
  /** The registry the extension reads models from; build it over a fixture agent dir. Reading it
   * when absent throws. */
  readonly modelRegistry?: ModelRegistry
  /** Whether pi has an interactive UI. Defaults to `false`. */
  readonly hasUI?: boolean
}

export interface FakeContext {
  readonly context: ExtensionCommandContext
  /** Every `ui.notify` call, in order. */
  readonly notifications: Notification[]
  /** Every `ui.setStatus` call, in order. */
  readonly statuses: StatusUpdate[]
}

/** Returns a fake command context that records notifications and status updates. */
export function fakeCommandContext(options: FakeContextOptions): FakeContext {
  const notifications: Notification[] = []
  const statuses: StatusUpdate[] = []
  const context: ExtensionCommandContext = {
    ui: {
      notify(message, level) {
        notifications.push({ message, level })
      },
      setStatus(key, text) {
        statuses.push({ key, text })
      },
      select: vi.fn(),
      confirm: vi.fn(),
      input: vi.fn(),
      onTerminalInput: vi.fn(),
      setWorkingMessage: vi.fn(),
      setWorkingVisible: vi.fn(),
      setWorkingIndicator: vi.fn(),
      setHiddenThinkingLabel: vi.fn(),
      setWidget: vi.fn(),
      setFooter: vi.fn(),
      setHeader: vi.fn(),
      setTitle: vi.fn(),
      custom: vi.fn(),
      pasteToEditor: vi.fn(),
      setEditorText: vi.fn(),
      getEditorText: vi.fn(),
      editor: vi.fn(),
      addAutocompleteProvider: vi.fn(),
      setEditorComponent: vi.fn(),
      getEditorComponent: vi.fn(),
      get theme(): never {
        throw new Error('fake extension context: ui.theme is not available in tests')
      },
      getAllThemes: vi.fn(),
      getTheme: vi.fn(),
      setTheme: vi.fn(),
      getToolsExpanded: vi.fn(),
      setToolsExpanded: vi.fn()
    },
    mode: 'print',
    hasUI: options.hasUI ?? false,
    cwd: process.cwd(),
    get sessionManager(): never {
      throw new Error('fake extension context: sessionManager is not available in tests')
    },
    get modelRegistry(): ModelRegistry {
      if (options.modelRegistry === undefined) {
        throw new Error('fake extension context: no modelRegistry was given')
      }
      return options.modelRegistry
    },
    model: undefined,
    scopedModels: [],
    isIdle: vi.fn(),
    isProjectTrusted: vi.fn(),
    signal: undefined,
    abort: vi.fn(),
    hasPendingMessages: vi.fn(),
    shutdown: vi.fn(),
    getContextUsage: vi.fn(),
    compact: vi.fn(),
    getSystemPrompt: vi.fn(),
    getSystemPromptOptions: vi.fn(),
    waitForIdle: vi.fn(),
    newSession: vi.fn(),
    fork: vi.fn(),
    navigateTree: vi.fn(),
    switchSession: vi.fn(),
    reload: vi.fn()
  }
  return { context, notifications, statuses }
}
