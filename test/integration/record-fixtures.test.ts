/**
 * `scripts/record-fixtures.ts`, run offline: its recorder forwards to the mock provider (standing
 * in for Anthropic, `PI_SWITCHBOARD_RECORD_UPSTREAM`), its login is a fixture agent dir with a fake API
 * key (`PI_SWITCHBOARD_RECORD_AGENT_DIR`), and its recordings go to a temp dir
 * (`PI_SWITCHBOARD_RECORD_OUT_DIR`) instead of the committed `test/fixtures/recordings`. The script runs
 * `main()` on import, so each test imports it afresh.
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { VERSION } from '@earendil-works/pi-coding-agent'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'
import { type MockProvider, startMockProvider } from '../fixtures/mock-provider'
import { loadRecording, type Recording, replay } from '../fixtures/recording'

const API = 'anthropic-messages'
const MODEL_ID = 'claude-haiku-5-5'
const MISSING_MODEL_ID = 'claude-recorder-no-such-model'
const SCENARIOS = ['text', 'two-tool-calls', 'thinking', 'cache-read', 'model-not-found'] as const
/** One request per scenario, plus the cache-read repeat. */
const REQUESTS_SENT = SCENARIOS.length + 1
const API_KEY = 'notarealsecret-record-fixtures-key'
const EXIT_FAILURE = 1
/** The script, as `pnpm run test:live:record` names it to `node`. */
const RECORD_SCRIPT = fileURLToPath(new URL('../../scripts/record-fixtures.ts', import.meta.url))

/** The committed recordings the mock answers with, as Anthropic once did. */
const textAnswer = loadRecording(API, 'text')
const missingModelAnswer = loadRecording(API, 'model-not-found')

/** Thrown by the stubbed `process.exit`, so a refusal ends the import instead of the test run. */
class ExitCalled extends Error {
  constructor(readonly code: number | string | null | undefined) {
    super(`process.exit(${String(code)})`)
  }
}

let upstream: MockProvider
/** Where the script saves recordings in these tests (PI_SWITCHBOARD_RECORD_OUT_DIR), never the fixtures. */
let saveDir = ''
const tempDirs: string[] = []
const agentDirs: FixtureAgentDir[] = []

/**
 * Creates a temp dir that `afterAll` removes.
 *
 * @param prefix - the dir name's prefix under the OS temp dir
 * @returns the new dir's path
 */
function tempDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(path)
  return path
}

beforeAll(async () => {
  upstream = await startMockProvider({
    [MODEL_ID]: replay(textAnswer),
    [MISSING_MODEL_ID]: replay(missingModelAnswer)
  })
  saveDir = tempDir('pi-proxy-record-fixtures-')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

afterAll(async () => {
  await upstream.close()
  for (const agentDir of agentDirs) agentDir.remove()
  for (const path of tempDirs) rmSync(path, { recursive: true, force: true })
})

/**
 * Creates a fixture agent dir for the script to record with, removed in `afterAll`.
 *
 * @param loggedIn - whether auth.json holds a fake Anthropic API key
 * @returns the agent dir's path
 */
async function recordingAgentDir(loggedIn: boolean): Promise<string> {
  const agentDir = await loadFixtureAgentDir(
    loggedIn ? { authJson: { anthropic: { type: 'api_key', key: API_KEY } } } : {}
  )
  agentDirs.push(agentDir)
  return agentDir.path
}

interface ScriptRun {
  readonly exitCode: number | string | null | undefined
  readonly stdout: string
  readonly stderr: string
}

/**
 * Runs the script once, as `node scripts/record-fixtures.ts` would, and collects what it printed.
 *
 * @remarks
 * Stubs stdout, stderr and `process.exit` (which throws {@link ExitCalled}); `afterEach`
 * restores them.
 *
 * @returns the exit code (`undefined` when the script did not exit) and the printed text
 * @throws whatever the script throws other than {@link ExitCalled}
 */
async function runScript(): Promise<ScriptRun> {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new ExitCalled(code)
  })
  vi.resetModules()
  let exitCode: ScriptRun['exitCode']
  try {
    // Dynamic on purpose: the script runs `main()` when evaluated, so each run imports it afresh.
    await import('../../scripts/record-fixtures')
  } catch (error) {
    if (!(error instanceof ExitCalled)) throw error
    exitCode = error.code
  }
  const printed = (calls: unknown[][]): string => calls.map(([text]) => String(text)).join('')
  return { exitCode, stdout: printed(stdout.mock.calls), stderr: printed(stderr.mock.calls) }
}

