import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import type { ProviderCredentialStatus } from '@proxy/pi/registry'
import {
  accountActions,
  clampSelection,
  footerLine,
  logsKeys,
  moveSelection,
  stepView,
  VIEWS
} from '@proxy/tui/navigation'
import { describe, expect, test } from 'vite-plus/test'

describe('console navigation', () => {
  // Catches the view keys getting stuck at either end instead of wrapping around the tabs.
  test('moving between views wraps around', () => {
    expect(VIEWS.map((view) => stepView(view, 1))).toEqual([
      'accounts',
      'stats',
      'models',
      'settings',
      'logs'
    ])
    expect(VIEWS.map((view) => stepView(view, -1))).toEqual([
      'settings',
      'logs',
      'accounts',
      'stats',
      'models'
    ])
  })

  // Catches the selection leaving the list: past the login row after the last account, above the
  // first account, or left behind when a logout shortened the list.
  test('the account selection stays on the list, the login row included', () => {
    const accounts = 2

    expect(moveSelection(0, accounts, -1)).toBe(0)
    expect(moveSelection(1, accounts, 1)).toBe(2)
    expect(moveSelection(2, accounts, 1)).toBe(2)
    expect(moveSelection(0, accounts, 10)).toBe(2)
    expect(clampSelection(2, 1)).toBe(1)
    expect(clampSelection(3, 0)).toBe(0)
  })

  // Catches an account's menu offering the wrong kind of login, or a logout not naming the
  // provider it removes.
  test('an account menu offers the login of its kind and names the provider it logs out of', () => {
    const account = (type: ProviderCredentialStatus['type']): ProviderCredentialStatus => ({
      provider: 'anthropic',
      type,
      availableModelCount: 1
    })

    expect(accountActions(account('oauth')).map((choice) => choice.label)).toEqual([
      'Verify all logins',
      'Log in again',
      'Set a label',
      'Log out of anthropic'
    ])
    expect(accountActions(account('api_key'))[1]).toEqual({
      action: 'login',
      label: 'Enter a new API key'
    })
  })

  // Catches the footer offering the sidebar key on a terminal too narrow for the sidebar, where it
  // does nothing, or hiding it where it works; and a footer row wider or narrower than the
  // terminal.
  test('offers the sidebar key only where the sidebar fits, and fills the width exactly', () => {
    for (const view of VIEWS) {
      const narrow = footerLine(view, { width: 99, sidebarFits: false })
      const wide = footerLine(view, { width: 160, sidebarFits: true })

      expect(stripTerminalSequences(narrow)).not.toContain(' s  sidebar')
      expect(stripTerminalSequences(wide)).toContain(' s  sidebar')
      expect(visibleWidth(narrow)).toBe(99)
      expect(visibleWidth(wide)).toBe(160)
    }
  })

  // Catches the view's keys on the left and the global keys on the right swapping, or quitting
  // (which stops the proxy) being the first key to go on a narrow terminal instead of the last.
  test('keeps the view’s keys left, the global keys right, and quitting last of all', () => {
    const wide = stripTerminalSequences(footerLine('logs', { width: 160, sidebarFits: true }))
    expect(wide).toMatch(/^ {2}↑↓ {2}scroll .* {2}q {2}quit \(stops the proxy\) $/)

    const at80 = stripTerminalSequences(footerLine('accounts', { width: 80, sidebarFits: false }))
    expect(at80).toMatch(/ q {2}quit \(stops the proxy\) $/)
    expect(at80).not.toContain('views')

    const at48 = stripTerminalSequences(footerLine('accounts', { width: 48, sidebarFits: false }))
    expect(at48).toMatch(/^ {2}↑↓ {2}select +q {2}quit \(stops the proxy\) $/)
    expect(visibleWidth(at48)).toBe(48)
  })

  // Catches `r` named for both views at once, or for the view already shown, instead of the one
  // it switches to.
  test('the first view’s r names the other view: the raw log from the table, and back', () => {
    const size = { width: 160, sidebarFits: true }
    const onTable = stripTerminalSequences(footerLine('logs', size, logsKeys(false)))
    const onRaw = stripTerminalSequences(footerLine('logs', size, logsKeys(true)))

    expect(onTable).toMatch(/ r {2}raw log /u)
    expect(onRaw).toMatch(/ r {2}requests /u)
    expect(onRaw).not.toContain('raw log')
  })
})
