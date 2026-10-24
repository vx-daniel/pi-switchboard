/**
 * The console's screen layout (#61): where the status strip, the tabs, the framed view, the
 * sidebar and the footer go on a terminal of some size, and which of two shapes the tabs take.
 *
 * @remarks
 * Rows, top to bottom: the status strip; on a tall terminal two rows of folder tabs; the frame's
 * top border (which the folder tabs open into, or which carries the tabs itself on a short
 * terminal); the view; the frame's bottom border; the footer. The sidebar stands beside the frame,
 * from its top border to its bottom border. Pure: a layout is a function of the size and whether
 * the sidebar is hidden, so a test can check every size.
 *
 * @packageDocumentation
 */

import { FRAME_COLUMNS } from '@proxy/tui/panel'
import { sidebarWidth } from '@proxy/tui/sidebar'

/**
 * Rows from which the tabs are folders above the frame. Below, they sit in the frame's top border,
 * so a short terminal keeps its rows for the view.
 */
export const FOLDER_TABS_MIN_ROWS = 30
/** Rows the status strip takes. */
const STATUS_ROWS = 1
/** Rows folder tabs take above the frame: their top edge and their label. */
const FOLDER_TAB_ROWS = 2
/** Rows the frame takes: its top border and its bottom border. */
const FRAME_ROWS = 2
/** Rows the footer takes. */
const FOOTER_ROWS = 1
/** The fewest rows the view keeps, whatever the terminal's height. */
const MIN_VIEW_ROWS = 1

/** A terminal's size, in cells. */
export interface TerminalSize {
  readonly columns: number
  readonly rows: number
}

/** Where everything goes on the screen. */
export interface ConsoleLayout {
  readonly columns: number
  readonly rows: number
  /** Whether the terminal is wide enough for the sidebar, shown or hidden. */
  readonly sidebarFits: boolean
  /** The sidebar's columns, or `undefined` when it is hidden or does not fit. */
  readonly sidebarWidth: number | undefined
  /** The columns the frame spans: everything left of the sidebar and the gap before it. */
  readonly mainWidth: number
  /** Whether the tabs are folders above the frame (else they sit in its top border). */
  readonly folderTabs: boolean
  /** Rows the frame spans, top border through bottom border; the sidebar stands beside them. */
  readonly frameRows: number
  /** The view's columns, inside the frame's side borders. */
  readonly viewWidth: number
  /** The view's rows, between the frame's top and bottom borders. */
  readonly viewHeight: number
}

/**
 * Lays the screen out for a terminal.
 *
 * @param size - the terminal's size
 * @param sidebarHidden - whether the operator hid the sidebar (`s`)
 * @returns the layout
 */
export function consoleLayout(size: TerminalSize, sidebarHidden: boolean): ConsoleLayout {
  const fitting = sidebarWidth(size.columns)
  const side = sidebarHidden ? undefined : fitting
  // One blank column between the frame and the sidebar.
  const mainWidth = side === undefined ? size.columns : size.columns - side - 1
  const folderTabs = size.rows >= FOLDER_TABS_MIN_ROWS
  const chromeRows = STATUS_ROWS + (folderTabs ? FOLDER_TAB_ROWS : 0) + FRAME_ROWS + FOOTER_ROWS
  const viewHeight = Math.max(MIN_VIEW_ROWS, size.rows - chromeRows)
  return {
    columns: size.columns,
    rows: size.rows,
    sidebarFits: fitting !== undefined,
    sidebarWidth: side,
    mainWidth,
    folderTabs,
    frameRows: viewHeight + FRAME_ROWS,
    viewWidth: Math.max(1, mainWidth - FRAME_COLUMNS),
    viewHeight
  }
}
