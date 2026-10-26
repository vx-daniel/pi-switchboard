/**
 * The console's settings editors (#288), end to end against a real `proxy-config.json`: each
 * menu, answered by scripted dialogs, refuses a value outside the setting's bounds with the reason,
 * saves what the config file keeps, offers a restart for a setting read at startup, and never
 * replaces an `authToken` that is not a string (#82).
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runSetting, type SettingsEditor } from '@proxy/tui/console-settings'
import type { DialogScreens } from '@proxy/tui/dialogs'
import type { RestartReport } from '@proxy/tui/proxy-server'
import { isRecord } from '@proxy/utils/guards'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

let agentDir: string

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), 'pi-switchboard-settings-'))
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDir)
  writeConfig({ port: 4141 })
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(agentDir, { recursive: true, force: true })
})

/**
 * Writes the config file.
 *
 * @param config - its contents
 */
function writeConfig(config: Record<string, unknown>): void {
  writeFileSync(join(agentDir, 'proxy-config.json'), JSON.stringify(config))
}

/**
 * Reads the config file as written.
 *
 * @returns its contents
 */
function savedConfig(): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(join(agentDir, 'proxy-config.json'), 'utf8'))
  if (!isRecord(parsed)) throw new Error('proxy-config.json is not an object')
  return parsed
}

/** A scripted editor, and what it was asked and did. */
interface Scripted {
  readonly editor: SettingsEditor
  /** Each dialog's title, in order. */
  readonly asked: string[]
  /** How many times the server was restarted. */
  readonly restarts: () => number
}

/**
 * Builds an editor whose dialogs take their answers from a script, in order. A select answer must
 * be one of the options offered, so a renamed option fails the test rather than passing silently.
 *
 * @param answers - each dialog's answer; `undefined` cancels
 * @param fields - the editor's fields to change
 * @param report - what a restart reports
 * @returns the editor and what it recorded
 */
function scripted(
  answers: readonly (string | readonly string[] | undefined)[],
  fields: Partial<SettingsEditor> = {},
  report: RestartReport = { kind: 'restarted' }
): Scripted {
  const queue = [...answers]
  const asked: string[] = []
  let restarts = 0
  const next = (title: string): string | readonly string[] | undefined => {
    asked.push(title)
    if (queue.length === 0) throw new Error(`no scripted answer for: ${title}`)
    return queue.shift()
  }
  const screens: DialogScreens = {
    select: async (title, labels) => {
      const answer = next(title)
      if (answer !== undefined && (typeof answer !== 'string' || !labels.includes(answer))) {
        throw new Error(`"${String(answer)}" is not offered by "${title}": ${labels.join(' | ')}`)
      }
      return answer
    },
    input: async (title) => {
      const answer = next(title)
      if (typeof answer !== 'string' && answer !== undefined) throw new Error('input takes text')
      return answer
    }
  }
  const editor: SettingsEditor = {
    screens,
    pickMany: async (title) => {
      const answer = next(title)
      if (typeof answer === 'string' || answer === undefined) {
        throw new Error('pickMany takes a list')
      }
      return [...answer]
    },
    models: ['alpha/one', 'alpha/two'],
    providers: ['alpha', 'beta'],
    logins: ['alpha', 'alpha-2'],
    authOn: false,
    overrides: {},
    openAuth: async () => undefined,
    restart: async () => {
      restarts += 1
      return report
    },
    refresh: async () => undefined,
    ...fields
  }
  return { editor, asked, restarts: () => restarts }
}

