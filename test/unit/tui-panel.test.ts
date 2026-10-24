/**
 * What the console's views draw with (`src/tui/panel.ts`): the quota gauge and its colours.
 */

import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { gauge, quotaColor } from '@proxy/tui/panel'
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
