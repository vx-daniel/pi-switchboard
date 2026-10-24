/**
 * The console's Accounts view (`src/tui/accounts-view.ts`): the table of logins with their quota,
 * reserve, cooldowns and verification, the login row, and the detail pane for the selected row.
 */

import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import type { Cooldown } from '@proxy/pi/cooldowns'
import type { ProviderQuota } from '@proxy/pi/quota'
import type { ProviderCredentialStatus } from '@proxy/pi/registry'
import type { ReserveSkip } from '@proxy/server/route-reserve'
import { accountRows, accountsSnapshot, type AccountsView } from '@proxy/tui/accounts-view'
import { describe, expect, test } from 'vite-plus/test'

/** The clock every snapshot is rendered at. */
const NOW = 1_800_000_000_000
/** A wide view: the frame's inside on a 160-column terminal with the sidebar. */
const WIDE = 106
/** A narrow view: the frame's inside on an 80-column terminal. */
const NARROW = 76
/** Rows enough for the table and the detail pane. */
const TALL = 30

/**
 * Builds a login's credential status.
 *
 * @param provider - the login
 * @param fields - the fields to set
 * @returns the status: an account from pi's store, with 17 models
 */
function account(
  provider: string,
  fields: Partial<ProviderCredentialStatus> = {}
): ProviderCredentialStatus {
  return { provider, type: 'oauth', source: 'stored', availableModelCount: 17, ...fields }
}

/**
 * Builds a quota report with a 5-hour and a 7-day window.
 *
 * @param provider - the login
 * @param used - each window's share used
 * @returns the report
 */
function quota(provider: string, used: readonly [number, number]): ProviderQuota {
  return {
    provider,
    observedAt: NOW,
    status: 'allowed',
    plan: undefined,
    windows: [
      {
        name: '5h',
        used: used[0],
        resetsAt: NOW + 15_420_000,
        windowMinutes: 300,
        status: undefined
      },
      {
        name: '7d',
        used: used[1],
        resetsAt: NOW + 554_400_000,
        windowMinutes: 10_080,
        status: undefined
      }
    ]
  }
}

/**
 * Builds a snapshot: logins with no quota, nothing below its reserve, no cooldowns.
 *
 * @param fields - the fields to set
 * @returns the snapshot
 */
function view(fields: Partial<AccountsView> = {}): AccountsView {
  return {
    accounts: [account('anthropic')],
    selected: 0,
    labels: {},
    now: NOW,
    quotas: new Map(),
    belowReserve: new Map(),
    cooldowns: [],
    ...fields
  }
}

/**
 * Renders the view as plain text.
 *
 * @param input - the snapshot
 * @param size - the space available
 * @param size.height - rows
 * @param size.width - columns
 * @returns the rows, without colour codes or trailing spaces
 */
function rendered(input: AccountsView, size = { height: TALL, width: WIDE }): string[] {
  return accountRows(input, size).map((row) => stripTerminalSequences(row).trimEnd())
}

/**
 * Returns the detail pane's content lines.
 *
 * @param rows - the rendered rows
 * @returns the lines between the pane's borders, without the side borders
 */
function detail(rows: readonly string[]): string[] {
  const start = rows.findIndex((row) => row.startsWith('╭─ '))
  return rows.slice(start + 1, -1).map((row) => row.slice(2, -1).trimEnd())
}

