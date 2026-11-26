import { act, fireEvent, screen, within } from '@testing-library/react'
import { describe, expect, test } from 'vite-plus/test'

import { openedSources, renderApp, STATUS, stubApi, VIEWER } from './harness'

const NOW = Date.now()

describe('the console layout', () => {
  // Catches the strip showing another proxy than the one asked: its version, address, auth, models
  // and uptime, the current rate and today's cost.
  test("the status strip shows the proxy's status", async () => {
    stubApi({ '/session': VIEWER })

    renderApp()

    const header = within(await screen.findByRole('banner'))
    expect(await header.findByText('127.0.0.1:4141')).toBeTruthy()
    expect(header.getByText('0.6.0')).toBeTruthy()
    expect(header.getByText('auth off').className).toContain('badge-warning')
    expect(header.getByText('26/62 models')).toBeTruthy()
    expect(header.getByText('up 3h 12m')).toBeTruthy()
    expect(header.getByText('3/min')).toBeTruthy()
    expect(header.getByText('$1.50 today')).toBeTruthy()
    expect(header.getByRole('img', { name: /per minute/u })).toBeTruthy()
  })

  // Catches proxy auth off beyond loopback shown as a plain badge, as on loopback, rather than the
  // alert the console gives it a row for.
  test('alerts when auth is off beyond this machine', async () => {
    stubApi({
      '/session': VIEWER,
      '/status': { ...STATUS, address: '0.0.0.0:4141', beyondLoopback: true }
    })

    renderApp()

    const alert = await screen.findByText(/Proxy auth is off on 0\.0\.0\.0:4141/u)
    expect(alert.closest('[role="alert"]')?.className).toContain('alert-error')
    expect(screen.getByText('auth off').className).toContain('badge-error')
  })

  // Catches the Doctor tab not counting what needs fixing (advice alone shows none), or not in the
  // color of the worst.
  test("the Doctor tab counts the errors and warnings, in the worst one's color", async () => {
    const found = (severity: string): Record<string, string> => ({
      check: severity,
      severity,
      message: `a ${severity}`,
      recommendation: 'fix it'
    })
    stubApi({
      '/session': VIEWER,
      '/doctor?window=today': {
        general: [found('error'), found('warning')],
        cache: [found('advice')],
        window: 'today',
        statsAvailable: true,
        limits: []
      }
    })

    renderApp()

    const tab = await screen.findByRole('tab', { name: /Doctor/u })
    const badge = await within(tab).findByText('2')
    expect(badge.className).toContain('badge-error')
  })

  // Catches the console's keys not working: a digit picks the page, `s` hides the sidebar, and a
  // window key moves the Stats page to that window.
  test('the keys pick the page, hide the sidebar and pick the window', async () => {
    const calls = stubApi({
      '/session': VIEWER,
      '/stats?window=week': {
        window: 'week',
        bucket_minutes: 360,
        models: [],
        failures: [],
        rejected: [],
        timeline: []
      }
    })
    renderApp()
    await screen.findByRole('complementary', { name: 'Sidebar' })

    fireEvent.keyDown(window, { key: '3' })
    fireEvent.keyDown(window, { key: 'w' })
    fireEvent.keyDown(window, { key: 's' })

    expect(window.location.hash).toBe('#/stats')
    expect(await screen.findByRole('button', { name: 'Week', pressed: true })).toBeTruthy()
    expect(screen.queryByRole('complementary', { name: 'Sidebar' })).toBeNull()
    expect(calls.some((call) => call.path === '/admin/api/stats?window=week')).toBe(true)
  })

  // Catches the sidebar not following the stream (a request in flight not shown), or the session
  // totals not added up across routes.
  test('the sidebar shows what is in flight and the session so far', async () => {
    stubApi({
      '/session': VIEWER,
      '/status': {
        ...STATUS,
        session: {
          since: 0,
          totals: [
            {
              alias: null,
              model: 'a/one',
              requests: 3,
              failures: 1,
              fallbacks: 0,
              inputTokens: 1000,
              outputTokens: 200,
              cacheReadTokens: 0
            },
            {
              alias: 'quick',
              model: 'a/two',
              requests: 4,
              failures: 0,
              fallbacks: 2,
              inputTokens: 500,
              outputTokens: 100,
              cacheReadTokens: 500
            }
          ]
        }
      }
    })
    renderApp()
    const sidebar = within(await screen.findByRole('complementary', { name: 'Sidebar' }))
    await sidebar.findByText('SESSION')

    act(() => {
      openedSources[0]?.emit('requests', {
        requests: [],
        active: [
          {
            requestId: 'r1',
            alias: 'quick',
            model: 'a/two',
            attempt: 2,
            stream: true,
            startedAt: NOW - 5000
          }
        ],
        finished: [],
        events: []
      })
    })

    expect(await sidebar.findByText('quick → a/two (attempt 2)')).toBeTruthy()
    expect(sidebar.getByText('7')).toBeTruthy()
    expect(sidebar.getByText('2K')).toBeTruthy()
  })
})
