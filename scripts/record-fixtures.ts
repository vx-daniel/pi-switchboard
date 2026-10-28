/**
 * Records real provider traffic as replay fixtures (`test/fixtures/recordings/<api>`): Anthropic
 * (`anthropic-messages`), ChatGPT's Codex (`openai-codex-responses`), a second login of each
 * (`<api>/second-login`, #233), and pi 1.4's ChatGPT sign-in on OpenAI (`openai-responses`, #238).
 * On demand only: `pnpm run test:live:record [<api>/<scenario> | <api> ...]` records the named
 * scenarios, or all of them. It spends a few cents of quota on the logins used.
 *
 * pi's own clients send each scenario through a pass-through recorder (`test/fixtures/recording.ts`)
 * on 127.0.0.1, one per provider: pi's `models.json` points each provider at its recorder, so the
 * request is exactly what pi sends in production (the Claude Code OAuth headers and system prompt
 * included), and the response is saved as it arrived, with only its quota headers (#69) and minus
 * every credential. A recording that still contains one is refused, not redacted. For each
 * recording, the response's header names (never their values) are printed, to show what a
 * provider sends whatever the recording keeps (#238).
 *
 * SECOND LOGINS: `anthropic-2` and `openai-codex-2` are registered as the proxy registers them, a
 * copy of a fresh built-in provider made by the proxy's own `accountProvider`
 * (`src/pi/account-provider.ts`), with the recorder's `models.json` entry under the slot's ID
 * composed above it. A recording through one therefore proves that copy against the real service:
 * same request as the base, sent with the slot's own credential. They are saved next to the base's
 * recordings, as the `second-login` scenario.
 *
 * LOGIN: set PI_SWITCHBOARD_RECORD_AGENT_DIR to a pi agent dir holding the logins made for
 * recording (`PI_CODING_AGENT_DIR=<dir> pi`, then `/login` for each provider; log in a second
 * time, in a private browser window, for `anthropic-2` and `openai-codex-2`). pi reads and
 * refreshes its `auth.json` in place. Never point it at a copy of a login another pi or proxy
 * uses: refreshing an expired OAuth token rotates the refresh token, and every other copy stops
 * working.
 *
 * Runs under Node directly (`node scripts/record-fixtures.ts`), so imports are relative with `.ts`.
 *
 * OUTPUT: recordings go to `test/fixtures/recordings`, to be committed; set
 * PI_SWITCHBOARD_RECORD_OUT_DIR to save them somewhere else (the offline test of this script does).
 * PI_SWITCHBOARD_RECORD_UPSTREAM sends every provider's traffic to one origin instead (the same
 * test's mock).
 *
 * @packageDocumentation
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  type Api,
  type Context,
  type Model,
  type Provider,
  type SimpleStreamOptions,
  Type
} from '@earendil-works/pi-ai'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import { ModelRuntime, VERSION } from '@earendil-works/pi-coding-agent'

import { accountProvider, parseAccountProviderId } from '../src/pi/account-provider.ts'
import { type Recorder, saveRecording, startRecorder } from '../test/fixtures/recording.ts'

/** One recorded exchange: what pi is asked, and with which options. */
interface Scenario {
  readonly name: string
  readonly modelId?: string
  readonly context: Context
  readonly options: SimpleStreamOptions
  /** Send the same request this many times and record the last (for cache reads). */
  readonly repeat?: number
}

/**
 * Builds a user message stamped with the current time.
 *
 * @param text - the message content
 * @returns a pi user message
 */
function userMessage(text: string): Context['messages'][number] {
  return { role: 'user', content: text, timestamp: Date.now() }
}

/** A system prompt above Anthropic's minimum cacheable length, so a repeat reads the cache. */
const LONG_SYSTEM_PROMPT = Array.from(
  { length: 700 },
  (_, lineIndex) =>
    `Reference line ${String(lineIndex)}: the recorder pads this prompt so the provider caches it.`
).join('\n')

/** Two tools for the `two-tool-calls` scenario. */
const WEATHER_TOOLS: Context['tools'] = [
  {
    name: 'get_weather',
    description: 'Current weather for a city',
    parameters: Type.Object({ city: Type.String() })
  },
  {
    name: 'get_time',
    description: 'Current time in a time zone',
    parameters: Type.Object({ zone: Type.String() })
  }
]

