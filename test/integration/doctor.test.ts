/**
 * `pi-switchboard doctor` (#299) end to end: the command reads a fixture agent dir (pi's
 * models.json, the proxy's config) and a stats file in it, prints its report, and changes no file.
 * No login is used and no provider is called.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { type DoctorOptions } from '@proxy/doctor/collect'
import { doctorCommand, runDoctor } from '@proxy/doctor/command'
import { statsFilePath } from '@proxy/stats/recorder'
import { openStatsStore } from '@proxy/stats/store'
import { MS_PER_MINUTE } from '@proxy/utils/time'
import { runMain } from 'citty'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'

/** The agent dirs a test made, removed after it. */
const agentDirs: FixtureAgentDir[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  process.exitCode = undefined
  for (const agentDir of agentDirs.splice(0)) agentDir.remove()
})

/**
 * Loads an agent dir with one OpenAI Responses model at api.openai.com (an API that caches by
 * `prompt_cache_key`), priced, under a literal fake key; nothing is called.
 *
 * @returns the agent dir
 */
async function openAiAgentDir(): Promise<FixtureAgentDir> {
  const agentDir = await loadFixtureAgentDir({
    modelsJson: {
      providers: {
        alpha: {
          baseUrl: 'https://api.openai.com/v1',
          api: 'openai-responses',
          apiKey: 'notarealsecret-doctor-key',
          models: [{ id: 'one', cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 0 } }]
        }
      }
    }
  })
  agentDirs.push(agentDir)
  return agentDir
}

/**
 * Writes 30 calls on `alpha/one` this minute: nothing read from the cache, and no request keyed.
 */
function recordUncachedTraffic(): void {
  const minute = Math.floor(Date.now() / MS_PER_MINUTE)
  const store = openStatsStore(statsFilePath())
  store.add({
    requests: [
      {
        minute,
        alias: '',
        model: 'alpha/one',
        outcome: 'ok',
        status: 0,
        requests: 30,
        durationMsTotal: 0,
        durationMsMax: 0,
        firstEventMsTotal: 0,
        firstEventCount: 0,
        promptCacheKeyRequests: 0
      }
    ],
    attempts: [
      {
        minute,
        alias: '',
        provider: 'alpha',
        model: 'alpha/one',
        attempts: 30,
        failures: 0,
        fallbacks: 0,
        inputTokens: 30_000,
        outputTokens: 300,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.03
      }
    ],
    failures: []
  })
  store.close()
}

/**
 * Reads every file in a directory, by name.
 *
 * @param path - the directory
 * @returns each file's bytes, as base64
 */
function snapshot(path: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(path).map((fileName) => [
      fileName,
      readFileSync(join(path, fileName)).toString('base64')
    ])
  )
}

/** The doctor's options with the defaults the command uses. */
const OPTIONS: DoctorOptions = { overrides: {}, window: 'week', verify: false, now: 0 }

/**
 * Runs the doctor and keeps what it prints.
 *
 * @param json - whether to print JSON
 * @returns the exit status and the output
 */
async function doctor(json: boolean): Promise<{ readonly status: number; readonly text: string }> {
  let text = ''
  const status = await runDoctor(
    { ...OPTIONS, now: Date.now() },
    {
      json,
      write: (chunk) => {
        text += chunk
      }
    }
  )
  return { status, text }
}

describe('pi-switchboard doctor', () => {
  // Catches the command printing an empty or partial report from a real config and stats file,
  // failing on cache findings alone, or writing to the agent dir (it must change no file).
  test('prints both sections from the config and the stats file, and changes nothing', async () => {
    const agentDir = await openAiAgentDir()
    writeFileSync(join(agentDir.path, 'proxy-config.json'), JSON.stringify({ host: '0.0.0.0' }))
    recordUncachedTraffic()
    const before = snapshot(agentDir.path)

    const { status, text } = await doctor(false)

    expect(status).toBe(0)
    expect(text).toMatch(/^General\n {2}WARNING {2}proxy-auth \[0\.0\.0\.0\]: /m)
    expect(text).toMatch(/^Cache\n/m)
    expect(text).toContain('hit-rate [alpha/one]: 0.0% of the prompt')
    expect(text).toContain('prompt-cache-key [alpha/one]: 100.0% of 30 requests')
    expect(text).toMatch(/Limits:\n {2}- The doctor can say/)
    expect(text).toMatch(/Exit status 0\.\n$/)
    expect(snapshot(agentDir.path)).toEqual(before)
  })

  // Catches --json printing anything but the documented report, or the stats marked unavailable
  // when they were read.
  test('prints the report as JSON', async () => {
    await openAiAgentDir()
    recordUncachedTraffic()

    const { text } = await doctor(true)
    const report: unknown = JSON.parse(text)

    expect(report).toEqual({
      general: expect.any(Array),
      cache: expect.arrayContaining([
        expect.objectContaining({ check: 'hit-rate', severity: 'warning', subject: 'alpha/one' }),
        expect.objectContaining({ check: 'prompt-cache-key', subject: 'alpha/one' })
      ]),
      window: 'week',
      statsAvailable: true,
      limits: expect.any(Array)
    })
  })

  // Catches a proxy that can serve nothing passing the doctor: no model exposed is the error
  // /healthz/models answers 503 for, so the exit status is 1; a missing stats file is said, not
  // shown as an empty section.
  test('exits 1 when no model is exposed, and says there is no stats file', async () => {
    const agentDir = await loadFixtureAgentDir()
    agentDirs.push(agentDir)

    const { status, text } = await doctor(true)

    expect(status).toBe(1)
    expect(JSON.parse(text)).toMatchObject({
      general: expect.arrayContaining([
        expect.objectContaining({ check: 'exposure', severity: 'error' })
      ]),
      cache: [
        expect.objectContaining({ check: 'stats', message: expect.stringMatching(/no stats file/) })
      ],
      statsAvailable: false
    })
  })

  // Catches the doctor migrating a stats file from before #299 (it writes nothing), or showing it
  // as empty instead of saying why it can't be read.
  test('reports a version 1 stats file as unreadable, untouched', async () => {
    const agentDir = await openAiAgentDir()
    const v1 = new DatabaseSync(statsFilePath())
    v1.exec('PRAGMA user_version = 1')
    v1.close()
    const before = snapshot(agentDir.path)

    const { text } = await doctor(true)

    expect(JSON.parse(text)).toMatchObject({
      cache: [
        expect.objectContaining({
          check: 'stats',
          severity: 'warning',
          message: expect.stringMatching(/older than this.*start the proxy once/)
        })
      ],
      statsAvailable: false
    })
    expect(snapshot(agentDir.path)).toEqual(before)
  })

  // Catches a typo'd flag or window being ignored (the doctor would quietly check something else)
  // or refused with 1, which means "found an error": a usage error is 2, and quotes no value.
  test.each([
    { given: 'an unknown flag', rawArgs: ['--verfy'], says: 'unknown flag --verfy' },
    { given: 'an argument', rawArgs: ['notarealsecret-token'], says: 'takes no arguments' },
    { given: 'an unknown window', rawArgs: ['--window', 'month'], says: '--window must be one of' }
  ])('refuses $given with exit status 2', async ({ rawArgs, says }) => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    await runMain(doctorCommand, { rawArgs })

    expect(process.exitCode).toBe(2)
    const written = stderr.mock.calls.map(([chunk]) => String(chunk)).join('')
    expect(written).toContain(says)
    expect(written).not.toContain('notarealsecret')
  })
})
