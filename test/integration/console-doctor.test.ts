/**
 * The console's Doctor view (#325), end to end over a fixture agent dir: the console's own status
 * read, logins and Stats view feed the doctor as the running console does, the view renders its
 * findings, and nothing is called upstream or written. A config change shows on the next read.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { loadConfig } from '@proxy/config/env'
import { getCredentialStatuses } from '@proxy/pi/registry'
import { createProxyAuthSwitch } from '@proxy/server/proxy-auth'
import { createDoctorSource, type DoctorConsole } from '@proxy/tui/console-doctor'
import { initialState, readStatus } from '@proxy/tui/console-state'
import { openStatsView } from '@proxy/tui/dashboard'
import { doctorPointer, doctorRows } from '@proxy/tui/doctor-view'
import { pickedWindow } from '@proxy/tui/navigation'
import { createRefresh } from '@proxy/tui/status-refresh'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'
import { type MockProvider, startMockProvider, textChunks, sse } from '../fixtures/mock-provider'

/** What a test opened, closed after it. */
const opened: { agentDir?: FixtureAgentDir; mock?: MockProvider; close?: () => void } = {}

afterEach(async () => {
  opened.close?.()
  await opened.mock?.close()
  opened.agentDir?.remove()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

/**
 * Reads every file in a directory, by name, but the stats file's `-shm`: SQLite's shared-memory
 * index, whose read marks any read in WAL mode moves (the Stats view's own reads too); it holds
 * no data, and the database and its `-wal` are compared.
 *
 * @param path - the directory
 * @returns each file's bytes, as base64
 */
function snapshot(path: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(path)
      .filter((fileName) => !fileName.endsWith('-shm'))
      .map((fileName) => [fileName, readFileSync(join(path, fileName)).toString('base64')])
  )
}

/** The console as the doctor reads it, with how to read the status and logins again. */
interface Console {
  readonly context: DoctorConsole
  readonly refresh: () => Promise<void>
  readonly agentDir: FixtureAgentDir
  readonly mock: MockProvider
}

/**
 * Starts what the console holds over a fixture agent dir whose one provider is the mock: the
 * running config, the proxy auth, the Stats view and the state, read once as at startup.
 *
 * @returns the console
 */
async function openConsole(): Promise<Console> {
  const reply = sse(textChunks('hi'))
  const mock = await startMockProvider({ one: reply, two: reply })
  const agentDir = await loadFixtureAgentDir({
    modelsJson: { providers: { alpha: mock.provider() } }
  })
  const config = loadConfig({})
  const statsView = openStatsView(config.statsEnabled)
  Object.assign(opened, { agentDir, mock, close: () => statsView.close() })
  const state = initialState()
  const refresh = createRefresh(
    state,
    { status: readStatus, accounts: getCredentialStatuses },
    () => undefined
  )
  await refresh()
  const proxyAuth = createProxyAuthSwitch(config.proxyAuth)
  return { context: { config, state, proxyAuth, statsView }, refresh, agentDir, mock }
}

describe('the console’s Doctor view', () => {
  // Catches the view calling a provider (verifying a login may refresh an OAuth token) or writing
  // to the agent dir, the logins it could not verify itself shown as fine instead of pointing at
  // the Accounts view's v, and too few calls answered with the CLI's --window flag (or Settings)
  // instead of this view's window key.
  test('renders the findings from the console’s state, calling and writing nothing', async () => {
    const { context, agentDir, mock } = await openConsole()
    const fetched = vi.spyOn(globalThis, 'fetch')
    const before = snapshot(agentDir.path)
    const doctor = createDoctorSource()

    context.state.view = 'doctor'
    const report = doctor(context)
    const shown = doctorRows({ report, selected: 0 }, { height: 30, width: 140 }).map((row) =>
      stripTerminalSequences(row)
    )

    expect(report?.general).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          check: 'credentials',
          severity: 'advice',
          message: expect.stringContaining('alpha. Not verified.')
        })
      ])
    )
    expect(shown[0]).toMatch(/^› ADVICE {2}credentials {6}1 provider has .* → 2 Accounts, v {2}╭/u)
    expect(report?.statsAvailable).toBe(true)
    expect(report?.cache).toEqual([
      expect.objectContaining({
        check: 'window',
        recommendation: 'Try a longer window (a: all 30 days), or come back after more traffic.'
      })
    ])
    expect(report?.cache.map(doctorPointer)).toEqual(['a'])
    expect(fetched).not.toHaveBeenCalled()
    expect(mock.requests).toHaveLength(0)
    expect(snapshot(agentDir.path)).toEqual(before)
  })

  // Catches the Doctor view reading its own window rather than the one the Stats view's keys set
  // (and back), or a report kept from before the window changed.
  test('reads the window the Stats view sets, and sets it for the Stats view', async () => {
    const { context } = await openConsole()
    const doctor = createDoctorSource()
    const { state } = context

    expect(doctor(context)?.window).toBe('today')
    state.view = 'stats'
    state.statsWindow = pickedWindow(state.view, state.statsWindow, 'week')
    expect(doctor(context)?.window).toBe('week')
    state.view = 'doctor'
    state.statsWindow = pickedWindow(state.view, state.statsWindow, 'all')
    expect(state.statsWindow).toBe('all')
    expect(doctor(context)?.window).toBe('all')
  })

  // Catches a config change made elsewhere in the console (the Models view's alias editor writes
  // the file) missing from the Doctor view until a restart, or judged before the status read.
  test('shows a config change on the next status read', async () => {
    const { context, refresh, agentDir } = await openConsole()
    const doctor = createDoctorSource()
    const fallbackOn = (): unknown[] =>
      (doctor(context)?.general ?? []).filter((finding) => finding.check === 'fallback-on')

    expect(fallbackOn()).toEqual([])
    writeFileSync(
      join(agentDir.path, 'proxy-config.json'),
      JSON.stringify({
        aliases: {
          fast: { targets: ['alpha/one', 'alpha/two'], fallbackOn: ['upstream_error'] }
        }
      })
    )
    expect(fallbackOn()).toEqual([])
    await refresh()

    expect(fallbackOn()).toEqual([expect.objectContaining({ subject: 'fast' })])
  })
})
