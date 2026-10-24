/**
 * The console's screen layout (`src/tui/layout.ts`): which rows and columns the chrome takes at
 * each terminal size, and when the tabs fold into the frame's border.
 */

import { consoleLayout, FOLDER_TABS_MIN_ROWS } from '@proxy/tui/layout'
import { describe, expect, test } from 'vite-plus/test'

describe('consoleLayout', () => {
  // Catches the view getting more or fewer rows than the chrome leaves it: the strip, the two
  // folder-tab rows on a tall terminal, the frame's two borders and the footer.
  test.each([
    ['tall: folder tabs', { columns: 160, rows: 50 }, { folderTabs: true, viewHeight: 44 }],
    [
      'the fold',
      { columns: 160, rows: FOLDER_TABS_MIN_ROWS },
      { folderTabs: true, viewHeight: 24 }
    ],
    [
      'just under the fold: compact tabs',
      { columns: 160, rows: FOLDER_TABS_MIN_ROWS - 1 },
      { folderTabs: false, viewHeight: 25 }
    ],
    ['80×24', { columns: 80, rows: 24 }, { folderTabs: false, viewHeight: 20 }],
    ['tiny', { columns: 60, rows: 4 }, { folderTabs: false, viewHeight: 1 }]
  ])('%s', (_label, size, expected) => {
    const layout = consoleLayout(size, false)

    expect(layout.folderTabs).toBe(expected.folderTabs)
    expect(layout.viewHeight).toBe(expected.viewHeight)
    expect(layout.frameRows).toBe(expected.viewHeight + 2)
  })

  // Catches the frame taking the sidebar's columns, or the view not losing the frame's side
  // borders: with the sidebar, main + one blank column + sidebar is the terminal; without, main is
  // the terminal.
  test('shares the columns between the frame and the sidebar', () => {
    const wide = consoleLayout({ columns: 140, rows: 40 }, false)
    expect(wide.sidebarFits).toBe(true)
    expect(wide.sidebarWidth).toBe(42)
    expect(wide.mainWidth + 1 + 42).toBe(140)
    expect(wide.viewWidth).toBe(wide.mainWidth - 4)

    const hidden = consoleLayout({ columns: 140, rows: 40 }, true)
    expect(hidden.sidebarFits).toBe(true)
    expect(hidden.sidebarWidth).toBeUndefined()
    expect(hidden.mainWidth).toBe(140)

    const narrow = consoleLayout({ columns: 99, rows: 40 }, false)
    expect(narrow.sidebarFits).toBe(false)
    expect(narrow.sidebarWidth).toBeUndefined()
    expect(narrow.mainWidth).toBe(99)
  })
})