/**
 * Joins a recording's response chunks into one body string.
 *
 * @remarks
 * Chunk boundaries depend on how TCP split the stream, so tests compare the joined body.
 *
 * @param recording - the recording to normalise
 * @returns the recording with `response.chunks` replaced by `response.body`
 */
function withJoinedBody(recording: Recording): unknown {
  const { chunks, ...response } = recording.response
  return { ...recording, response: { ...response, body: chunks.join('') } }
}

/**
 * Builds the recording the script should have saved for `scenario`, with the joined body.
 *
 * @param scenario - the scenario name
 * @returns an expected value with asymmetric matchers for the timestamp, path, headers and body
 */
function expectedRecording(scenario: (typeof SCENARIOS)[number]): unknown {
  const answer = scenario === 'model-not-found' ? missingModelAnswer : textAnswer
  const model = scenario === 'model-not-found' ? MISSING_MODEL_ID : MODEL_ID
  return withJoinedBody({
    version: 1,
    api: API,
    scenario,
    model,
    recordedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/) as string,
    piVersion: VERSION,
    request: {
      path: expect.stringMatching(/^\/v1\/messages(?:\?|$)/) as string,
      headers: expect.objectContaining({
        'anthropic-version': expect.any(String) as string,
        'content-type': 'application/json'
      }) as Record<string, string>,
      body: expect.objectContaining({ model, stream: true }) as unknown
    },
    response: answer.response
  })
}

describe('recording every scenario', () => {
  let run: ScriptRun

  beforeAll(async () => {
    vi.stubEnv('PI_SWITCHBOARD_RECORD_AGENT_DIR', await recordingAgentDir(true))
    vi.stubEnv('PI_SWITCHBOARD_RECORD_UPSTREAM', upstream.origin)
    vi.stubEnv('PI_SWITCHBOARD_RECORD_OUT_DIR', saveDir)
    run = await runScript()
  })

  // Catches a scenario dropped from the run, or a run that ends early or reports nothing.
  test('records each scenario and says where it saved it', () => {
    expect({ exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr }).toEqual({
      exitCode: undefined,
      stdout: SCENARIOS.map(
        (scenario) => `recorded ${scenario} -> ${join(saveDir, API, `${scenario}.json`)}\n`
      ).join(''),
      stderr: ''
    })
  })

  // Catches the cache-read repeat dropped, which records a cache write instead of a cache read.
  test('sends each scenario to the provider once, and cache-read twice', () => {
    expect(upstream.requests.map((request) => request.headers['x-api-key'])).toEqual(
      Array.from({ length: REQUESTS_SENT }, () => API_KEY)
    )
  })

  // Catches a recording that replay cannot load, or that holds another scenario's exchange, the
  // wrong model, or a body other than what the provider sent.
  test.each(SCENARIOS)('saves %s as a loadable recording of its own exchange', (scenario) => {
    expect(withJoinedBody(loadRecording(API, scenario, saveDir))).toEqual(
      expectedRecording(scenario)
    )
  })

  // Catches the login's API key reaching a committed fixture.
  test.each(SCENARIOS)('keeps the credential out of %s', (scenario) => {
    const saved = readFileSync(join(saveDir, API, `${scenario}.json`), 'utf8')
    expect({ hasKey: saved.includes(API_KEY), hasKeyHeader: saved.includes('x-api-key') }).toEqual({
      hasKey: false,
      hasKeyHeader: false
    })
  })
})

