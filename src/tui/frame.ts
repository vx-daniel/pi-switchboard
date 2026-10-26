/**
 * The frame around the console's view (#61), with its tabs: on a tall terminal folder tabs that
 * open into the frame's top border, the current one in front; on a short one the tabs sit in the
 * top border itself, the current one a pill. The right end of the tab row says a word about the
 * view (`idle`, `4 logins · 0 cooldowns`); the right end of the bottom border notes its size.
 *
 * @remarks
 * Rendering only, from a {@link FrameInput} and the view's rows. Every row comes out exactly
 * `layout.mainWidth` columns wide, so the sidebar can stand beside them.
 *
 * @packageDocumentation
 */

import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import type { ConsoleLayout } from '@proxy/tui/layout'
import { type View, VIEWS } from '@proxy/tui/navigation'
import { activeTab, paint, strong, tabAccent } from '@proxy/tui/theme'

/** What each tab says. */
const VIEW_LABELS: Readonly<Record<View, string>> = {
  logs: 'Requests',
  accounts: 'Accounts',
  stats: 'Stats',
  models: 'Models',
  settings: 'Settings'
}

/** The frame's left corner is a corner: the first tab starts this many columns in. */
const FIRST_TAB_COLUMN = 2
/** Columns between two tabs. */
const TAB_GAP = 1
/** Columns a folder tab adds around its label: `│ 1 Label │`. */
const FOLDER_TAB_PADDING = 6
/** Columns a compact tab adds around its label: ` 1 Label `. */
const COMPACT_TAB_PADDING = 4
/** Columns the frame's corners take on a border row. */
const CORNERS = 2
/** Columns kept clear between a row's left part and the text at its right end. */
const RIGHT_END_GAP = 2

/**
 * Says how many models are exposed, for the Models tab's context and note: from the same field
 * the status strip shows, so the two never disagree.
 *
 * @param exposed - the exposed model count, the exposure config's error, or `undefined` before
 *   the first status read
 * @param aliases - to follow the count: how many aliases are configured and how many are built
 *   in (#231); `undefined` for neither
 * @param aliases.configured - the configured aliases
 * @param aliases.latest - the built-in `-latest` aliases, left out when there are none
 * @returns `24 models · 1 alias · 8 latest`, `24 models`, `exposure config error`, or `''`
 */
export function exposedModelsLabel(
  exposed: number | string | undefined,
  aliases?: { readonly configured: number; readonly latest: number }
): string {
  if (typeof exposed === 'string') return 'exposure config error'
  if (exposed === undefined) return ''
  const models = `${String(exposed)} models`
  if (aliases === undefined) return models
  const { configured, latest } = aliases
  const counted = `${models} · ${String(configured)} ${configured === 1 ? 'alias' : 'aliases'}`
  return latest === 0 ? counted : `${counted} · ${String(latest)} latest`
}

/** What the frame shows besides the view. */
export interface FrameInput {
  readonly view: View
  readonly layout: ConsoleLayout
  /** What the right end of the tab row says about the view; `''` for nothing. */
  readonly context: string
  /** What the right end of the bottom border says about the view; `''` for nothing. */
  readonly note: string
}

/** One tab's place on the row: where it starts and how wide it is. */
interface TabSpan {
  readonly view: View
  readonly index: number
  readonly start: number
  readonly width: number
}

/**
 * Places tabs on the row, left to right, each keeping its view's digit.
 *
 * @param views - the tabs to place, in tab order
 * @param padding - the columns each tab adds around its label
 * @returns the tabs placed
 */
function layOutTabs(views: readonly View[], padding: number): TabSpan[] {
  const spans: TabSpan[] = []
  let column = FIRST_TAB_COLUMN
  for (const view of views) {
    const width = VIEW_LABELS[view].length + padding
    spans.push({ view, index: VIEWS.indexOf(view), start: column, width })
    column += width + TAB_GAP
  }
  return spans
}

/**
 * Places the tabs on the row, leaving out those the row has no room for: the last ones first, but
 * never the current view's, so the frame always shows where you are.
 *
 * @param mainWidth - the frame's columns
 * @param padding - the columns each tab adds around its label
 * @param current - the view shown
 * @returns the tabs placed
 */
function placeTabs(mainWidth: number, padding: number, current: View): TabSpan[] {
  const shown: View[] = [...VIEWS]
  for (;;) {
    const spans = layOutTabs(shown, padding)
    const last = spans.at(-1)
    if (last === undefined || last.start + last.width <= mainWidth - CORNERS) return spans
    const dropped = shown.findLastIndex((view) => view !== current)
    if (dropped === -1) return []
    shown.splice(dropped, 1)
  }
}

/**
 * Pads a row to the frame's width, or cuts it, so every row is `mainWidth` columns.
 *
 * @param row - the row
 * @param mainWidth - the frame's columns
 * @returns the row at that width
 */
function fit(row: string, mainWidth: number): string {
  return truncateToWidth(row, mainWidth, '', true)
}

/**
 * Draws the frame's border characters.
 *
 * @param text - the border text
 * @returns the text in the border's color
 */
function border(text: string): string {
  return paint('border', text)
}

/**
 * Lays a border row out: the left corner, the left part, the border line, then, when it fits,
 * text set into the line near the right corner, and the right corner.
 *
 * @param corners - the row's corners, left then right
 * @param left - the left part, drawn right after the left corner
 * @param right - the text at the right end, with its own spaces; `''` for none
 * @param mainWidth - the frame's columns
 * @returns the row, `mainWidth` columns
 */
