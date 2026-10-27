/**
 * What the console's views draw with (`src/tui/panel.ts`): the quota gauge and its colours.
 */

import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { gauge, hitRate, panel, quotaColor, usd } from '@proxy/tui/panel'
import { describe, expect, test } from 'vite-plus/test'

describe('gauge', () => {
  // Catches a gauge wider or narrower than asked at any share, which shifts what follows it.
  test.each([0, 0.001, 0.12, 0.5, 0.99, 1, 1.5, -1])(
    'is exactly the cells asked at %d',
    (share) => {
      expect(visibleWidth(gauge(share, 10, 'success'))).toBe(10)
    }
  )

  // Catches a share in eighths drawn as whole cells, a little used drawn as none, or the track
  // missing.
  test('fills in eighths of a cell, at least one eighth for any share above zero', () => {
    const plain = (share: number): string => stripTerminalSequences(gauge(share, 4, 'success'))

    expect(plain(0)).toBe('░░░░')
    expect(plain(0.001)).toBe('▏░░░')
    expect(plain(0.5)).toBe('██░░')
    expect(plain(0.5 + 1 / 32)).toBe('██▏░')
    expect(plain(1)).toBe('████')
  })
})

describe('quotaColor', () => {
  // Catches the thresholds moved, or a login below its reserve shown green.
  test.each([
    [0.69, false, 'success'],
    [0.7, false, 'warning'],
    [0.9, false, 'error'],
    [0.1, true, 'error']
  ] as const)('%d used, below reserve %s, is %s', (used, belowReserve, color) => {
    expect(quotaColor(used, belowReserve)).toBe(color)
  })
})

describe('usd', () => {
  // Catches the views' costs drifting apart in format (#261 review: two copies of the decimals),
  // or the places asked for ignored.
  test('shows dollars and cents, or the places asked for', () => {
    expect(usd(1.234)).toBe('$1.23')
    expect(usd(0)).toBe('$0.00')
    expect(usd(0.00425, 4)).toBe('$0.0043')
  })
})

describe('hitRate', () => {
  // Catches a route with no prompt tokens yet (only failed calls) shown as `NaN%`, and a rate
  // that leaves the writes out of the prompt (60%, not 100%).
  test.each([
    [{ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, '-'],
    [{ inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }, '0%'],
    [{ inputTokens: 0, cacheReadTokens: 600, cacheWriteTokens: 400 }, '60%'],
    [{ inputTokens: 0, cacheReadTokens: 1000, cacheWriteTokens: 0 }, '100%']
  ])('%j is %s', (tokens, text) => {
    expect(hitRate(tokens)).toBe(text)
  })
})

describe('panel', () => {
  // Catches a long title (a long login and its label in the Accounts detail pane, #260 review)
  // pushing the top border past the panel's width, which the frame then cuts, losing the corner.
  test('cuts a title too long for the top border, keeping the corner', () => {
    const rows = panel('qwen-token-plan-individual', ['a line'], 30, 'a label far too long')
    const top = stripTerminalSequences(rows[0] ?? '')

    for (const row of rows) expect(visibleWidth(row)).toBe(30)
    expect(top).toBe('╭─ qwen-token-plan-individua…╮')
  })

  // Catches the cut reaching a title that fits.
  test('keeps a title that fits whole', () => {
    expect(stripTerminalSequences(panel('QUOTA', [], 30, '4 logins')[0] ?? '')).toBe(
      `╭─ QUOTA 4 logins ${'─'.repeat(11)}╮`
    )
  })
})