describe('the console Accounts view', () => {
  // Catches a row wider or narrower than the view (a long login, label or error, a wide
  // character), which shifts the frame's right border.
  test.each([NARROW, WIDE, 140])('renders every row exactly %d columns wide', (width) => {
    const input = view({
      accounts: [
        account('a-login-with-a-very-long-name-indeed', {
          verified: false,
          error: 'a very long reason the token could not be refreshed'
        }),
        account('模型-provider')
      ],
      labels: { 'a-login-with-a-very-long-name-indeed': 'a label too long for its column' },
      quotas: new Map([['a-login-with-a-very-long-name-indeed', quota('a', [0.42, 0.95])]])
    })

    for (const row of accountRows(input, { height: TALL, width })) {
      expect(visibleWidth(row)).toBe(width)
    }
  })

  // Catches a login name or label longer than its column pushing the columns after it out of
  // line: pi's own `qwen-token-plan-individual` is 26 characters against a 22-column field.
  test('cuts a long login or label so the columns stay aligned', () => {
    const rows = rendered(
      view({
        accounts: [account('qwen-token-plan-individual'), account('short')],
        labels: { short: 'a label far too long' },
        selected: 2
      })
    )
    const kindColumn = (row: string): number => visibleWidth(row.slice(0, row.indexOf('account')))

    expect(rows[1]).toContain('qwen-token-plan-indiv… ')
    expect(rows[2]).toContain('a label far t… ')
    expect(kindColumn(rows[1] ?? '')).toBe(kindColumn(rows[2] ?? ''))
  })

  // Catches the quota left out of the table, shown in the wrong unit, or a narrow view dropping
  // the numbers along with the gauges: every login keeps its share used per window.
  test('shows the share used per window, with gauges where they fit', () => {
    const input = view({ quotas: new Map([['anthropic', quota('anthropic', [0.12, 0.85])]]) })

    expect(rendered(input)[1]).toMatch(/ {2}5h [▏▎▍▌▋▊▉█░]+ +12% {2}7d [▏▎▍▌▋▊▉█░]+ +85%$/)
    expect(rendered(input, { height: TALL, width: NARROW })[1]).toMatch(/ {2}5h +12% {2}7d +85%$/)
  })

  // Catches a login that reports no quota shown as 0%, or as nothing at all.
  test('marks a login with no quota report', () => {
    expect(rendered(view())[1]).toMatch(/ 17 {2}—$/)
  })

  // Catches a login below its reserve, cooling down, or failing verification not marked on its
  // row, where the operator scans for trouble.
  test('notes the reserve, the soonest cooldown and the verification on the row', () => {
    const cooldowns: Cooldown[] = [
      {
        scope: 'provider',
        provider: 'anthropic',
        model: undefined,
        reason: 'rate_limit',
        since: NOW,
        until: NOW + 300_000,
        source: 'response',
        streak: 0
      },
      {
        scope: 'model',
        provider: 'anthropic',
        model: 'anthropic/opus',
        reason: 'unavailable',
        since: NOW,
        until: NOW + 65_000,
        source: 'backoff',
        streak: 1
      }
    ]
    const skip: ReserveSkip = { provider: 'anthropic', window: '7d', left: 0.05, reserve: 0.2 }
    const rows = rendered(
      view({
        accounts: [
          account('anthropic', { verified: false, error: 'token expired' }),
          account('beta', { verified: true })
        ],
        quotas: new Map([['anthropic', quota('anthropic', [0.5, 0.95])]]),
        belowReserve: new Map([['anthropic', skip]]),
        cooldowns
      }),
      { height: TALL, width: 140 }
    )

    expect(rows[1]).toMatch(/ below reserve ⏸ 1m05s ✗ token expired$/)
    expect(rows[2]).toMatch(/ ✓ verified$/)
  })

  // Catches the selection mark on the wrong row, or the login row missing after the logins.
  test('marks the selected row, and ends the table with the login row', () => {
    const rows = rendered(view({ accounts: [account('alpha'), account('beta')], selected: 2 }))

    expect(rows.slice(1, 4).map((row) => row.slice(0, 2))).toEqual(['  ', '  ', '› '])
    expect(rows[3]).toBe('› + Log in to a provider…')
  })

  // Catches the detail pane missing what a row can only abbreviate: each window's reset, the
  // reserve with what is left, a model's cooldown, the source, the verification, the actions of
  // the login's kind.
  test('shows the selected login in full in the detail pane', () => {
    const lines = detail(
      rendered(
        view({
          accounts: [account('anthropic', { verified: false, error: 'token expired' })],
          labels: { anthropic: 'work-primary' },
          quotas: new Map([['anthropic', quota('anthropic', [0.12, 0.95])]]),
          belowReserve: new Map([
            ['anthropic', { provider: 'anthropic', window: '7d', left: 0.05, reserve: 0.2 }]
          ]),
          cooldowns: [
            {
              scope: 'model',
              provider: 'anthropic',
              model: 'anthropic/opus',
              reason: 'unavailable',
              since: NOW,
              until: NOW + 65_000,
              source: 'backoff',
              streak: 1
            }
          ]
        })
      )
    )

    expect(
      lines.map((line) => line.replaceAll(/ {2,}/g, ' ').replaceAll(/[▏▎▍▌▋▊▉█░]+/g, '▮'))
    ).toEqual([
      'kind account source stored models 17',
      '',
      '5h window ▮ 12% used · resets in 4h17m',
      '7d window ▮ 95% used · resets in 6d10h',
      'below reserve: 5% of 7d left, reserve 20%',
      '⏸ opus cooling down, 1m05s left',
      '✗ token expired',
      '',
      '↵ actions: verify all logins, log in again, set a label, log out of anthropic'
    ])
  })

  // Catches the pane's title missing the login or its label.
  test('titles the detail pane with the login and its label', () => {
    const rows = rendered(view({ labels: { anthropic: 'work-primary' } }))

    expect(rows.find((row) => row.startsWith('╭─ '))).toMatch(/^╭─ anthropic work-primary ─+╮$/)
  })

  // Catches the pane for the login row saying nothing, or a login that reported no quota shown
  // with empty windows in the pane.
  test('says what the login row does, and when a login has no quota yet', () => {
    expect(detail(rendered(view({ selected: 1 })))).toEqual([
      "↵ opens pi's login list: a provider, or another login of one you have"
    ])
    expect(detail(rendered(view()))).toContain('quota no quota reported yet')
  })

  // Catches the detail pane pushing logins off a short view: the table comes first, the pane
  // shows only when both fit, and the rows never exceed the height.
  test('leaves the detail pane out of a view too short for both', () => {
    const input = view({ accounts: ['a', 'b', 'c'].map((login) => account(login)) })

    expect(rendered(input, { height: 8, width: WIDE })).toHaveLength(5)
    expect(rendered(input, { height: 8, width: WIDE }).some((row) => row.startsWith('╭─'))).toBe(
      false
    )
    expect(rendered(input, { height: TALL, width: WIDE })).toHaveLength(TALL)
  })

  // Catches the selection moving off the bottom of a short view with more logins than rows.
  test('scrolls the table to keep the selected row on screen', () => {
    const accounts = Array.from({ length: 12 }, (_, index) => account(`login-${String(index)}`))
    const rows = rendered(view({ accounts, selected: 10 }), { height: 6, width: WIDE })

    expect(rows).toHaveLength(6)
    expect(rows.some((row) => row.startsWith('› ● login-10 '))).toBe(true)
    expect(rows.some((row) => row.includes('login-0 '))).toBe(false)
  })
})

describe('accountsSnapshot', () => {
  // Catches a login's quota or reserve looked up under another login, a login that reported none
  // given an empty report, or the logins, selection and cooldowns not passed through.
  test('looks up each login’s quota and reserve once, keeping only what it found', () => {
    const asked: string[] = []
    const skip: ReserveSkip = { provider: 'beta', window: '5h', left: 0.1, reserve: 0.2 }
    const base = {
      accounts: [account('alpha'), account('beta')],
      selected: 1,
      labels: { alpha: 'a' },
      now: NOW,
      cooldowns: []
    }
    const snapshot = accountsSnapshot(base, {
      quota: (login) => {
        asked.push(login)
        return login === 'alpha' ? quota('alpha', [0.1, 0.2]) : undefined
      },
      belowReserve: (login) => (login === 'beta' ? skip : undefined)
    })

    expect(asked).toEqual(['alpha', 'beta'])
    expect([...snapshot.quotas.keys()]).toEqual(['alpha'])
    expect([...snapshot.belowReserve.entries()]).toEqual([['beta', skip]])
    expect(snapshot).toMatchObject(base)
  })
})
