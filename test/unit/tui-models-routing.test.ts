/**
 * The console's Models view shows the login a request would call (#379): the cooldown cell and
 * the detail pane follow routing's own rules, not the model's first login.
 */

import { stripTerminalSequences } from '@earendil-works/pi-tui'
import type { FailureClass } from '@proxy/config/schema'
import type { ExposedModel } from '@proxy/openai/model-exposure'
import { clearAllCooldowns, startCooldown } from '@proxy/pi/cooldowns'
import { modelsRows, type ModelsView } from '@proxy/tui/models-view'
import { afterEach, describe, expect, test } from 'vite-plus/test'

import { exposed } from '../helpers'

/** A view wide enough for the detail pane beside the matrix. */
const SIDE_BY_SIDE = 160

/**
 * The model `alpha/hot` under each login, in routing order; the entry is the first login's.
 *
 * @param logins - the logins
 * @returns the model's entry
 */
function hotUnder(...logins: string[]): ExposedModel {
  const base = exposed('alpha', 'hot')
  const entries = logins.map((login) => ({
    ...base,
    login,
    model: { ...base.model, provider: login }
  }))
  return { ...(entries[0] ?? base), logins: entries }
}

/**
 * Renders the view, the model selected, as plain text.
 *
 * @param model - the one model listed
 * @param loginFallbackOn - `routing.logins.fallbackOn`
 * @returns the rows, without colour codes
 */
function rendered(model: ExposedModel, loginFallbackOn: readonly FailureClass[]): string {
  const view: ModelsView = {
    models: [model],
    aliases: {},
    diagnostics: [],
    families: [],
    routing: { loginFallbackOn },
    selected: 0
  }
  return modelsRows(view, { height: 24, width: SIDE_BY_SIDE }, 0)
    .rows.map((row) => stripTerminalSequences(row))
    .join('\n')
}

afterEach(() => {
  clearAllCooldowns()
})

describe('the console Models view, by the login a request would call', () => {
  // Catches the view reading as cooling while a free login serves the model: the cell shows the
  // cooldown of the login a request would call, which depends on `routing.logins.fallbackOn`.
  test.each([
    { fallbackOn: ['rate_limit' as const], shown: false },
    { fallbackOn: [], shown: true }
  ])(
    "shows the first login's cooldown only when a request would call it ($fallbackOn)",
    ({ fallbackOn, shown }) => {
      startCooldown({ provider: 'alpha', canonicalId: 'alpha/hot' }, 'rate_limit', 42_000, 0)

      expect(rendered(hotUnder('alpha', 'alpha-2'), fallbackOn).includes('cooling 42s')).toBe(shown)
    }
  )

  // Catches the pane naming one login beside another's cooldown (#380 review): with both logins
  // cooling, a request calls the one that ends first, and the pane names it with its countdown.
  test("the pane names the login a request would call, with that login's cooldown", () => {
    startCooldown({ provider: 'alpha-2', canonicalId: 'alpha/hot' }, 'rate_limit', 60_000, 0)
    startCooldown({ provider: 'alpha-3', canonicalId: 'alpha/hot' }, 'rate_limit', 42_000, 0)

    const text = rendered(hotUnder('alpha-2', 'alpha-3'), ['rate_limit'])

    expect(text).toMatch(/login alpha-3/u)
    expect(text).toMatch(/cooling 42s rate_limit/u)
    expect(text).not.toMatch(/alpha-2/u)
  })
})
