/**
 * The frame around the console's view (`src/tui/frame.ts`): folder tabs on a tall terminal,
 * tabs in the border on a short one, the view's rows between side borders, and the context and
 * note at the right ends.
 */

import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { type FrameInput, framedView } from '@proxy/tui/frame'
import { consoleLayout } from '@proxy/tui/layout'
import { VIEWS } from '@proxy/tui/navigation'
import { describe, expect, test } from 'vite-plus/test'

/**
 * Builds a frame input for a terminal size, with no sidebar.
 *
 * @param size - the terminal's columns and rows
 * @param fields - the fields to set
 * @returns the input
 */
function frame(
  size: { columns: number; rows: number },
  fields: Partial<Omit<FrameInput, 'layout'>> = {}
): FrameInput {
  return {
    view: 'logs',
    layout: consoleLayout(size, true),
    context: 'idle',
    note: '12 lines',
    ...fields
  }
}

/**
 * Renders a frame as plain text.
 *
 * @param input - the frame
 * @param body - the view's rows
 * @returns the rows without colour codes
 */
function plain(input: FrameInput, body: readonly string[] = ['one', 'two']): string[] {
  return framedView(input, body).map((row) => stripTerminalSequences(row))
}

describe('framedView', () => {
  // Catches a row wider or narrower than the frame at any size or shape (a border row with its
  // text set in, a tab row), which breaks the sidebar beside it or wraps the screen.
  test.each([
    [60, 16],
    [80, 24],
    [100, 29],
    [100, 30],
    [160, 50]
  ])(
    'every row is exactly as wide as a %d×%d frame, and there are frameRows of them',
    (columns, rows) => {
      for (const view of VIEWS) {
        const input = frame({ columns, rows }, { view })
        const rendered = framedView(input, ['a row'])
        const tabRows = input.layout.folderTabs ? 2 : 0

        expect(rendered).toHaveLength(input.layout.frameRows + tabRows)
        for (const row of rendered) expect(visibleWidth(row)).toBe(columns)
      }
    }
  )

  // Catches the current folder tab closed on the frame (a bottom edge under it) or another one
  // open, and the digits lost.
  test('folder tabs: the current one opens into the frame, the others stand closed on it', () => {
    const rows = plain(frame({ columns: 100, rows: 40 }, { view: 'accounts' }))

    expect(rows[0]).toMatch(/^ {2}╭─+╮ ╭─+╮ ╭─+╮ ╭─+╮ *$/)
    expect(rows[1]).toMatch(/^ {2}│ 1 Logs │ │ 2 Accounts │ │ 3 Stats │ │ 4 Models │ +idle *$/)
    expect(rows[2]).toMatch(/^╭─┴─+┴─┘ {12}└─┴─+┴─┴─+┴─+╮$/)
  })

  // Catches the tabs in the border on a short terminal losing a digit, the current one unmarked,
  // or the context pushed off the border.
  test('compact tabs sit in the top border with the context at its right end', () => {
    const rows = plain(frame({ columns: 80, rows: 24 }, { view: 'stats', context: 'today' }))

    expect(rows[0]).toMatch(/^╭─ 1 Logs ─ 2 Accounts ─ 3 Stats ─ 4 Models ─+ today ─╮$/)
  })

  // Catches the view's rows unpadded or uncut inside the borders, or a short body leaving the
  // frame short.
  test('frames the view’s rows and pads a short body to the view’s height', () => {
    const input = frame({ columns: 40, rows: 10 })
    const rows = plain(input, ['short', 'a row far too long for the frame to hold'])

    expect(input.layout.viewHeight).toBe(6)
    expect(rows[1]).toBe('│ short                                │')
    expect(rows[2]).toBe('│ a row far too long for the frame to  │')
    expect(rows[3]).toBe('│                                      │')
    expect(rows.at(-1)).toBe(`╰${'─'.repeat(27)} 12 lines ─╯`)
  })

  // Catches a context or a note that does not fit being written over the tabs or the corner
  // instead of left out.
  test('leaves the context and the note out when they do not fit', () => {
    const rows = plain(
      frame(
        { columns: 60, rows: 20 },
        {
          context: 'a context far too long for the border to hold',
          note: 'a note far too long for the row to hold, even on its own, by a wide margin'
        }
      )
    )

    expect(rows[0]).toMatch(/^╭─ 1 Logs ─ 2 Accounts ─ 3 Stats ─ 4 Models ─+╮$/)
    expect(rows.at(-1)).toBe(`╰${'─'.repeat(58)}╯`)
  })

  // Catches a tab drawn past the frame's right corner on a very narrow terminal.
  test('leaves out the tabs a narrow frame has no room for', () => {
    const rows = plain(frame({ columns: 30, rows: 20 }, { context: '' }))

    expect(rows[0]).toMatch(/^╭─ 1 Logs ─ 2 Accounts ─+╮$/)
    expect(rows[0]).not.toContain('Stats')
  })
})