describe('refusing to record', () => {
  // Catches a run without a dedicated login falling back to the developer's everyday pi login.
  test.each(['', undefined])('without PI_SWITCHBOARD_RECORD_AGENT_DIR (%j)', async (configured) => {
    vi.stubEnv('PI_SWITCHBOARD_RECORD_AGENT_DIR', configured)
    vi.stubEnv('PI_SWITCHBOARD_RECORD_UPSTREAM', upstream.origin)
    const requestsBefore = upstream.requests.length

    const run = await runScript()

    expect({ ...run, requests: upstream.requests.length - requestsBefore }).toEqual({
      exitCode: EXIT_FAILURE,
      stdout: '',
      stderr:
        'Set PI_SWITCHBOARD_RECORD_AGENT_DIR to a pi agent dir with a login made for recording ' +
        '(PI_CODING_AGENT_DIR=<dir> pi, then /login). See the header of scripts/record-fixtures.ts.\n',
      requests: 0
    })
  })

  // Catches recording with the everyday login, whose token a refresh would rotate under pi.
  test('with the everyday pi agent dir', async () => {
    const home = tempDir('pi-proxy-record-home-')
    vi.stubEnv('HOME', home)
    vi.stubEnv('PI_SWITCHBOARD_RECORD_AGENT_DIR', join(home, '.pi', 'agent'))
    vi.stubEnv('PI_SWITCHBOARD_RECORD_UPSTREAM', upstream.origin)
    const requestsBefore = upstream.requests.length

    const run = await runScript()

    expect({ ...run, requests: upstream.requests.length - requestsBefore }).toEqual({
      exitCode: EXIT_FAILURE,
      stdout: '',
      stderr:
        'PI_SWITCHBOARD_RECORD_AGENT_DIR is your everyday pi agent dir. Record with a separate login, ' +
        'so a refresh during recording cannot disturb the one you use.\n',
      requests: 0
    })
  })

  // Catches a run with no login sending unauthenticated requests and recording the 401s.
  test('with no Anthropic login in the agent dir', async () => {
    const agentDir = await recordingAgentDir(false)
    vi.stubEnv('PI_SWITCHBOARD_RECORD_AGENT_DIR', agentDir)
    vi.stubEnv('PI_SWITCHBOARD_RECORD_UPSTREAM', upstream.origin)
    const requestsBefore = upstream.requests.length

    const run = await runScript()

    expect({ ...run, requests: upstream.requests.length - requestsBefore }).toEqual({
      exitCode: EXIT_FAILURE,
      stdout: '',
      stderr: `No Anthropic login in ${agentDir}\n`,
      requests: 0
    })
  })

  // Catches the script failing to load under plain Node, which is how `pnpm run test:live:record`
  // runs it. Node refuses an extensionless relative import that vitest resolves, so the in-process
  // runs above cannot see it (7b7881c broke recording that way).
  test('under plain Node, as pnpm runs it', () => {
    // The child inherits this worker's environment, so the stub reaches the script: the run stops
    // at its first check, before any recorder or network use.
    vi.stubEnv('PI_SWITCHBOARD_RECORD_AGENT_DIR', '')

    const run = spawnSync(process.execPath, [RECORD_SCRIPT], { encoding: 'utf8' })

    expect({ status: run.status, stdout: run.stdout, stderr: run.stderr }).toEqual({
      status: EXIT_FAILURE,
      stdout: '',
      stderr:
        'Set PI_SWITCHBOARD_RECORD_AGENT_DIR to a pi agent dir with a login made for recording ' +
        '(PI_CODING_AGENT_DIR=<dir> pi, then /login). See the header of scripts/record-fixtures.ts.\n'
    })
  })
})
