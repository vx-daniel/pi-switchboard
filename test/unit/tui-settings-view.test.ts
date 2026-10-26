/**
 * The console's Settings view (`src/tui/settings-view.ts`, #288): which flag or env var wins over
 * the file, when a row shows the running value, how many settings wait for a restart, and the
 * list scrolled to keep the selected setting on screen with its help under it.
 */

import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { DEFAULT_CONFIG } from '@proxy/config/schema'
import {
  pendingRestart,
  SETTING_KEYS,
  type SettingRow,
  settingOverrides,
  settingRows,
  type SettingsInput,
  settingsViewRows
} from '@proxy/tui/settings-view'
import { describe, expect, test } from 'vite-plus/test'

import { testConfig } from '../helpers'

/**
 * Builds the view's input: the default file, running as it says, auth off, no overrides.
 *
 * @param fields - the fields to change
 * @returns the input
 */
function input(fields: Partial<SettingsInput> = {}): SettingsInput {
  return {
    file: DEFAULT_CONFIG,
    running: { ...testConfig(), statsEnabled: DEFAULT_CONFIG.stats },
    authOn: false,
    authInvalid: false,
    overrides: {},
    ...fields
  }
}

/**
 * Finds one setting's row.
 *
 * @param rows - the rows
 * @param key - the setting
 * @returns its row
 */
function row(rows: readonly SettingRow[], key: SettingRow['key']): SettingRow | undefined {
  return rows.find((candidate) => candidate.key === key)
}

describe('settingOverrides', () => {
  // Catches the env var named where the flag wins, or a setting reported overridden by an env var
  // that is not set.
  test('names the flag over the env var, and an env var only when it is set', () => {
    const overrides = settingOverrides(
      { port: 8080 },
      {
        PI_SWITCHBOARD_PORT: '9090',
        PI_SWITCHBOARD_HOST: '0.0.0.0',
        PI_SWITCHBOARD_STATS: undefined
      }
    )

    expect(overrides).toEqual({ port: '--port', host: 'PI_SWITCHBOARD_HOST' })
  })
})

describe('settingRows', () => {
  // Catches a restart-only setting showing no running value after it was saved, or a live one
  // claiming to wait for a restart.
  test('shows the running value of a restart-only setting saved but not applied', () => {
    const rows = settingRows(input({ file: { ...DEFAULT_CONFIG, port: 8080 } }))

    expect(row(rows, 'port')).toMatchObject({ saved: '8080', running: '4141', applies: 'restart' })
    expect(row(rows, 'host')?.running).toBeUndefined()
    expect(row(rows, 'publicModelIdMode')).toMatchObject({ applies: 'live' })
    expect(pendingRestart(rows)).toBe(1)
  })

  // Catches a setting a flag holds counted as waiting for a restart, which would never apply it.
  test('a setting a flag holds does not wait for a restart', () => {
    const rows = settingRows(
      input({ file: { ...DEFAULT_CONFIG, port: 8080 }, overrides: { port: '--port' } })
    )

    expect(row(rows, 'port')?.override).toBe('--port')
    expect(pendingRestart(rows)).toBe(0)
  })

  // Catches an invalid authToken shown as `off` (#82): the proxy refuses to start on it, so `off`
  // would misreport it; and the running auth hidden when the menu turned it off until a restart.
  test('says an invalid token is invalid, and shows the auth running when it differs', () => {
    const rows = settingRows(
      input({ file: { ...DEFAULT_CONFIG, authToken: 'secret' }, authOn: false, authInvalid: false })
    )
    const invalid = settingRows(input({ authInvalid: true }))

    expect(row(rows, 'authToken')).toMatchObject({ saved: 'on', running: 'off', applies: 'live' })
    expect(row(invalid, 'authToken')?.saved).toBe('invalid')
  })
})

describe('settingsViewRows', () => {
  // Catches the selected setting scrolled off a short view, or its help missing.
  test('keeps the selected setting on a short view, with its help under the list', () => {
    const rows = settingRows(input())
    const last = SETTING_KEYS.length - 1
    const shown = settingsViewRows(rows, last, { height: 10, width: 100 }).map((line) =>
      stripTerminalSequences(line)
    )

    expect(shown).toHaveLength(10)
    expect(shown.some((line) => line.startsWith('› Login fallback'))).toBe(true)
    expect(shown.join('\n')).toContain("next login of the model's provider")
    expect(shown.join('\n')).not.toContain('Bind address')
  })
})
