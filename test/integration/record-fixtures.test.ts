/**
 * `scripts/record-fixtures.ts`, run offline: its recorders forward to the mock provider (standing
 * in for Anthropic, Codex and OpenAI, `PI_SWITCHBOARD_RECORD_UPSTREAM`), its logins are a fixture
 * agent dir with fake API keys and fake ChatGPT tokens, for each base and its second login
 * (`PI_SWITCHBOARD_RECORD_AGENT_DIR`), and its recordings go to a temp dir
 * (`PI_SWITCHBOARD_RECORD_OUT_DIR`) instead of the committed `test/fixtures/recordings`. The
 * script runs `main()` on import, so each test imports it afresh.
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { VERSION } from '@earendil-works/pi-coding-agent'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'
import { FAKE_CODEX_TOKEN } from '../fixtures/codex-token'
import { type MockProvider, type MockReply, startMockProvider } from '../fixtures/mock-provider'
import { ANTHROPIC_QUOTA_HEADERS, CODEX_QUOTA_HEADERS } from '../fixtures/quota-headers'
import { loadRecording, type Recording, replay } from '../fixtures/recording'

const ANTHROPIC = 'anthropic-messages'
const CODEX = 'openai-codex-responses'
/** pi's `openai` provider signed in with ChatGPT, over the Responses API. */
const OPENAI = 'openai-responses'
const MODEL_ID = 'claude-haiku-5-5'
const MISSING_MODEL_ID = 'claude-recorder-no-such-model'
const CODEX_MODEL_ID = 'gpt-5.6-luna'
const ANTHROPIC_SCENARIOS = [
  'text',
  'two-tool-calls',
  'thinking',
  'cache-read',
  'model-not-found',
  'quota'
] as const
/** A second login's scenario, saved next to the base's recordings. */
const SECOND_LOGIN = 'second-login'
/** Every recording a run with no names makes, in order: `<api>/<scenario>`. */
const ALL_RECORDINGS = [
  ...ANTHROPIC_SCENARIOS.map((scenario) => `${ANTHROPIC}/${scenario}`),
  `${ANTHROPIC}/${SECOND_LOGIN}`,
  `${CODEX}/quota`,
  `${CODEX}/${SECOND_LOGIN}`,
  `${OPENAI}/quota`
]
/** The Anthropic requests: one per recording, plus the cache-read repeat. */
const ANTHROPIC_REQUESTS = ANTHROPIC_SCENARIOS.length + 2
const API_KEY = 'notarealsecret-record-fixtures-key'
/** `anthropic-2`'s own key, which its second-login request must carry instead of the base's. */
const SECOND_API_KEY = 'notarealsecret-record-fixtures-key-2'
/** The fake ChatGPT sign-in token of the `openai` login: no `sk-` key, as pi tells them apart. */
const OPENAI_TOKEN = 'notarealsecret-openai-chatgpt-access'
const EXIT_FAILURE = 1
/** How long the fixture's Codex login stays valid: an hour, longer than any test run. */
const CODEX_LOGIN_LIFETIME_MS = 3_600_000
/** The script, as `pnpm run test:live:record` names it to `node`. */
const RECORD_SCRIPT = fileURLToPath(new URL('../../scripts/record-fixtures.ts', import.meta.url))

/** The committed recordings the mock answers with, as Anthropic once did. */
const textAnswer = loadRecording(ANTHROPIC, 'text')
const missingModelAnswer = loadRecording(ANTHROPIC, 'model-not-found')

/**
 * Keeps a header set's quota headers: what a recording of a response that sent `headers` holds.
 *
 * @param headers - every header the response sent
 * @returns the ones the recorder keeps, by name
 */
function quotaOnly(headers: Readonly<Record<string, string>>): Record<string, string> {
  const identifying = /organization|workspace|request-id|cookie|turn-state|credits|fallback|overage/
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !identifying.test(name)))
}

/** Codex's usage-limit body, as its 429 carries it. */
const CODEX_LIMIT_BODY = JSON.stringify({
  error: { type: 'usage_limit_reached', message: 'The usage limit has been reached' }
})