function borderRow(
  corners: readonly [string, string],
  left: string,
  right: string,
  mainWidth: number
): string {
  const [open, close] = corners
  const room = mainWidth - CORNERS - visibleWidth(left)
  // The right text sits one border character before the corner.
  const rightWidth = right === '' ? 0 : visibleWidth(right) + 1
  if (right !== '' && rightWidth + RIGHT_END_GAP <= room) {
    return fit(
      `${border(open)}${left}${border('─'.repeat(room - rightWidth))}${right}${border(`─${close}`)}`,
      mainWidth
    )
  }
  return fit(
    `${border(open)}${left}${border(`${'─'.repeat(Math.max(0, room))}${close}`)}`,
    mainWidth
  )
}

/**
 * Lays a plain row out with text on the left and, when it fits, more text at the right end.
 *
 * @param left - the left text
 * @param right - the right text
 * @param mainWidth - the frame's columns
 * @returns the row, `mainWidth` columns
 */
function rowWithRightEnd(left: string, right: string, mainWidth: number): string {
  const room = mainWidth - CORNERS - visibleWidth(right)
  if (right === '' || visibleWidth(left) + RIGHT_END_GAP > room) return fit(left, mainWidth)
  return fit(`${left}${' '.repeat(room - visibleWidth(left))}${right}`, mainWidth)
}

/**
 * Renders the two rows of folder tabs above the frame: their top edges, then their labels, with
 * the view's context at the right end of the label row.
 *
 * @param input - the view, the layout and the context
 * @returns the two rows, each `mainWidth` columns
 */
function folderTabRows(input: FrameInput): string[] {
  const { mainWidth } = input.layout
  let edges = ''
  let labels = ''
  for (const tab of placeTabs(mainWidth, FOLDER_TAB_PADDING, input.view)) {
    const current = tab.view === input.view
    const edge = current ? tabAccent : border
    const gap = ' '.repeat(tab.start - visibleWidth(edges))
    edges += `${gap}${edge(`╭${'─'.repeat(tab.width - CORNERS)}╮`)}`
    const digit = tabAccent(String(tab.index + 1))
    const label = current ? strong(VIEW_LABELS[tab.view]) : paint('muted', VIEW_LABELS[tab.view])
    labels += `${gap}${edge('│')} ${current ? strong(digit) : digit} ${label} ${edge('│')}`
  }
  return [fit(edges, mainWidth), rowWithRightEnd(labels, input.context, mainWidth)]
}

/**
 * Renders the frame's top border under folder tabs: the current tab opens into it, the others
 * stand closed on it.
 *
 * @param input - the view and the layout
 * @returns the row, `mainWidth` columns
 */
function folderFrameTop(input: FrameInput): string {
  const { mainWidth } = input.layout
  let left = ''
  let column = 1
  for (const tab of placeTabs(mainWidth, FOLDER_TAB_PADDING, input.view)) {
    left += border('─'.repeat(tab.start - column))
    const inside = tab.width - CORNERS
    left +=
      tab.view === input.view
        ? `${tabAccent('┘')}${' '.repeat(inside)}${tabAccent('└')}`
        : border(`┴${'─'.repeat(inside)}┴`)
    column = tab.start + tab.width
  }
  return borderRow(['╭', '╮'], left, '', mainWidth)
}

/**
 * Renders the frame's top border with the tabs in it, for a short terminal: the current tab is a
 * pill, the others their digit and label; the view's context sits at the right end.
 *
 * @param input - the view, the layout and the context
 * @returns the row, `mainWidth` columns
 */
function compactFrameTop(input: FrameInput): string {
  const { mainWidth } = input.layout
  let left = border('─'.repeat(FIRST_TAB_COLUMN - 1))
  for (const tab of placeTabs(mainWidth, COMPACT_TAB_PADDING, input.view)) {
    const digit = String(tab.index + 1)
    const label = VIEW_LABELS[tab.view]
    left +=
      tab.view === input.view
        ? activeTab(` ${digit} ${label} `)
        : ` ${tabAccent(digit)} ${paint('muted', label)} `
    left += border('─'.repeat(TAB_GAP))
  }
  const context = input.context === '' ? '' : ` ${input.context} `
  return borderRow(['╭', '╮'], left, context, mainWidth)
}

/**
 * Frames the view: the tab rows (folder tabs only), the top border, each of the view's rows
 * between side borders, and the bottom border with its note.
 *
 * @param input - the view, the layout, the context and the note
 * @param body - the view's rows, each at most `layout.viewWidth` columns; fewer rows than
 *   `layout.viewHeight` are padded with blank ones
 * @returns the rows, each `layout.mainWidth` columns
 */
export function framedView(input: FrameInput, body: readonly string[]): string[] {
  const { layout } = input
  const rows = Array.from({ length: layout.viewHeight }, (_, index) => {
    const content = truncateToWidth(body[index] ?? '', layout.viewWidth, '', true)
    return `${border('│')} ${content} ${border('│')}`
  })
  const note = input.note === '' ? '' : ` ${paint('dim', input.note)} `
  const bottom = borderRow(['╰', '╯'], '', note, layout.mainWidth)
  const top = layout.folderTabs ? folderFrameTop(input) : compactFrameTop(input)
  const above = layout.folderTabs ? folderTabRows(input) : []
  return [...above, top, ...rows, bottom]
}
