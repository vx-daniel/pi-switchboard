import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { clearAllQuotas, recordQuota } from '@proxy/pi/quota'
import type { ProviderCredentialStatus } from '@proxy/pi/registry'
import { accountRows, type AccountsView } from '@proxy/tui/accounts-view'
import { beforeEach, describe, expect, test } from 'vite-plus/test'

/** Rows enough for every test's view. */
const HEIGHT = 10

/**
 * Builds a provider's credential status.
 *
 * @param provider - the provider
 * @returns the status: an API key from models.json, with one model
 */
function account(provider: string): ProviderCredentialStatus {
  return { provider, type: 'api_key', source: 'models_json_key', availableModelCount: 1 }
}

/**
 * Renders the view as plain text.
 *
 * @param view - what the view shows
 * @returns the rows, without colour codes or trailing spaces
 */
function rendered(view: AccountsView): string[] {
  return accountRows(view, HEIGHT).map((row) => stripTerminalSequences(row).trimEnd())
}

beforeEach(() => {
  clearAllQuotas()
})

describe('the console Accounts view', () => {
  // Catches a provider name longer than its column pushing the columns after it out of line:
  // pi's own `qwen-token-plan-individual` is 26 characters against a 22-column field.
  test('cuts a long provider name so the columns stay aligned', () => {
    const rows = rendered({
      accounts: [account('qwen-token-plan-individual'), account('short')],
      selected: 2,
      reserve: {},
      labels: {}
    })
    const loginColumn = (row: string): number => visibleWidth(row.slice(0, row.indexOf('API key')))

    expect(rows[1]).toContain('qwen-token-plan-indiv… ')
    expect(loginColumn(rows[1] ?? '')).toBe(loginColumn(rows[2] ?? ''))
  })

  // Catches the quota left out, shown in the wrong unit, or a provider below its reserve not
  // marked: the share used per window, as a percentage, and `below reserve` under it.
  test('shows the share used per window, and marks a provider below its reserve', () => {
    const reset = String(Math.floor(Date.now() / 1000) + 3600)
    recordQuota(
      'anthropic',
      new Headers({
        'anthropic-ratelimit-unified-5h-utilization': '0.12',
        'anthropic-ratelimit-unified-5h-reset': reset,
        'anthropic-ratelimit-unified-7d-utilization': '0.85',
        'anthropic-ratelimit-unified-7d-reset': reset
      })
    )
    const view = { accounts: [account('anthropic')], selected: 0, labels: {} }

    expect(rendered({ ...view, reserve: {} })[1]).toMatch(/ 5h 12% 7d 85%$/)
    expect(rendered({ ...view, reserve: { anthropic: 0.2 } })[1]).toMatch(
      / 5h 12% 7d 85% below reserve$/
    )
  })

  // Catches the selection mark on the wrong row, or the login row missing after the accounts.
  test('marks the selected row, and ends with the login row', () => {
    const rows = rendered({
      accounts: [account('alpha'), account('beta')],
      selected: 2,
      reserve: {},
      labels: {}
    })

    expect(rows.slice(1).map((row) => row.slice(0, 2))).toEqual(['  ', '  ', '› '])
    expect(rows.at(-1)).toBe('› + Log in to a provider…')
  })

  // Catches a label missing from its login's row, shown on another login, or a long one pushing
  // the columns after it out of line.
  test('shows a login label in its own column, cut to the column', () => {
    const rows = rendered({
      accounts: [account('anthropic'), account('anthropic-2')],
      selected: 0,
      reserve: {},
      labels: { 'anthropic-2': 'work subscription' }
    })
    const loginColumn = (row: string): number => visibleWidth(row.slice(0, row.indexOf('API key')))

    expect(rows[1]).toMatch(/^› anthropic\s+API key/)
    expect(rows[2]).toContain('anthropic-2            work subscr… API key')
    expect(loginColumn(rows[1] ?? '')).toBe(loginColumn(rows[2] ?? ''))
  })
})
