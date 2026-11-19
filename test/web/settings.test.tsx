import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

import { renderApp, stubApi, VIEWER } from './harness'

const EDITOR = { login: 'alice', role: 'editor' }

/** A setting as the proxy sends it. */
const STATS = {
  key: 'stats',
  label: 'Stats',
  section: 'features',
  help: 'Keeps request statistics.',
  saved: 'on',
  applies: 'restart',
  value: true,
  input: { kind: 'switch' }
}

const HOST = {
  key: 'host',
  label: 'Host',
  section: 'server',
  help: 'The address the proxy listens on.',
  saved: '127.0.0.1',
  applies: 'restart',
  value: '127.0.0.1',
  input: { kind: 'text' }
}

const AUTH = {
  key: 'authToken',
  label: 'Proxy auth',
  section: 'auth',
  help: 'A token clients must send.',
  saved: 'off',
  applies: 'live',
  value: null,
  input: { kind: 'console' }
}

const SETTINGS = {
  path: '/home/op/.pi/agent/proxy-config.json',
  fileProblem: null,
  settings: [HOST, STATS, AUTH],
  pendingRestart: 1
}

afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * Reads the bodies the page sent to change a setting.
 *
 * @param calls - every request made
 * @param key - the setting
 * @returns each body, parsed
 */
function writes(
  calls: readonly { method: string; path: string; body: string | undefined }[],
  key: string
): unknown[] {
  return calls
    .filter((call) => call.method === 'PUT' && call.path === `/admin/api/settings/${key}`)
    .map((call): unknown => JSON.parse(call.body ?? 'null'))
}

describe('the Settings page', () => {
  // Catches a viewer offered controls the API would refuse, or the restart that applies a saved
  // setting not mentioned.
  test('a viewer reads the settings without controls', async () => {
    stubApi({ '/session': VIEWER, '/settings': SETTINGS })
    renderApp('#/settings')

    expect(await screen.findByText(/read only/u)).toBeTruthy()
    expect(screen.getByText(/1 saved setting is not\s+running yet/u)).toBeTruthy()
    expect(screen.queryByRole('checkbox', { name: 'Stats' })).toBeNull()
  })

  // Catches a switch that doesn't save, or saves the value it already had.
  test('an editor flips a switch and it is saved', async () => {
    const calls = stubApi({
      '/session': EDITOR,
      '/settings': SETTINGS,
      '/settings/stats': {
        ...SETTINGS,
        settings: [HOST, { ...STATS, saved: 'off', value: false }, AUTH]
      }
    })
    renderApp('#/settings')

    fireEvent.click(await screen.findByRole('checkbox', { name: 'Stats' }))

    await waitFor(() => {
      expect(writes(calls, 'stats')).toEqual([{ value: false, confirm: false }])
    })
    expect(screen.getByText('Change it in the console (p).')).toBeTruthy()
  })

  // Catches listening beyond loopback with auth off saved without asking, or asked again and again
  // when the proxy still refuses: one question, one confirmed resend, then the refusal shown.
  test('asks once before listening beyond this machine', async () => {
    const confirm = vi.fn(() => true)
    vi.stubGlobal('confirm', confirm)
    const calls = stubApi({
      '/session': EDITOR,
      '/settings': SETTINGS,
      '/settings/host': {
        status: 400,
        body: {
          error: { code: 'confirm_required', message: 'Listen beyond this machine with no token?' }
        }
      }
    })
    renderApp('#/settings')

    fireEvent.change(await screen.findByRole('textbox', { name: 'Host' }), {
      target: { value: '0.0.0.0' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Listen beyond this machine with no token?')).toBeTruthy()
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(writes(calls, 'host')).toEqual([
      { value: '0.0.0.0', confirm: false },
      { value: '0.0.0.0', confirm: true }
    ])
  })
})