describe('runSetting', () => {
  // Catches an out-of-range port saved (clamped by the loader into another port) or refused
  // without the reason, and a restart-only setting saved without the offer to apply it.
  test('re-asks a port out of range with the reason, saves the valid one, and restarts on request', async () => {
    const { editor, asked, restarts } = scripted(['70000', '8080', 'Restart the server now'])

    await runSetting(editor, 'port')

    expect(asked[1]).toMatch(/^Not a whole number from 1 to 65535\./)
    expect(savedConfig()['port']).toBe(8080)
    expect(restarts()).toBe(1)
  })

  // Catches a saved setting a flag holds offered a restart, which would not apply it.
  test('says a flag holds the setting instead of offering a restart', async () => {
    const { editor, asked, restarts } = scripted(['8080', 'OK'], { overrides: { port: '--port' } })

    await runSetting(editor, 'port')

    expect(savedConfig()['port']).toBe(8080)
    expect(asked.at(-1)).toContain('--port wins over the file')
    expect(restarts()).toBe(0)
  })

  // Catches binding beyond loopback with auth off saved without asking (any client on the
  // network could use the logins), and the confirmation asked when auth is on.
  test('asks before listening beyond this machine with auth off, and saves nothing when declined', async () => {
    const declined = scripted(['0.0.0.0 (every interface)', 'Keep the address'])
    await runSetting(declined.editor, 'host')

    expect(declined.asked[1]).toContain('Proxy auth is off')
    expect(savedConfig()['host']).toBeUndefined()

    const withAuth = scripted(['0.0.0.0 (every interface)', 'Later (r on this view)'], {
      authOn: true
    })
    await runSetting(withAuth.editor, 'host')

    expect(savedConfig()['host']).toBe('0.0.0.0')
    expect(withAuth.asked.some((title) => title.includes('Proxy auth is off'))).toBe(false)
  })

  // Catches custom exposure switched on with an empty list (it serves no model) without opening
  // the list, and a listed model that is not available now dropped from the list.
  test('choosing custom exposure with an empty list opens the list, keeping unavailable entries', async () => {
    writeConfig({ customModels: [] })
    const { editor } = scripted(['custom', ['alpha/two']])
    await runSetting(editor, 'modelExposureMode')

    expect(savedConfig()).toMatchObject({
      modelExposureMode: 'custom',
      customModels: ['alpha/two']
    })

    const offered: string[][] = []
    writeConfig({ modelExposureMode: 'custom', customModels: ['gone/model'] })
    await runSetting(
      {
        ...scripted([]).editor,
        pickMany: async (_title, options, ticked) => {
          offered.push([...options])
          return [...ticked, 'alpha/one']
        }
      },
      'customModels'
    )

    expect(offered[0]).toEqual(['alpha/one', 'alpha/two', 'gone/model'])
    expect(savedConfig()['customModels']).toEqual(['gone/model', 'alpha/one'])
  })

  // Catches a prefix with surrounding spaces saved verbatim (every public ID would carry them),
  // and removing a prefix leaving it in the file.
  test('adds a provider prefix, refusing one with spaces, and removes it', async () => {
    const add = scripted(['+ Add…', 'alpha', ' a ', 'a'])
    await runSetting(add.editor, 'providerPrefixes')

    expect(add.asked[3]).toMatch(/^A prefix can't be empty or start or end with a space\./)
    expect(savedConfig()['providerPrefixes']).toEqual({ alpha: 'a' })

    await runSetting(scripted(['alpha → a', 'Remove it']).editor, 'providerPrefixes')

    expect(savedConfig()['providerPrefixes']).toEqual({})
  })

  // Catches a share outside 0 to 1 saved (the loader would drop it, losing the reserve), and an
  // empty answer leaving the old reserve in place.
  test('sets a login reserve, re-asking a share outside 0 to 1, and clears it', async () => {
    const set = scripted(['alpha-2  none', '20', '0.2'])
    await runSetting(set.editor, 'reserve')

    expect(set.asked[2]).toMatch(/^Not a share from 0 to 1/)
    expect(savedConfig()['routing']).toMatchObject({ reserve: { 'alpha-2': 0.2 } })

    await runSetting(scripted(['alpha-2  0.2', '']).editor, 'reserve')

    expect(savedConfig()['routing']).toMatchObject({ reserve: {} })
  })

  // Catches the login fallback classes saved in the order ticked rather than the schema's, or
  // saved when the list was cancelled.
  test('saves the login fallback classes ticked, in the schema order', async () => {
    const { editor } = scripted(['[ ] timeout', '[ ] unavailable', 'Done'])
    await runSetting(editor, 'loginFallbackOn')

    expect(savedConfig()['routing']).toMatchObject({
      logins: { fallbackOn: ['rate_limit', 'unavailable', 'timeout'] }
    })

    await runSetting(scripted(['[x] timeout', undefined]).editor, 'loginFallbackOn')

    expect(savedConfig()['routing']).toMatchObject({
      logins: { fallbackOn: ['rate_limit', 'unavailable', 'timeout'] }
    })
  })

  // Catches saving another setting writing the loader's repaired '' over a token that is not a
  // string, which would turn auth off for good (#82).
  test('keeps an authToken that is not a string when saving another setting', async () => {
    writeConfig({ authToken: 12_345 })
    await runSetting(scripted(['On', 'Later (r on this view)']).editor, 'docsUi')

    expect(savedConfig()).toMatchObject({ authToken: 12_345, docsUi: true })
  })

  // Catches a restart that kept the old server reported as done, leaving the operator to believe
  // the saved settings run.
  test('says why when the restart keeps the proxy as it was', async () => {
    const { editor, asked } = scripted(
      ['8080', 'Restart the server now', 'OK'],
      {},
      { kind: 'kept', reason: 'listen EADDRINUSE' }
    )

    await runSetting(editor, 'port')

    expect(asked.at(-1)).toContain('listen EADDRINUSE')
    expect(asked.at(-1)).toContain('still runs as before')
  })
})
