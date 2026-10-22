/**
 * The console's Accounts view (#61): each provider pi has a credential for, as the proxy sees it,
 * with its quota (#69), then the row that opens pi's login selector.
 *
 * @packageDocumentation
 */

import { styleText } from 'node:util'

import { truncateToWidth } from '@earendil-works/pi-tui'
import type { Reserve } from '@proxy/config/schema'
import { providerQuota } from '@proxy/pi/quota'
import type { ProviderCredentialStatus } from '@proxy/pi/registry'
import { providerBelowReserve } from '@proxy/server/route-reserve'
import { clampSelection, LOGIN_ROW } from '@proxy/tui/navigation'

/** Widths of the view's columns: provider, auth type, source, model count. */
const COLUMNS = { provider: 22, login: 8, source: 16, models: 4 } as const
/** Percent in a whole: a window's share used is shown as a percentage. */
const PERCENT = 100

/** What the Accounts view shows. */
export interface AccountsView {
  /** The providers pi has a credential for. */
  readonly accounts: readonly ProviderCredentialStatus[]
  /** The selected row; the row after the accounts is the login row. */
  readonly selected: number
  /** The reserve per provider, to mark a provider below it. */
  readonly reserve: Reserve
}

/**
 * Renders whether a provider's credential was verified, when it was.
 *
 * @param account - the provider's status
 * @returns `''` when not verified, else a mark and, on failure, why
 */
function verification(account: ProviderCredentialStatus): string {
  if (account.verified === undefined) return ''
  if (account.verified) return styleText('green', ' ✓ verified')
  return styleText('red', ` ✗ ${account.error ?? 'failed'}`)
}

/**
 * Renders a provider's latest quota: the share used of each window it reports, in red with
 * `below reserve` when it has less left than its `routing.reserve` (#69).
 *
 * @param provider - the provider
 * @param reserve - the reserve per provider
 * @returns the cell; `''` when the provider reports no quota
 */
function quotaCell(provider: string, reserve: Reserve): string {
  const windows = providerQuota(provider)?.windows ?? []
  const used = windows
    .map((window) => `${window.name} ${String(Math.round(window.used * PERCENT))}%`)
    .join(' ')
  if (providerBelowReserve(provider, reserve) === undefined) return used
  return styleText('red', `${used} below reserve`)
}

/**
 * Renders one provider's credential status: provider, auth type, source, models, quota used,
 * verification.
 *
 * @param account - the provider's status; never the credential itself
 * @param reserve - the reserve per provider, to mark a provider below it
 * @returns the row's text, without its selection mark
 */
function accountRow(account: ProviderCredentialStatus, reserve: Reserve): string {
  const login = account.type === 'oauth' ? 'account' : 'API key'
  const cells = [
    // A name longer than its column (`qwen-token-plan-individual`, a models.json provider) is cut
    // with `…`, so the columns after it stay aligned.
    truncateToWidth(account.provider, COLUMNS.provider, '…', true),
    login.padEnd(COLUMNS.login),
    truncateToWidth(account.source ?? '', COLUMNS.source, '…', true),
    `${String(account.availableModelCount).padStart(COLUMNS.models)} models`,
    quotaCell(account.provider, reserve)
  ]
  return `${cells.join(' ')}${verification(account)}`
}

/**
 * Marks the selected row of a list: a pointer and reversed colours.
 *
 * @param text - the row's text
 * @param selected - whether it is the selected row
 * @returns the row, indented
 */
function selectable(text: string, selected: boolean): string {
  return selected ? styleText('inverse', `› ${text}`) : `  ${text}`
}

/**
 * Renders the Accounts view: a heading, one row per provider, then the login row.
 *
 * @param view - the accounts, the selected row and the reserve
 * @param height - rows available
 * @returns the rows
 */
export function accountRows(view: AccountsView, height: number): string[] {
  const { accounts, reserve } = view
  const titles = [
    'provider'.padEnd(COLUMNS.provider),
    'login'.padEnd(COLUMNS.login),
    'source'.padEnd(COLUMNS.source),
    'models'.padEnd(COLUMNS.models + ' models'.length),
    'quota used'
  ]
  const current = clampSelection(view.selected, accounts.length)
  const rows = accounts.map((account, index) =>
    selectable(accountRow(account, reserve), index === current)
  )
  const login = selectable(LOGIN_ROW, current === accounts.length)
  return [styleText('dim', `  ${titles.join(' ')}`), ...rows, login].slice(0, height)
}
