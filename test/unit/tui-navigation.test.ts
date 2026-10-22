import type { ProviderCredentialStatus } from '@proxy/pi/registry'
import {
  accountActions,
  clampSelection,
  moveSelection,
  stepView,
  VIEWS
} from '@proxy/tui/navigation'
import { describe, expect, test } from 'vite-plus/test'

describe('console navigation', () => {
  // Catches the view keys getting stuck at either end instead of wrapping around the tabs.
  test('moving between views wraps around', () => {
    expect(VIEWS.map((view) => stepView(view, 1))).toEqual(['accounts', 'stats', 'logs'])
    expect(VIEWS.map((view) => stepView(view, -1))).toEqual(['stats', 'logs', 'accounts'])
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
      'Log out of anthropic'
    ])
    expect(accountActions(account('api_key'))[1]).toEqual({
      action: 'login',
      label: 'Enter a new API key'
    })
  })
})
