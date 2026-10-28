/**
 * The frame around the console's view (#61), with its tabs: on a tall terminal folder tabs that
 * open into the frame's top border, the current one in front; on a short one the tabs sit in the
 * top border itself, the current one a pill. The right end of the tab row says a word about the
 * view (`idle`, `4 logins · 0 cooldowns`); the right end of the bottom border notes its size, and
 * its left end the view's state where it has one (`● live`). A tab may carry a count after its
 * label (`Doctor 2`, #325), kept on a narrow row before the tabs without one.
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
  settings: 'Settings',
  doctor: 'Doctor'
}

/** A count after a tab's label (`Doctor 2`), in the color of the worst it counts (#325). */
export interface TabBadge {
  readonly count: number
  readonly level: 'error' | 'warning'
}

/** Each tab's badge, for the tabs that have one now. */
export type TabBadges = Readonly<Partial<Record<View, TabBadge>>>

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
  /**
   * What the left end of the bottom border says about the view's state, coloured by the view
   * (`● live` on Requests); `''` or absent for nothing. The note gives way to it when both don't fit.
   */
  readonly status?: string
  /** The tabs' counts; none when absent. */
  readonly badges?: TabBadges
}

/** One tab's place on the row: where it starts and how wide it is. */
interface TabSpan {
  readonly view: View
  readonly index: number
  readonly start: number
  readonly width: number
}

/**
 * Says what follows a tab's label: its badge's count after a space, or nothing.
 *
 * @param view - the tab's view
 * @param badges - the tabs' badges
 * @returns the count's text, uncolored, or `''`
 */
function badgeText(view: View, badges: TabBadges | undefined): string {
  const badge = badges?.[view]
  return badge === undefined ? '' : ` ${String(badge.count)}`
}

/**
 * Renders a tab's label with its badge, the count in its level's color.
 *
 * @param view - the tab's view
 * @param badges - the tabs' badges
 * @param styled - the label, styled for the tab
 * @returns the label and the count
 */
function labelWithBadge(view: View, badges: TabBadges | undefined, styled: string): string {
  const badge = badges?.[view]
  return badge === undefined ? styled : `${styled}${paint(badge.level, badgeText(view, badges))}`
}

/**
 * Places tabs on the row, left to right, each keeping its view's digit.
 *
 * @param views - the tabs to place, in tab order
 * @param padding - the columns each tab adds around its label
 * @param badges - the tabs' badges, which widen their tabs
 * @returns the tabs placed
 */
function layOutTabs(
  views: readonly View[],
  padding: number,
  badges: TabBadges | undefined
): TabSpan[] {
  const spans: TabSpan[] = []
  let column = FIRST_TAB_COLUMN
  for (const view of views) {
    const width = VIEW_LABELS[view].length + badgeText(view, badges).length + padding
    spans.push({ view, index: VIEWS.indexOf(view), start: column, width })
    column += width + TAB_GAP
  }
  return spans
}

/**
 * Finds the tab to leave out next: the last one that is neither the current view's nor counting
 * something (the Doctor tab's errors, #325), then the last one other than the current view's.
 *
 * @param shown - the tabs still placed
 * @param input - the view shown and the tabs' badges
 * @returns its index in `shown`, or -1 when only the current view's is left
 */
function tabToDrop(shown: readonly View[], input: FrameInput): number {
  const quiet = shown.findLastIndex(
    (view) => view !== input.view && input.badges?.[view] === undefined
  )
  return quiet === -1 ? shown.findLastIndex((view) => view !== input.view) : quiet
}

/**
 * Places the tabs on the row, leaving out those the row has no room for: the last ones first, but
 * a tab with a count only after the others, and never the current view's, so the frame always
 * shows where you are.
 *
 * @param input - the view shown, the frame's columns and the tabs' badges
 * @param padding - the columns each tab adds around its label
 * @returns the tabs placed
 */
function placeTabs(input: FrameInput, padding: number): TabSpan[] {
  const shown: View[] = [...VIEWS]
  for (;;) {
    const spans = layOutTabs(shown, padding, input.badges)
    const last = spans.at(-1)
    if (last === undefined || last.start + last.width <= input.layout.mainWidth - CORNERS) {
      return spans
    }
    const dropped = tabToDrop(shown, input)
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
 * Lays the bottom border out: the status after the left corner, the note before the right one.
 * When both don't fit the note gives way, as {@link borderRow} drops it; on a frame too narrow
 * for the status, the note shows alone.
 *
 * @param status - the status with its spaces, after a border character; `''` for none
 * @param note - the note with its spaces; `''` for none
 * @param mainWidth - the frame's columns
 * @returns the row, `mainWidth` columns
 */
function bottomBorder(status: string, note: string, mainWidth: number): string {
  const left = status === '' ? '' : `${border('─')}${status}`
  // The status needs a border character after it, as the note does before the corner.
  const fits = CORNERS + visibleWidth(left) + 1 <= mainWidth
  return borderRow(['╰', '╯'], fits ? left : '', note, mainWidth)
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
  for (const tab of placeTabs(input, FOLDER_TAB_PADDING)) {
    const current = tab.view === input.view
    const edge = current ? tabAccent : border
    const gap = ' '.repeat(tab.start - visibleWidth(edges))
    edges += `${gap}${edge(`╭${'─'.repeat(tab.width - CORNERS)}╮`)}`
    const digit = tabAccent(String(tab.index + 1))
    const name = current ? strong(VIEW_LABELS[tab.view]) : paint('muted', VIEW_LABELS[tab.view])
    const label = labelWithBadge(tab.view, input.badges, name)
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
  for (const tab of placeTabs(input, FOLDER_TAB_PADDING)) {
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
  for (const tab of placeTabs(input, COMPACT_TAB_PADDING)) {
    const digit = String(tab.index + 1)
    const label = VIEW_LABELS[tab.view]
    // The current tab's pill is one style throughout: its count goes uncolored inside it.
    left +=
      tab.view === input.view
        ? activeTab(` ${digit} ${label}${badgeText(tab.view, input.badges)} `)
        : ` ${tabAccent(digit)} ${labelWithBadge(tab.view, input.badges, paint('muted', label))} `
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
  const status = input.status === undefined || input.status === '' ? '' : ` ${input.status} `
  const bottom = bottomBorder(status, note, layout.mainWidth)
  const top = layout.folderTabs ? folderFrameTop(input) : compactFrameTop(input)
  const above = layout.folderTabs ? folderTabRows(input) : []
  return [...above, top, ...rows, bottom]
}