/** The quota scenario: the shortest call, for the quota headers its response carries (#69). */
const QUOTA_SCENARIO: Scenario = {
  name: 'quota',
  context: { messages: [userMessage('Reply with exactly: ok.')] },
  options: { maxTokens: 32 }
}

/** The short text call, also recorded through a second login. */
const TEXT_SCENARIO: Scenario = {
  name: 'text',
  context: { messages: [userMessage('Reply with exactly: Hello from the recorder.')] },
  options: { maxTokens: 64 }
}

/** A second login's scenario name: saved next to the base's recordings, never over them. */
const SECOND_LOGIN = 'second-login'

/** The Anthropic scenarios, in order; each name becomes a fixture file name. */
const ANTHROPIC_SCENARIOS: readonly Scenario[] = [
  TEXT_SCENARIO,
  {
    name: 'two-tool-calls',
    context: {
      messages: [
        userMessage('Call get_weather for Oslo and get_time for CET, both now, in one reply.')
      ],
      tools: WEATHER_TOOLS
    },
    options: { maxTokens: 512 }
  },
  {
    // Adaptive thinking: the model decides whether to think, and skips it for easy arithmetic
    // (17 × 23 recorded no thinking block). This needs a few steps it cannot do at a glance.
    name: 'thinking',
    context: {
      messages: [
        userMessage(
          'How many integers from 1 to 2000 are divisible by 6 or 10 but not by 15? ' +
            'Work it out carefully, then answer with the number only.'
        )
      ]
    },
    options: { maxTokens: 8192, reasoning: 'high' }
  },
  {
    name: 'cache-read',
    context: {
      systemPrompt: LONG_SYSTEM_PROMPT,
      messages: [userMessage('Reply with exactly: cached.')]
    },
    options: { maxTokens: 32 },
    repeat: 2
  },
  {
    name: 'model-not-found',
    modelId: 'claude-recorder-no-such-model',
    context: { messages: [userMessage('Hello')] },
    options: { maxTokens: 16 }
  },
  QUOTA_SCENARIO
]

/** A provider the recorder records, with its scenarios. */
interface Target {
  /** pi's provider ID; a login slot (`anthropic-2`) is registered as the proxy registers it. */
  readonly provider: string
  /** How refusals name it. */
  readonly label: string
  /** The pi API its recordings are made through and labelled with (the fixture folder). */
  readonly api: string
  /** The pi model each scenario starts from (a scenario may override only its id). */
  readonly modelId: string
  /** The real provider's origin, the recorder's upstream. */
  readonly upstream: string
  /** The path the provider's base URL adds to its origin. */
  readonly basePath: string
  /** Options every scenario of the provider is sent with. */
  readonly options: SimpleStreamOptions
  readonly scenarios: readonly Scenario[]
}

/** Anthropic, as the base and its second login record it. */
const ANTHROPIC_TARGET = {
  label: 'Anthropic',
  api: 'anthropic-messages',
  modelId: 'claude-haiku-5-5',
  upstream: 'https://api.anthropic.com',
  basePath: '',
  options: {}
} as const

/**
 * Codex, as the base and its second login record it: over SSE, as the proxy calls Codex (#185).
 * pi's default WebSocket would bypass the recorder, and only SSE responses carry the quota headers.
 */
const CODEX_TARGET = {
  label: 'ChatGPT (Codex)',
  api: 'openai-codex-responses',
  modelId: 'gpt-5.6-luna',
  upstream: 'https://chatgpt.com',
  basePath: '/backend-api',
  options: { transport: 'sse' }
} as const

/** The providers recorded, in order. */
const TARGETS: readonly Target[] = [
  { ...ANTHROPIC_TARGET, provider: 'anthropic', scenarios: ANTHROPIC_SCENARIOS },
  {
    ...ANTHROPIC_TARGET,
    provider: 'anthropic-2',
    label: 'Anthropic 2',
    scenarios: [{ ...TEXT_SCENARIO, name: SECOND_LOGIN }]
  },
  { ...CODEX_TARGET, provider: 'openai-codex', scenarios: [QUOTA_SCENARIO] },
  {
    ...CODEX_TARGET,
    provider: 'openai-codex-2',
    label: 'ChatGPT (Codex) 2',
    scenarios: [{ ...QUOTA_SCENARIO, name: SECOND_LOGIN }]
  },
  {
    // pi 1.4's own route to a ChatGPT subscription ("Sign in with ChatGPT" on the `openai`
    // provider): the Responses API at api.openai.com, where `openai-codex` is pi's legacy route to
    // ChatGPT's Codex backend. Recorded for the headers it carries (#238).
    provider: 'openai',
    label: 'OpenAI (ChatGPT sign-in)',
    api: 'openai-responses',
    // A model a ChatGPT plan serves: `gpt-5.4-mini`, `gpt-5.5` and `gpt-5.3-codex` were refused
    // ("not supported when using Codex with a ChatGPT account").
    modelId: 'gpt-5.6-luna',
    upstream: 'https://api.openai.com',
    basePath: '/v1',
    options: {},
    scenarios: [QUOTA_SCENARIO]
  }
]

