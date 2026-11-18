import { screen, within } from '@testing-library/react'
import { describe, expect, test } from 'vite-plus/test'

import { renderApp, stubApi, VIEWER } from './harness'

const HOUR_MS = 3_600_000

describe('the Accounts page', () => {
  // Catches a login shown without what routing knows of it: its label, kind, place, quota, reserve
  // and cooldown.
  test('shows each login with its label, place, quota, reserve and cooldowns', async () => {
    const now = Date.now()
    stubApi({
      '/session': VIEWER,
      '/accounts': [
        {
          provider: 'anthropic',
          base: 'anthropic',
          type: 'oauth',
          source: 'stored',
          availableModelCount: 12,
          label: 'work',
          // 30 s past 2h 10m, so the few milliseconds before the page renders don't round it down.
          quota: { windows: [{ name: '5h', used: 0.42, resetsAt: now + 2 * HOUR_MS + 630_000 }] },
          belowReserve: { window: '7d', left: 0.1, reserve: 0.2 },
          cooldowns: [{ reason: 'rate_limit', until: now + 5 * 60_000 }],
          place: { position: 1, count: 2, first: true, disabled: false }
        },
        {
          provider: 'openai-codex',
          base: 'openai-codex',
          type: 'oauth',
          availableModelCount: 8,
          label: null,
          quota: null,
          belowReserve: null,
          cooldowns: [],
          place: null
        },
        {
          provider: 'anthropic-2',
          base: 'anthropic',
          type: 'oauth',
          availableModelCount: 12,
          label: null,
          quota: null,
          belowReserve: null,
          cooldowns: [],
          place: { position: 2, count: 2, first: false, disabled: true }
        }
      ]
    })

    renderApp('#/accounts')

    const page = within(await screen.findByRole('main'))
    expect(await page.findByText('work')).toBeTruthy()
    expect(page.getByText('first of 2')).toBeTruthy()
    expect(page.getByText('disabled · 2 of 2')).toBeTruthy()
    expect(page.getByText('42% used · resets in 2h 10m', { exact: false })).toBeTruthy()
    expect(page.getByText('below its reserve of', { exact: false })).toBeTruthy()
    expect(page.getByText('Cooling every model after rate_limit', { exact: false })).toBeTruthy()
    expect(page.getAllByText('subscription')).toHaveLength(3)
  })

  // Catches a provider's logins split up by another provider's, as pi lists them: each provider's
  // logins are shown together, in routing order.
  test("groups each provider's logins together", async () => {
    const login = (provider: string, base: string, position: number): Record<string, unknown> => ({
      provider,
      base,
      type: 'oauth',
      availableModelCount: 1,
      label: null,
      quota: null,
      belowReserve: null,
      cooldowns: [],
      place: { position, count: 2, first: position === 1, disabled: false }
    })
    stubApi({
      '/session': VIEWER,
      '/accounts': [
        login('anthropic-2', 'anthropic', 2),
        login('openai-codex', 'openai-codex', 1),
        login('anthropic', 'anthropic', 1)
      ]
    })

    renderApp('#/accounts')

    const page = within(await screen.findByRole('main'))
    await page.findByRole('heading', { level: 2, name: /openai-codex/u })
    const cards = page
      .getAllByRole('heading', { level: 3 })
      .map((heading) => heading.querySelector('.font-mono')?.textContent)
    expect(cards).toEqual(['anthropic', 'anthropic-2', 'openai-codex'])
    expect(
      page.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)
    ).toEqual(['anthropic 2 logins', 'openai-codex 1 login'])
  })

  // Catches an empty proxy shown as a blank page rather than where logins come from.
  test('points at the Logins page when there is no login', async () => {
    stubApi({ '/session': VIEWER, '/accounts': [] })

    renderApp('#/accounts')

    expect(await screen.findByText('No logins yet: see the Logins page.')).toBeTruthy()
  })
})
