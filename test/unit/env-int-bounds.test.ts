/**
 * The integer env vars (`PI_SWITCHBOARD_PORT`, `PI_SWITCHBOARD_MAX_BODY_SIZE`,
 * `PI_SWITCHBOARD_UPSTREAM_TIMEOUT_MS`) are held to the config file's bounds for the same
 * setting, in the env var's unit, and an invalid one is ignored with a warning naming the bounds
 * (CONSTITUTION principle II), never clamped and never read leniently (`80abc` is not 80).
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resetSync } from '@logtape/logtape'
import { loadConfig } from '@proxy/config/env'
import { BYTES_PER_MB } from '@proxy/config/schema'
import { configureLogging } from '@proxy/logging'
import { MS_PER_SECOND } from '@proxy/utils/time'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

import { writeProxyConfig } from '../fixtures/agent-dir'

const FILE_PORT = 4242
const FILE_BODY_MB = 7
const FILE_TIMEOUT_SEC = 30
const MAX_PORT = 65_535
const MAX_BODY_MB = 500
const MIN_TIMEOUT_SEC = 5
const MAX_TIMEOUT_SEC = 600

let agentDir = ''
let lines: string[] = []

/**
 * Reads the messages of the warnings logged so far.
 *
 * @returns each JSON log line's `message`, in order
 */
function warnings(): unknown[] {
  return lines.map((line) => {
    const record: unknown = JSON.parse(line)
    return typeof record === 'object' && record !== null && 'message' in record
      ? record.message
      : undefined
  })
}

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), 'pi-proxy-env-int-'))
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDir)
  writeProxyConfig(agentDir, {
    port: FILE_PORT,
    maxBodySizeMb: FILE_BODY_MB,
    upstreamTimeoutSec: FILE_TIMEOUT_SEC
  })
  lines = []
  configureLogging({ level: 'warning', format: 'json', write: (line) => lines.push(line) })
})

afterEach(() => {
  vi.unstubAllEnvs()
  resetSync()
  rmSync(agentDir, { recursive: true, force: true })
})

describe('PI_SWITCHBOARD_PORT', () => {
  // Catches the env var escaping the port range the config file is held to (#C1 of the review):
  // 70000 was accepted and failed only at listen.
  test('above the highest port: ignored with a warning naming the range', () => {
    vi.stubEnv('PI_SWITCHBOARD_PORT', '70000')

    expect(loadConfig().port).toBe(FILE_PORT)
    expect(warnings()).toEqual([
      `Ignoring "PI_SWITCHBOARD_PORT"="70000": not an integer from 1 to ${String(MAX_PORT)}; using ${String(FILE_PORT)}`
    ])
  })

  // Catches `Number.parseInt` leniency: `80abc` was read as port 80.
  test('digits followed by letters: ignored, not read as the leading number', () => {
    vi.stubEnv('PI_SWITCHBOARD_PORT', '80abc')

    expect(loadConfig().port).toBe(FILE_PORT)
    expect(warnings()).toHaveLength(1)
  })

  // Catches the bounds check refusing a valid port, or the warning firing on one.
  test('a port within the range is used, with no warning', () => {
    vi.stubEnv('PI_SWITCHBOARD_PORT', ' 8080 ')

    expect(loadConfig().port).toBe(8080)
    expect(warnings()).toEqual([])
  })
})

describe('PI_SWITCHBOARD_MAX_BODY_SIZE', () => {
  // Catches the byte-valued env var escaping the MB bounds of `maxBodySizeMb`: any positive byte
  // count passed before, so a 1-byte limit refused every request.
  test('below one MB: ignored with a warning naming the bounds in bytes', () => {
    vi.stubEnv('PI_SWITCHBOARD_MAX_BODY_SIZE', '1')

    expect(loadConfig().maxBodySize).toBe(FILE_BODY_MB * BYTES_PER_MB)
    expect(warnings()).toEqual([
      `Ignoring "PI_SWITCHBOARD_MAX_BODY_SIZE"="1": not an integer from ${String(BYTES_PER_MB)} to ${String(MAX_BODY_MB * BYTES_PER_MB)}; using ${String(FILE_BODY_MB * BYTES_PER_MB)}`
    ])
  })

  // Catches the scaled bounds being off by the unit: exactly the file's limits, in bytes.
  test('the bounds in bytes are used as given', () => {
    vi.stubEnv('PI_SWITCHBOARD_MAX_BODY_SIZE', String(MAX_BODY_MB * BYTES_PER_MB))

    expect(loadConfig().maxBodySize).toBe(MAX_BODY_MB * BYTES_PER_MB)
    expect(warnings()).toEqual([])
  })
})

describe('PI_SWITCHBOARD_UPSTREAM_TIMEOUT_MS', () => {
  // Catches the millisecond env var escaping the 5–600 s bounds of `upstreamTimeoutSec`: a 1 ms
  // wait aborted every call.
  test('below five seconds: ignored with a warning naming the bounds in milliseconds', () => {
    vi.stubEnv('PI_SWITCHBOARD_UPSTREAM_TIMEOUT_MS', '4999')

    expect(loadConfig().upstreamTimeoutMs).toBe(FILE_TIMEOUT_SEC * MS_PER_SECOND)
    expect(warnings()).toEqual([
      `Ignoring "PI_SWITCHBOARD_UPSTREAM_TIMEOUT_MS"="4999": not an integer from ${String(MIN_TIMEOUT_SEC * MS_PER_SECOND)} to ${String(MAX_TIMEOUT_SEC * MS_PER_SECOND)}; using ${String(FILE_TIMEOUT_SEC * MS_PER_SECOND)}`
    ])
  })

  // Catches the lower bound being exclusive, or the unit being wrong by a factor.
  test('exactly five seconds is used', () => {
    vi.stubEnv('PI_SWITCHBOARD_UPSTREAM_TIMEOUT_MS', String(MIN_TIMEOUT_SEC * MS_PER_SECOND))

    expect(loadConfig().upstreamTimeoutMs).toBe(MIN_TIMEOUT_SEC * MS_PER_SECOND)
    expect(warnings()).toEqual([])
  })
})

describe('PI_SWITCHBOARD_AGENTIC', () => {
  // Catches the one boolean env var read without the shared parser: `TRUE` was silently false.
  test('a value other than true or false is warned about and read as false', () => {
    vi.stubEnv('PI_SWITCHBOARD_AGENTIC', 'TRUE')

    expect(loadConfig().agenticEnabled).toBe(false)
    expect(warnings()).toEqual([
      '"PI_SWITCHBOARD_AGENTIC"="TRUE" is not "true" or "false"; treating it as false'
    ])
  })
})
