/**
 * The console's whole screen (`src/tui/screen.ts`): as many rows as the terminal, each exactly
 * as wide, at every size and shape, with the sidebar's clock over its panels on a tall terminal.
 */

import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { consoleLayout } from '@proxy/tui/layout'
import { clockLabel, consoleScreen, type ScreenInput } from '@proxy/tui/screen'
import { SPARKLINE_MINUTES } from '@proxy/tui/status-strip'
import { describe, expect, test } from 'vite-plus/test'

/** A fixed clock. */
const NOW = Date.UTC(2026, 9, 23, 19, 2, 29)

/**
 * Builds a screen input for a terminal size.
 *
 * @param size - the terminal's columns and rows
 * @param sidebarHidden - whether the sidebar is hidden
 * @returns the input, with a one-row view and a two-row sidebar
 */
function screen(size: { columns: number; rows: number }, sidebarHidden = false): ScreenInput {
  const layout = consoleLayout(size, sidebarHidden)
  return {
    view: 'logs',
    layout,
    now: NOW,
    strip: {
      version: '0.3.0',
      address: '127.0.0.1:4141',
      proxyAuth: 'off',
      exposed: 24,
      available: 58,
      uptimeMs: 60_000,
      connections: 1,
      cooldowns: 0,
      modelsJsonError: false,
      perMinute: Array.from({ length: SPARKLINE_MINUTES }, () => 0),
      saturated: false
    },
    context: 'idle',
    note: '3 lines',
    body: ['a log line'],
    sidebar:
      layout.sidebarWidth === undefined
        ? undefined
        : ['╭─ QUOTA ─╮'.padEnd(layout.sidebarWidth), '╰─────────╯'.padEnd(layout.sidebarWidth)]
  }
}

describe('consoleScreen', () => {
  // Catches the screen overflowing or underfilling the terminal, or any row (the strip, a tab
  // row, a frame row beside the sidebar, the footer) being wider or narrower than it: pi-tui
  // refuses a wider row, and a narrower one shifts the right borders.
  test.each([
    [60, 16],
    [80, 24],
    [100, 29],
    [100, 30],
    [140, 40],
    [160, 50]
  ])('fills a %d×%d terminal exactly', (columns, rows) => {
    for (const sidebarHidden of [false, true]) {
      const rendered = consoleScreen(screen({ columns, rows }, sidebarHidden))

      expect(rendered).toHaveLength(rows)
      for (const row of rendered) expect(visibleWidth(row)).toBe(columns)
    }
  })

  // Catches the sidebar's panels starting level with the folder tabs instead of the frame's top
  // border, or the clock missing from the tab row over them.
  test('on a tall terminal the clock sits over the sidebar, level with the tab labels', () => {
    const input = screen({ columns: 140, rows: 40 })
    const rows = consoleScreen(input).map((row) => stripTerminalSequences(row))

    expect(rows[2]?.endsWith(stripTerminalSequences(clockLabel(NOW)))).toBe(true)
    expect(rows[3]?.endsWith('╭─ QUOTA ─╮'.padEnd(42))).toBe(true)
  })

  // Catches the sidebar drawn on a short terminal from the strip's row rather than the frame's.
  test('on a short terminal the sidebar starts level with the frame’s top border', () => {
    const rows = consoleScreen(screen({ columns: 140, rows: 24 })).map((row) =>
      stripTerminalSequences(row)
    )

    expect(rows[1]?.endsWith('╭─ QUOTA ─╮'.padEnd(42))).toBe(true)
  })
})

describe('clockLabel', () => {
  // Catches a locale-dependent date, or an unpadded time.
  test('formats the weekday, day, month and a padded time', () => {
    expect(stripTerminalSequences(clockLabel(Date.UTC(2026, 0, 5, 3, 4, 5)))).toMatch(
      /^(Sun|Mon) [45] Jan {2}\d\d:0[45]:05$/
    )
  })
})
