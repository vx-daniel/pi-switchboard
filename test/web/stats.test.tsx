import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vite-plus/test'

import { renderApp, stubApi, VIEWER } from './harness'

// uPlot draws on a canvas, which jsdom does not have: the chart is stood in for, and its data is
// checked through what it was given.
const charts = vi.hoisted(() => ({ data: [] as unknown[] }))
vi.mock('uplot', () => ({
  default: class {
    /**
     * Records the chart's data.
     *
     * @param _options - the chart's options
     * @param data - its columns
     */
    constructor(_options: unknown, data: unknown) {
      charts.data.push(data)
    }

    /** Removes the chart. */
    destroy(): void {}
  }
}))

/** One model's numbers. */
const USAGE_MODEL = {
  model: 'anthropic/claude-opus-5-5',
  requests: 40,
  failed: 2,
  average_ms: 2300,
  fallbacks: 3,
  input_tokens: 10_000,
  output_tokens: 2000,
  cache_read_tokens: 90_000,
  cost_usd: 1.25
}

/**
 * A window's usage.
 *
 * @param window - the window
 * @returns the answer
 */
function usage(window: string): Record<string, unknown> {
  return {
    window,
    bucket_minutes: 60,
    models: [USAGE_MODEL],
    failures: [{ class: 'rate_limit', count: 2 }],
    rejected: [{ status: 401, count: 1 }],
    timeline: [{ start: '2026-11-18T14:00:00.000Z', requests: 40, failed: 2, rejected: 1 }]
  }
}

describe('the Stats page', () => {
  // Catches the totals adding the wrong fields, the chart given other numbers, or failures hidden.
  test("shows the window's totals, timeline, models and failures", async () => {
    charts.data.length = 0
    stubApi({ '/session': VIEWER, '/stats?window=today': usage('today') })

    renderApp('#/stats')

    expect(await screen.findByText('anthropic/claude-opus-5-5')).toBeTruthy()
    expect(screen.getByText('100K')).toBeTruthy()
    expect(screen.getAllByText('$1.25')).toHaveLength(2)
    expect(screen.getByText('2.3 s')).toBeTruthy()
    expect(screen.getByText('2 rate_limit')).toBeTruthy()
    expect(screen.getByText('1 rejected with 401')).toBeTruthy()
    expect(charts.data).toContainEqual([[Date.parse('2026-11-18T14:00:00.000Z') / 1000], [40], [3]])
  })

  // Catches the window picker not asking the proxy for the window picked.
  test('reads the window picked', async () => {
    const calls = stubApi({
      '/session': VIEWER,
      '/stats?window=today': usage('today'),
      '/stats?window=week': usage('week')
    })
    renderApp('#/stats')
    await screen.findByText('anthropic/claude-opus-5-5')

    fireEvent.click(screen.getByRole('button', { name: 'Week' }))

    await expect
      .poll(() => calls.some((call) => call.path === '/admin/api/stats?window=week'))
      .toBe(true)
    expect(screen.getByRole('button', { name: 'Week' }).getAttribute('aria-pressed')).toBe('true')
  })

  // Catches stats turned off shown as an empty window instead of why.
  test('says why when stats are off', async () => {
    stubApi({
      '/session': VIEWER,
      '/stats?window=today': {
        status: 503,
        body: { error: { message: 'Stats are off (--no-stats): the proxy keeps no usage to read' } }
      }
    })

    renderApp('#/stats')

    expect(await screen.findByText('Stats are off', { exact: false })).toBeTruthy()
  })
})