/** Where the arguments start in `process.argv`, after node and the script. */
const FIRST_ARGUMENT = 2

/**
 * Prints a message to stderr and exits with status 1.
 *
 * @param message - the error to print
 */
function fail(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

/**
 * Resolves the agent dir holding the recording login from PI_SWITCHBOARD_RECORD_AGENT_DIR.
 *
 * @remarks
 * Exits via {@link fail} when the variable is unset or empty, or when it names the everyday
 * `~/.pi/agent` dir, so recording never refreshes a login another pi or proxy uses.
 *
 * @returns the absolute agent dir path
 */
function recordingAgentDir(): string {
  const configured = process.env.PI_SWITCHBOARD_RECORD_AGENT_DIR
  if (configured === undefined || configured === '') {
    fail(
      'Set PI_SWITCHBOARD_RECORD_AGENT_DIR to a pi agent dir with a login made for recording ' +
        '(PI_CODING_AGENT_DIR=<dir> pi, then /login). See the header of scripts/record-fixtures.ts.'
    )
  }
  const agentDir = resolve(configured)
  if (agentDir === join(homedir(), '.pi', 'agent')) {
    fail(
      'PI_SWITCHBOARD_RECORD_AGENT_DIR is your everyday pi agent dir. Record with a separate login, so a ' +
        'refresh during recording cannot disturb the one you use.'
    )
  }
  return agentDir
}

/**
 * Sends one scenario through pi (repeating it when `scenario.repeat` is set) and saves the last
 * exchange the recorder saw.
 *
 * @remarks
 * Exits via {@link fail} when pi lacks the base model or the recorder saw no request.
 *
 * @param runtime - the pi model runtime pointed at the recorders
 * @param recording - the provider's recorder, the provider, and the scenario to record
 * @param recording.recorder - the provider's pass-through recorder
 * @param recording.target - the provider the scenario is sent to
 * @param recording.scenario - the exchange to record
 * @returns the path of the saved recording, and every response header's name (never a value)
 * @throws Error from `saveRecording` when the recording still contains a credential
 */
async function recordScenario(
  runtime: ModelRuntime,
  recording: { recorder: Recorder; target: Target; scenario: Scenario }
): Promise<{ path: string; headerNames: readonly string[] }> {
  const { recorder, target, scenario } = recording
  const base = runtime.getModel(target.provider, target.modelId)
  if (base === undefined) fail(`pi has no ${target.provider}/${target.modelId}`)
  const model: Model<Api> =
    scenario.modelId === undefined ? base : { ...base, id: scenario.modelId }
  const options = { ...target.options, ...scenario.options }
  for (let attempt = 1; attempt <= (scenario.repeat ?? 1); attempt++) {
    // Sequential on purpose: a repeat must follow the request whose cache it reads.
    await runtime.streamSimple(model, scenario.context, options).result()
  }
  const captured = recorder.exchanges.at(-1)
  if (captured === undefined) fail(`${target.api}/${scenario.name}: the recorder saw no request`)
  const outDir = process.env.PI_SWITCHBOARD_RECORD_OUT_DIR
  const path = saveRecording(
    {
      version: 1,
      api: target.api,
      scenario: scenario.name,
      model: model.id,
      recordedAt: new Date().toISOString(),
      piVersion: VERSION,
      ...captured.exchange
    },
    captured.secrets,
    // `undefined` takes saveRecording's default, the committed fixtures; so does an empty value.
    outDir === '' ? undefined : outDir
  )
  return { path, headerNames: captured.responseHeaderNames }
}

/**
 * Picks the scenarios to record from the command line: `<api>/<scenario>` or a whole `<api>`
 * (`pnpm run test:live:record anthropic-messages/quota openai-codex-responses`); all of them when
 * none is named.
 *
 * @remarks
 * Exits via {@link fail} when a name matches no scenario.
 *
 * @param names - the command-line arguments
 * @returns each target with the scenarios chosen from it; targets with none are left out
 */
function chosenTargets(names: readonly string[]): { target: Target; scenarios: Scenario[] }[] {
  const chosen = (target: Target, scenario: Scenario): boolean =>
    names.length === 0 ||
    names.includes(target.api) ||
    names.includes(`${target.api}/${scenario.name}`)
  const known = new Set(
    TARGETS.flatMap((target) => [
      target.api,
      ...target.scenarios.map((scenario) => `${target.api}/${scenario.name}`)
    ])
  )
  const unknown = names.find((scenarioName) => !known.has(scenarioName))
  if (unknown !== undefined) fail(`No scenario ${unknown}; one of: ${[...known].join(', ')}`)
  return TARGETS.map((target) => ({
    target,
    scenarios: target.scenarios.filter((scenario) => chosen(target, scenario))
  })).filter((choice) => choice.scenarios.length > 0)
}

/**
 * Copies the built-in provider a login slot belongs to, as the proxy does: from a fresh
 * `builtinProviders()` instance, by the proxy's own `accountProvider`.
 *
 * @param providerId - a target's provider ID
 * @returns the slot's provider, or `undefined` for a provider that is no login slot
 */
function loginCopy(providerId: string): Provider | undefined {
  const slot = parseAccountProviderId(providerId)
  if (slot === undefined) return undefined
  const fresh = builtinProviders().find((provider) => provider.id === slot.base)
  if (fresh === undefined) fail(`${providerId} is no login slot of a built-in pi provider`)
  return accountProvider(fresh, { providerId, number: slot.number })
}

/**
 * Records the chosen scenarios against the login in PI_SWITCHBOARD_RECORD_AGENT_DIR.
 *
 * @remarks
 * Starts one recorder per provider (upstream: PI_SWITCHBOARD_RECORD_UPSTREAM when set, for the
 * offline test, else the provider's own), writes a temporary `models.json` that points each
 * provider at its recorder, and removes that file and stops the recorders when done. Exits via
 * {@link fail} when the dir has no login for a chosen provider. A login slot is registered first,
 * as the proxy registers it.
 */
async function main(): Promise<void> {
  // Names first: a mistyped one is refused before anything else is checked or started.
  const chosen = chosenTargets(process.argv.slice(FIRST_ARGUMENT))
  const agentDir = recordingAgentDir()
  const upstreamOverride = process.env.PI_SWITCHBOARD_RECORD_UPSTREAM
  const recorders = await Promise.all(
    chosen.map(async ({ target }) => startRecorder(upstreamOverride ?? target.upstream))
  )
  const modelsDir = mkdtempSync(join(tmpdir(), 'pi-proxy-record-'))
  try {
    const modelsPath = join(modelsDir, 'models.json')
    const providers = Object.fromEntries(
      chosen.map(({ target }, targetIndex) => [
        target.provider,
        { baseUrl: `${recorders[targetIndex]?.baseUrl ?? ''}${target.basePath}` }
      ])
    )
    writeFileSync(modelsPath, JSON.stringify({ providers }))
    process.env.PI_CODING_AGENT_DIR = agentDir
    // The login stays where it is (refreshed in place); only models.json is the recorder's.
    const runtime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath })
    for (const { target } of chosen) {
      const copy = loginCopy(target.provider)
      // As the proxy registers a slot (`registerAccountProvider`): the recorder's models.json
      // entry under the slot's ID composes above the copy.
      if (copy !== undefined) runtime.registerNativeProvider(copy)
    }
    for (const { target } of chosen) {
      if (!runtime.isUsingOAuth(target.provider) && !runtime.hasConfiguredAuth(target.provider)) {
        fail(`No ${target.label} login in ${agentDir}`)
      }
    }
    for (const [targetIndex, { target, scenarios }] of chosen.entries()) {
      const recorder = recorders[targetIndex]
      if (recorder === undefined) continue
      for (const scenario of scenarios) {
        // Sequential on purpose: each recording is its recorder's latest exchange.
        const { path, headerNames } = await recordScenario(runtime, { recorder, target, scenario })
        process.stdout.write(`recorded ${target.api}/${scenario.name} -> ${path}\n`)
        process.stdout.write(`response headers: ${headerNames.join(', ')}\n`)
      }
    }
  } finally {
    await Promise.all(recorders.map(async (recorder) => recorder.close()))
    rmSync(modelsDir, { recursive: true, force: true })
  }
}

await main()