/**
 * Answers as Codex does at a usage limit: 429, the body, and the quota headers a live probe got,
 * identifying ones included, so the recording can be shown to drop them.
 *
 * @param response - the mock's response
 */
const codexAtLimit: MockReply = (response) => {
  response.writeHead(429, { ...CODEX_QUOTA_HEADERS, 'content-type': 'application/json' })
  response.end(CODEX_LIMIT_BODY)
  return undefined
}

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
  // Anthropic's answers carry the quota headers a live probe got, identifying ones included.
  const withQuota = { ...textAnswer.response, headers: ANTHROPIC_QUOTA_HEADERS }
  upstream = await startMockProvider({
    [MODEL_ID]: replay({ ...textAnswer, response: withQuota }),
    [MISSING_MODEL_ID]: replay(missingModelAnswer),
    [CODEX_MODEL_ID]: codexAtLimit
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

/** The logins a fixture agent dir holds: all of them, the bases only, or none. */
type Logins = 'all' | 'bases' | 'none'

/**
 * Creates a fixture agent dir for the script to record with, removed in `afterAll`.
 *
 * @param logins - which logins auth.json holds: a fake Anthropic key, a fake Codex token and a
 *   fake ChatGPT sign-in for `openai` for the bases, and for `all` each second login
 *   (`anthropic-2` with its own key, `openai-codex-2`)
 * @returns the agent dir's path
 */
async function recordingAgentDir(logins: Logins): Promise<string> {
  // pi takes Codex as a ChatGPT login only (OAuth); this one never expires during a test.
  const codex = {
    type: 'oauth',
    access: FAKE_CODEX_TOKEN,
    refresh: 'notarealsecret-codex-refresh',
    expires: Date.now() + CODEX_LOGIN_LIFETIME_MS
  }
  const bases = {
    'anthropic': { type: 'api_key', key: API_KEY },
    'openai-codex': codex,
    // pi 1.4's "Sign in with ChatGPT" on the `openai` provider: OAuth, sent as a bearer token.
    'openai': {
      type: 'oauth',
      access: OPENAI_TOKEN,
      refresh: 'notarealsecret-openai-refresh',
      expires: Date.now() + CODEX_LOGIN_LIFETIME_MS
    }
  }
  const all = {
    ...bases,
    'anthropic-2': { type: 'api_key', key: SECOND_API_KEY },
    'openai-codex-2': codex
  }
  const authJson = { all, bases, none: undefined }[logins]
  const agentDir = await loadFixtureAgentDir(authJson === undefined ? {} : { authJson })
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
 * Stubs stdout, stderr, `process.argv` and `process.exit` (which throws {@link ExitCalled});
 * `afterEach` restores them.
 *
 * @param names - the scenarios named on the command line; none records all of them
 * @returns the exit code (`undefined` when the script did not exit) and the printed text
 * @throws whatever the script throws other than {@link ExitCalled}
 */
async function runScript(names: readonly string[] = []): Promise<ScriptRun> {
  vi.spyOn(process, 'argv', 'get').mockReturnValue([process.execPath, RECORD_SCRIPT, ...names])
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
 * Builds the recording the script should have saved for an Anthropic scenario, with the joined
 * body.
 *
 * @param scenario - the scenario name
 * @returns an expected value with asymmetric matchers for the timestamp, path, headers and body
 */
function expectedAnthropic(scenario: string): unknown {
  const missing = scenario === 'model-not-found'
  const answer = missing ? missingModelAnswer : textAnswer
  const model = missing ? MISSING_MODEL_ID : MODEL_ID
  return withJoinedBody({
    version: 1,
    api: ANTHROPIC,
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
    response: {
      ...answer.response,
      headers: missing ? {} : quotaOnly(ANTHROPIC_QUOTA_HEADERS)
    }
  })
}

describe('recording every scenario', () => {
  let run: ScriptRun
  let requestsBefore = 0

  beforeAll(async () => {
    vi.stubEnv('PI_SWITCHBOARD_RECORD_AGENT_DIR', await recordingAgentDir('all'))
    vi.stubEnv('PI_SWITCHBOARD_RECORD_UPSTREAM', upstream.origin)
    vi.stubEnv('PI_SWITCHBOARD_RECORD_OUT_DIR', saveDir)
    requestsBefore = upstream.requests.length
    run = await runScript()
  })

  // Catches a scenario or a provider dropped from the run, or a run that ends early or reports
  // nothing.
  test('records each scenario of every login and says where it saved it', () => {
    expect({
      exitCode: run.exitCode,
      recorded: run.stdout.match(/^recorded .*\n/gm),
      stderr: run.stderr
    }).toEqual({
      exitCode: undefined,
      recorded: ALL_RECORDINGS.map(
        (recording) => `recorded ${recording} -> ${join(saveDir, `${recording}.json`)}\n`
      ),
      stderr: ''
    })
  })

  // Catches the header probe (#238) dropped, or printing a value: each recording is followed by
  // the response's header names, the quota ones included even where the recording drops some.
  test('prints each response header name, never a value, after each recording', () => {
    const headerLines = run.stdout.match(/^response headers: .*$/gm) ?? []
    expect({
      lines: headerLines.length,
      first: headerLines[0]?.split(': ')[1]?.split(', '),
      values: Object.values(ANTHROPIC_QUOTA_HEADERS).filter((headerValue) =>
        run.stdout.includes(headerValue)
      )
    }).toEqual({
      lines: ALL_RECORDINGS.length,
      first: expect.arrayContaining(['content-type', ...Object.keys(ANTHROPIC_QUOTA_HEADERS)]),
      values: []
    })
  })

  // Catches the cache-read repeat dropped, which records a cache write instead of a cache read,
  // Codex sent over WebSocket (which bypasses the recorder and carries no quota headers), or Codex
  // or the ChatGPT sign-in sent to the wrong path.
  test('sends each scenario once, cache-read twice, Codex over SSE, each to its path', () => {
    expect(
      upstream.requests.slice(requestsBefore).map((request) => request.path.split('?')[0])
    ).toEqual([
      ...Array.from({ length: ANTHROPIC_REQUESTS }, () => '/v1/messages'),
      '/backend-api/codex/responses',
      '/backend-api/codex/responses',
      '/v1/responses'
    ])
  })

  // Catches the second login not registered through the proxy's copy (the run would refuse it or
  // send nothing), sent with the base's key instead of its own, or sent differently from the base.
  test("sends the second login's call as the base's text call, with its own key", () => {
    const sent = upstream.requests.slice(requestsBefore)
    // The base's `text` call is the run's first request; the same call through the second login
    // is the one carrying its key.
    const [baseText] = sent
    const second = sent.filter((request) => request.headers['x-api-key'] === SECOND_API_KEY)
    const shape = (request: (typeof sent)[number] | undefined): unknown =>
      request === undefined
        ? undefined
        : {
            path: request.path,
            headers: Object.keys(request.headers).toSorted(),
            body: request.body
          }
    expect({ count: second.length, shape: shape(second[0]) }).toEqual({
      count: 1,
      shape: shape(baseText)
    })
  })

  // Catches a recording that replay cannot load, or that holds another scenario's exchange, the
  // wrong model, a body other than what the provider sent, or quota headers lost.
  test.each([...ANTHROPIC_SCENARIOS, SECOND_LOGIN])(
    'saves %s as a loadable recording of its own exchange',
    (scenario) => {
      expect(withJoinedBody(loadRecording(ANTHROPIC, scenario, saveDir))).toEqual(
        expectedAnthropic(scenario)
      )
    }
  )

  // Catches Codex's quota headers lost, or its identifying ones (the turn token, a cookie, a
  // request ID) kept: only the window fields and the plan are recorded.
  test.each(['quota', SECOND_LOGIN])(
    'saves the Codex %s call with its quota headers only',
    (scenario) => {
      expect(withJoinedBody(loadRecording(CODEX, scenario, saveDir))).toMatchObject({
        api: CODEX,
        model: CODEX_MODEL_ID,
        request: { path: '/backend-api/codex/responses', body: { model: CODEX_MODEL_ID } },
        response: {
          status: 429,
          headers: quotaOnly(CODEX_QUOTA_HEADERS),
          body: CODEX_LIMIT_BODY
        }
      })
    }
  )

  // Catches the ChatGPT sign-in's call not recorded, recorded under another API or path, or with
  // another model.
  test('saves the ChatGPT sign-in quota call as a loadable recording', () => {
    expect(withJoinedBody(loadRecording(OPENAI, 'quota', saveDir))).toMatchObject({
      api: OPENAI,
      model: CODEX_MODEL_ID,
      request: { path: '/v1/responses', body: { model: CODEX_MODEL_ID } },
      response: { status: 429, headers: quotaOnly(CODEX_QUOTA_HEADERS), body: CODEX_LIMIT_BODY }
    })
  })

  // Catches a login's key, Codex token or ChatGPT account ID, or an identifying response header,
  // reaching a committed fixture.
  test.each(ALL_RECORDINGS)('keeps credentials and identifying headers out of %s', (recording) => {
    const saved = readFileSync(join(saveDir, `${recording}.json`), 'utf8')
    const leaks = [
      API_KEY,
      SECOND_API_KEY,
      FAKE_CODEX_TOKEN,
      OPENAI_TOKEN,
      'notarealsecret-account',
      'x-api-key',
      'anthropic-organization-id',
      'set-cookie',
      'x-codex-turn-state'
    ].filter((leak) => saved.includes(leak))
    expect(leaks).toEqual([])
  })
})

describe('choosing what to record', () => {
  // Catches the names on the command line ignored, which would re-record every fixture (and spend
  // every login's quota) to refresh one.
  test('records only the named scenarios', async () => {
    vi.stubEnv('PI_SWITCHBOARD_RECORD_AGENT_DIR', await recordingAgentDir('all'))
    vi.stubEnv('PI_SWITCHBOARD_RECORD_UPSTREAM', upstream.origin)
    vi.stubEnv('PI_SWITCHBOARD_RECORD_OUT_DIR', tempDir('pi-proxy-record-chosen-'))
    const requestsBefore = upstream.requests.length

    const run = await runScript([`${ANTHROPIC}/quota`, CODEX])

    expect({
      exitCode: run.exitCode,
      recorded: run.stdout.match(/^recorded \S+/gm),
      requests: upstream.requests.length - requestsBefore
    }).toEqual({
      exitCode: undefined,
      recorded: [
        `recorded ${ANTHROPIC}/quota`,
        `recorded ${CODEX}/quota`,
        `recorded ${CODEX}/${SECOND_LOGIN}`
      ],
      requests: 3
    })
  })

  // Catches a mistyped name recording nothing without saying so, or recording everything; and it
  // is refused first, so a typo is named even before the login dir is set.
  test('refuses a name that matches no scenario, before any other check or request', async () => {
    vi.stubEnv('PI_SWITCHBOARD_RECORD_UPSTREAM', upstream.origin)
    const requestsBefore = upstream.requests.length

    const run = await runScript([`${CODEX}/no-such-scenario`])

    expect({
      exitCode: run.exitCode,
      refusal: run.stderr.startsWith(`No scenario ${CODEX}/no-such-scenario; one of: `),
      requests: upstream.requests.length - requestsBefore
    }).toEqual({ exitCode: EXIT_FAILURE, refusal: true, requests: 0 })
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
    const agentDir = await recordingAgentDir('none')
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

  // Catches a second login missing from the agent dir recorded through the base's credential.
  test('with no login for a second-login scenario', async () => {
    const agentDir = await recordingAgentDir('bases')
    vi.stubEnv('PI_SWITCHBOARD_RECORD_AGENT_DIR', agentDir)
    vi.stubEnv('PI_SWITCHBOARD_RECORD_UPSTREAM', upstream.origin)
    const requestsBefore = upstream.requests.length

    const run = await runScript([`${ANTHROPIC}/${SECOND_LOGIN}`])

    expect({ ...run, requests: upstream.requests.length - requestsBefore }).toEqual({
      exitCode: EXIT_FAILURE,
      stdout: '',
      stderr: `No Anthropic 2 login in ${agentDir}\n`,
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
