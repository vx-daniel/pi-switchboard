/**
 * How the Stats dashboard shares its rows (#216, #366): the timeline's bars, the tiles, and the
 * MODELS, ALIASES and PROJECTS tables, at any screen height.
 *
 * @packageDocumentation
 */

/** Rows the timeline's bars take at most and at least. */
const CHART_ROWS = { most: 16, least: 3 } as const
/** Model rows the layout makes room for before the timeline takes the rest. */
const MODEL_ROWS_WANTED = 6
/** Alias rows the layout makes room for, when any request named an alias. */
const ALIAS_ROWS_WANTED = 4
/** Project rows the layout makes room for, when a request named a project or one has a budget. */
const PROJECT_ROWS_WANTED = 4
/** The dashboard's panels that always show; ALIASES and PROJECTS show when they have rows. */
const PANELS = ['TIMELINE', 'MODELS'] as const
/** Rows a panel's frame takes: its top and bottom borders. */
const BORDER_ROWS = 2
/** Rows the panels' frames take. */
const FRAME_ROWS = PANELS.length * BORDER_ROWS
/**
 * Rows that don't change with the screen, by where they are: the window line, the timeline's peak
 * and axis lines, the models' heading and the errors line.
 */
const FIXED_LINES = { window: 1, timeline: 2, modelsHeading: 1, errors: 1 } as const
/** Rows the tiles take: a blank row under the window line, then each tile's label, number and caption. */
const TILE_ROWS = 4
/** Rows an ALIASES or PROJECTS panel takes besides its rows: its frame and its heading. */
const TABLE_PANEL_ROWS = BORDER_ROWS + 1

/** How the dashboard's rows are shared out at one height. */
export interface DashboardLayout {
  /** Whether the tiles show. */
  readonly tiles: boolean
  /** Rows of timeline bars. */
  readonly chart: number
  /** Rows for the MODELS table's entries. */
  readonly modelRoom: number
  /** Rows for the ALIASES table's entries; 0 without the panel. */
  readonly aliasRoom: number
  /** Rows for the PROJECTS table's entries; 0 without the panel. */
  readonly projectRoom: number
}

/** How many rows each table has: 0 for a panel that isn't shown. */
export interface TableEntries {
  readonly models: number
  readonly aliases: number
  readonly projects: number
}

/**
 * Shares out the dashboard's rows. What gives way first on a short screen, last first: the
 * timeline's bars past {@link CHART_ROWS}' least, the tables' rows past one each, then the tiles;
 * the timeline keeps its least rows and each table one row while the screen has room for them.
 *
 * @param entries - how many rows each table has: models served, aliases and projects in their
 *   tables (0 when the table isn't shown)
 * @param height - the dashboard's rows
 * @returns the layout
 */
export function dashboardLayout(entries: TableEntries, height: number): DashboardLayout {
  const shown = Math.min(1, entries.aliases) + Math.min(1, entries.projects)
  const fixed =
    FRAME_ROWS +
    shown * TABLE_PANEL_ROWS +
    Object.values(FIXED_LINES).reduce((total, rows) => total + rows, 0)
  // One row for the models, and one for each other table that shows.
  const tiles = height - fixed - CHART_ROWS.least - (1 + shown) >= TILE_ROWS
  const room = height - fixed - (tiles ? TILE_ROWS : 0)
  const wanted = {
    models: Math.min(Math.max(1, entries.models), MODEL_ROWS_WANTED),
    aliases: Math.min(entries.aliases, ALIAS_ROWS_WANTED),
    projects: Math.min(entries.projects, PROJECT_ROWS_WANTED)
  }
  const chart = Math.min(
    CHART_ROWS.most,
    Math.max(CHART_ROWS.least, room - wanted.models - wanted.aliases - wanted.projects)
  )
  const tableRoom = Math.max(1, room - chart)
  const roomFor = (rows: number, others: number): number =>
    rows === 0 ? 0 : Math.max(1, Math.min(rows, tableRoom - 1 - others))
  const projectRoom = roomFor(wanted.projects, Math.min(1, entries.aliases))
  const aliasRoom = roomFor(wanted.aliases, projectRoom)
  return {
    tiles,
    chart,
    modelRoom: Math.max(1, tableRoom - aliasRoom - projectRoom),
    aliasRoom,
    projectRoom
  }
}
