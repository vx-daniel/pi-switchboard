/**
 * `pi-switchboard doctor`'s findings (#299): pure functions from what the doctor read (the health
 * reports, the config, the stats and pi's catalog) to findings, each with a recommendation.
 *
 * @remarks
 * Nothing here reads a file, the environment or the clock, so the console's Doctor tab shows the
 * same findings (#325) from inputs it gathers itself. Findings name providers, models, aliases
 * and config fields, never a credential or message content (constitution principle III).
 *
 * The general section repeats what `/healthz/models` and `/healthz/creds` judge, plus config
 * checks; the cache section reads the stats file's tokens and counts against the thresholds below,
 * which `docs/caching.md` explains.
 *
 * @packageDocumentation
 */

import type { FailureClass } from '@proxy/config/schema'
import { MISCONFIGURED_ALIAS } from '@proxy/openai/model-aliases'
import type { CredentialsHealth, ModelsHealth } from '@proxy/server/health'
import { cacheHitRate } from '@proxy/stats/cache'
import type { ModelStats } from '@proxy/stats/store'
import type { StatsWindow } from '@proxy/stats/windows'

/** How much a finding matters: only a general `error` fails the doctor (exit status 1). */
export type Severity = 'error' | 'warning' | 'advice'

/**
 * Every check's name, the general section's then the cache section's: the names a finding can
 * carry, so the console can point each at the view or key that acts on it (#325).
 */
export const DOCTOR_CHECKS = [
  'config-file',
  'proxy-auth',
  'docs-ui',
  'stats',
  'exposure',
  'models-json',
  'enabled-models',
  'alias',
  'login-routing',
  'credentials',
  'logins',
  'fallback-on',
  'hit-rate',
  'cache-write-cost',
  'retention',
  'fallbacks',
  'prompt-cache-key'
] as const

/** A check's name. */
export type DoctorCheck = (typeof DOCTOR_CHECKS)[number]

/** One finding: what was checked, how much it matters, what was found and what to do. */
export interface Finding {
  /** The check's name, stable for scripts: `exposure`, `hit-rate`, … */
  readonly check: DoctorCheck
  readonly severity: Severity
  /** What it is about: a model, an alias, a provider or a pattern; absent for the whole proxy. */
  readonly subject?: string
  readonly message: string
  readonly recommendation: string
}

/** The doctor's report: `--json` prints it as it is. */
export interface DoctorReport {
  readonly general: readonly Finding[]
  readonly cache: readonly Finding[]
  /** The stats window the cache section read. */
  readonly window: StatsWindow
  /** Whether the stats file was read; `false` when stats are off, or the file absent or unreadable. */
  readonly statsAvailable: boolean
  /** What the doctor cannot tell, whatever it found. */
  readonly limits: readonly string[]
}

/** The fewest calls on a model, in the window, before the cache section judges it. */
export const MIN_CALLS = 20
/** A hit rate under this share is low. */
const LOW_HIT_RATE = 0.5
/** Cache writes over this share of a model's cost are a finding. */
const WRITE_COST_SHARE = 0.4
/** Fallbacks over this share of a model's calls are a finding: each starts a conversation cold. */
const FALLBACK_SHARE = 0.05
/** Requests without a `prompt_cache_key` over this share, on an API that caches by key. */
const KEYLESS_SHARE = 0.1

/**
 * The failure classes broad enough that a `fallbackOn` naming them moves conversations often, each
 * move starting the next model's (or login's) cache cold.
 */
const BROAD_FAILURE_CLASSES: ReadonlySet<FailureClass> = new Set(['upstream_error', 'timeout'])

/** The APIs whose `PI_CACHE_RETENTION=long` costs more per write (1-hour cache points). */
const RETENTION_APIS: ReadonlySet<string> = new Set([
  'anthropic-messages',
  'bedrock-converse-stream'
])

/**
 * The APIs that cache by `prompt_cache_key` (`docs/caching.md`): an API, and the host its base URL
 * must name, when only that host caches by key.
 */
const KEYED_CACHE_APIS: readonly { readonly api: string; readonly host?: string }[] = [
  { api: 'openai-responses', host: 'api.openai.com' },
  { api: 'openai-completions', host: 'api.openai.com' },
  { api: 'openai-codex-responses' },
  { api: 'mistral-conversations' }
]

/** The doctor's limits, printed with every report (#299). */
export const LIMITS: readonly string[] = [
  "The doctor can say a model writes too much to the cache; it cannot say why the client's prompt prefix changes. That needs the prompt, and the proxy never logs or stores message content.",
  'An expired cache and a changed prefix look the same in per-minute counts.',
  'On a subscription login, the dollar figures are catalog prices, not what is billed.'
]

/** Tokens per million: catalog prices are per million tokens. */
const TOKENS_PER_PRICE_UNIT = 1_000_000
/** A share's scale as a percentage. */
const PERCENT = 100
/**
 * What a 1-hour write costs over a 5-minute one, in units of the input price (2 − 1.25): the
 * numerator of the retention break-even (`docs/caching.md`, Retention).
 */
const RETENTION_SHORT_WRITE = 0.75
/** A 1-hour write's price, in units of the input price. */
const RETENTION_LONG_WRITE = 2

/** What the doctor reads of `/healthz/models`'s report. */
export type ModelsInput = Pick<
  ModelsHealth,
  | 'availableModelCount'
  | 'exposedModelCount'
  | 'exposureError'
  | 'scopeDiagnostics'
  | 'aliasDiagnostics'
  | 'loginDiagnostics'
  | 'modelsJsonError'
>

/** What the doctor reads of `/healthz/creds`'s report. */
export interface CredentialsInput extends Pick<
  CredentialsHealth,
  'verified' | 'loginsRegistered' | 'loginsError'
> {
  readonly providers: readonly Pick<
    CredentialsHealth['providers'][number],
    'provider' | 'verified' | 'error'
  >[]
  /**
   * How to verify the logins, the not-verified advice's recommendation: the console points at its
   * Accounts view (#325); the CLI's `--verify` when absent.
   */
  readonly howToVerify?: string
}

/** The not-verified advice's recommendation in the CLI. */
const VERIFY_FLAG_ADVICE =
  'Run with --verify to resolve each now (as /healthz/creds?verify=true; may refresh an OAuth token).'

/** The server settings the config checks read, as the proxy would start with them. */
export interface ServerSettings {
  readonly host: string
  /** Whether proxy auth needs a token. */
  readonly proxyAuth: boolean
  readonly docsUi: boolean
  readonly stats: boolean
}

/** The failures that move a request on, as the config names them. */
export interface FallbackSettings {
  /** Each alias with a fallback chain, and its `fallbackOn`. */
  readonly aliases: readonly {
    readonly alias: string
    readonly fallbackOn: readonly FailureClass[]
  }[]
  /** `routing.logins.fallbackOn`. */
  readonly logins: readonly FailureClass[]
}

/** What the general section judges. */
export interface GeneralInputs {
  readonly models: ModelsInput
  readonly credentials: CredentialsInput
  /**
   * The server settings; `{ unusableAuth }` with the cause's code when proxy auth is set but
   * cannot be applied, so the proxy refuses to start.
   */
  readonly server: ServerSettings | { readonly unusableAuth: string }
  /** Why the config file could not be used, when it could not. */
  readonly configFileProblem: string | undefined
  readonly fallback: FallbackSettings
  /** Fallbacks in the window per alias (`''` for none), from the stats; `undefined` without them. */
  readonly fallbacksByAlias: ReadonlyMap<string, number> | undefined
}

/** A model's catalog entry, as the cache section reads it. */
export interface CatalogModel {
  readonly api: string
  readonly baseUrl: string
  /** US dollars per million tokens. */
  readonly cost: {
    readonly input: number
    readonly output: number
    readonly cacheRead: number
    readonly cacheWrite: number
  }
}

/** What the doctor could read of the stats file. */
export type StatsState =
  | { readonly kind: 'off' }
  | { readonly kind: 'missing'; readonly path: string }
  | { readonly kind: 'unreadable'; readonly reason: string }
  | { readonly kind: 'read'; readonly models: readonly ModelStats[] }

/** What the cache section judges. */
export interface CacheInputs {
  readonly stats: StatsState
  /** pi's catalog, by canonical model ID. */
  readonly catalog: ReadonlyMap<string, CatalogModel>
  /** Whether `PI_CACHE_RETENTION=long` is set in the doctor's environment. */
  readonly retentionLong: boolean
}

/**
 * Formats a share as a percentage with one decimal.
 *
 * @param share - from 0 to 1
 * @returns the percentage, such as `49.9%`
 */
function percent(share: number): string {
  return `${(share * PERCENT).toFixed(1)}%`
}

/** Decimals of a dollar figure. */
const CENTS_DECIMALS = 2

/**
 * Formats a cost in token-dollars (tokens times a per-million price) as US dollars.
 *
 * @param tokenDollars - tokens times the catalog's price per million tokens
 * @returns the dollars, such as `$1.25`
 */
function dollars(tokenDollars: number): string {
  return `$${(tokenDollars / TOKENS_PER_PRICE_UNIT).toFixed(CENTS_DECIMALS)}`
}

/**
 * Builds a finding, leaving `subject` out when there is none.
 *
 * @param check - the check's name
 * @param severity - how much it matters
 * @param subject - what it is about, or `undefined`
 * @param text - the message and the recommendation
 * @returns the finding
 */
function finding(
  check: DoctorCheck,
  severity: Severity,
  subject: string | undefined,
  text: { readonly message: string; readonly recommendation: string }
): Finding {
  return subject === undefined
    ? { check, severity, ...text }
    : { check, severity, subject, ...text }
}

/**
 * Judges the exposure as `/healthz/models` does: an invalid config, or no model exposed, fails.
 *
 * @param models - the models report
 * @returns the findings
 */
function exposureFindings(models: ModelsInput): Finding[] {
  const findings: Finding[] = []
  if (models.exposureError !== null) {
    findings.push(
      finding('exposure', 'error', undefined, {
        message: `The model exposure config is invalid: ${models.exposureError}`,
        recommendation: 'Fix the exposure settings in proxy-config.json (`/proxy config` in pi).'
      })
    )
  } else if (models.exposedModelCount === 0) {
    findings.push(
      finding('exposure', 'error', undefined, {
        message: `No model is exposed (${String(models.availableModelCount)} available).`,
        recommendation:
          models.availableModelCount === 0
            ? 'Log in to a provider in pi (`/login`, or `pi-switchboard tui`), or add one to models.json.'
            : 'Widen the exposure: check `modelExposureMode` and the `enabledModels` patterns.'
      })
    )
  }
  if (models.modelsJsonError !== null) {
    findings.push(
      finding('models-json', 'warning', undefined, {
        message: `${models.modelsJsonError}; pi uses its built-in models only.`,
        recommendation: "Fix models.json in pi's agent dir."
      })
    )
  }
  for (const diagnostic of models.scopeDiagnostics) {
    findings.push(
      finding('enabled-models', 'warning', diagnostic.pattern, {
        message: diagnostic.message,
        recommendation: "Fix or remove the pattern in pi's `enabledModels` (`/scoped-models`)."
      })
    )
  }
  return findings
}

/**
 * Judges the aliases as `/healthz/models` does: a misconfigured alias fails; a target that is not
 * exposed is a warning, and an unreadable family member advice.
 *
 * @param models - the models report
 * @returns the findings
 */
function aliasFindings(models: ModelsInput): Finding[] {
  return models.aliasDiagnostics.map((diagnostic) => {
    if (MISCONFIGURED_ALIAS.has(diagnostic.code)) {
      return finding('alias', 'error', diagnostic.alias, {
        message: `${diagnostic.code}: ${diagnostic.message}`,
        recommendation:
          'Fix the alias in proxy-config.json; until then it does not do what it says.'
      })
    }
    return diagnostic.code === 'target-not-exposed'
      ? finding('alias', 'warning', diagnostic.alias, {
          message: `${diagnostic.code}: ${diagnostic.message}`,
          recommendation: `Expose ${diagnostic.target}, or remove it from the alias.`
        })
      : finding('alias', 'advice', diagnostic.alias, {
          message: `${diagnostic.code}: ${diagnostic.message}`,
          recommendation: 'Nothing to change unless you want that model: pin the alias to it.'
        })
  })
}

/**
 * Reports `routing.logins` settings that do nothing as written (#233): a name that is no login,
 * or a provider whose every login is disabled, so its models are not served. Warnings, as on
 * `/healthz/models`, where neither fails the check: disabling a login is a choice.
 *
 * @param models - the models report
 * @returns the findings
 */
function loginFindings(models: ModelsInput): Finding[] {
  return models.loginDiagnostics.map((diagnostic) =>
    finding('login-routing', 'warning', diagnostic.login ?? diagnostic.provider ?? undefined, {
      message: `${diagnostic.code}: ${diagnostic.message}`,
      recommendation:
        diagnostic.code === 'all-logins-disabled'
          ? `Enable one of its logins (console, Accounts view) to serve its models again.`
          : `Remove the name from ${diagnostic.setting}, or log in to it again.`
    })
  )
}

/**
 * Reports the logins without a verification result: none once `verified` is set (`--verify`);
 * otherwise every login in the CLI, and in the console each one its Accounts view has not
 * verified yet (#325).
 *
 * @param credentials - the credentials report
 * @returns the advice, or `undefined` when every login was verified
 */
function unverifiedFinding(credentials: CredentialsInput): Finding | undefined {
  const unverified = credentials.verified
    ? []
    : credentials.providers.filter((provider) => provider.verified === undefined)
  if (unverified.length === 0) return undefined
  return finding('credentials', 'advice', undefined, {
    message: `${String(unverified.length)} providers have a login or key: ${unverified.map((provider) => provider.provider).join(', ')}. Not verified.`,
    recommendation: credentials.howToVerify ?? VERIFY_FLAG_ADVICE
  })
}

/**
 * Judges the logins as `/healthz/creds` does: none, or one that fails to verify, fails. Without
 * `--verify` nothing is resolved, so a present login is only reported.
 *
 * @param credentials - the credentials report
 * @returns the findings
 */
function credentialFindings(credentials: CredentialsInput): Finding[] {
  const findings: Finding[] = []
  if (credentials.providers.length === 0) {
    findings.push(
      finding('credentials', 'error', undefined, {
        message: 'No provider has a login or an API key.',
        recommendation: 'Log in through pi (`/login`, or `pi-switchboard tui`), or set an API key.'
      })
    )
  } else {
    const unverified = unverifiedFinding(credentials)
    if (unverified !== undefined) findings.push(unverified)
  }
  for (const provider of credentials.providers) {
    if (provider.verified !== false) continue
    findings.push(
      finding('credentials', 'error', provider.provider, {
        message: `The login failed to verify: ${provider.error ?? 'no reason given'}.`,
        recommendation: 'Log in again through pi (`/login`, or `pi-switchboard tui`).'
      })
    )
  }
  if (!credentials.loginsRegistered) {
    findings.push(
      finding('logins', 'warning', undefined, {
        message: `pi's credential store could not be listed (${credentials.loginsError ?? 'unknown'}), so no \`{provider}-N\` login is registered.`,
        recommendation: "Check that pi's agent dir and its auth.json are readable."
      })
    )
  }
  return findings
}

/**
 * Checks the server settings that expose the proxy: auth off, or the docs page on, while bound to
 * an address other machines can reach; and stats off.
 *
 * @param server - the settings, or why proxy auth cannot be applied
 * @param isLoopback - whether a host is a loopback address
 * @returns the findings
 */
function serverFindings(
  server: GeneralInputs['server'],
  isLoopback: (host: string) => boolean
): Finding[] {
  if ('unusableAuth' in server) {
    return [
      finding('proxy-auth', 'error', undefined, {
        message: `Proxy auth is set but cannot be applied (${server.unusableAuth}), so the proxy refuses to start.`,
        recommendation:
          'Run pi-switchboard to see the reason in its log, then fix the token setting.'
      })
    ]
  }
  const findings: Finding[] = []
  const exposed = !isLoopback(server.host)
  if (exposed && !server.proxyAuth) {
    findings.push(
      finding('proxy-auth', 'warning', server.host, {
        message: `Proxy auth is off while the proxy listens on ${server.host}, which other machines can reach.`,
        recommendation: 'Set a token (--auth-token, PI_SWITCHBOARD_AUTH_TOKEN or authToken).'
      })
    )
  }
  if (exposed && server.docsUi) {
    findings.push(
      finding('docs-ui', 'warning', server.host, {
        message: `The docs page (/docs) is on while the proxy listens on ${server.host}; it needs no token.`,
        recommendation: 'Turn docsUi off, or bind to 127.0.0.1.'
      })
    )
  }
  if (!server.stats) {
    findings.push(
      finding('stats', 'advice', undefined, {
        message: 'Stats are off, so the cache section has nothing to read.',
        recommendation: 'Turn stats on (the default; remove --no-stats or `stats: false`).'
      })
    )
  }
  return findings
}

/**
 * Finds `fallbackOn` lists that name broad failure classes: each fallback starts the next model's
 * or login's cache cold.
 *
 * @param fallback - the `fallbackOn` lists
 * @param fallbacksByAlias - the window's fallbacks per alias, when the stats were read
 * @returns the findings
 */
function fallbackFindings(
  fallback: FallbackSettings,
  fallbacksByAlias: ReadonlyMap<string, number> | undefined
): Finding[] {
  const counted = (count: number | undefined): string =>
    fallbacksByAlias === undefined
      ? 'The stats are off or unreadable, so its fallbacks are not counted.'
      : `${String(count ?? 0)} fallbacks in the window.`
  const broad = (classes: readonly FailureClass[]): FailureClass[] =>
    classes.filter((failure) => BROAD_FAILURE_CLASSES.has(failure))
  const findings: Finding[] = []
  for (const { alias, fallbackOn } of fallback.aliases) {
    const named = broad(fallbackOn)
    if (named.length === 0) continue
    findings.push(
      finding('fallback-on', 'advice', alias, {
        message: `The alias falls back on ${named.join(', ')}. ${counted(fallbacksByAlias?.get(alias))}`,
        recommendation:
          "List in fallbackOn only the failures worth a cold cache on the next model (see docs/caching.md 'Routing and the cache')."
      })
    )
  }
  const loginBroad = broad(fallback.logins)
  if (loginBroad.length > 0) {
    // No count: the stats record fallbacks by alias and model, and can't tell a move between a
    // provider's logins from a move to another model.
    findings.push(
      finding('fallback-on', 'advice', 'routing.logins', {
        message: `Requests move between a provider's logins on ${loginBroad.join(', ')}.`,
        recommendation:
          'Keep routing.logins.fallbackOn to ["rate_limit"] (the default) unless moving is worth a cold cache.'
      })
    )
  }
  return findings
}

/**
 * Judges the general section: the health reports and the config.
 *
 * @param inputs - what the doctor read
 * @param isLoopback - whether a host is a loopback address (`isLoopbackHost` in the config)
 * @returns the findings, errors first
 */
export function generalFindings(
  inputs: GeneralInputs,
  isLoopback: (host: string) => boolean
): Finding[] {
  const configFile =
    inputs.configFileProblem === undefined
      ? []
      : [
          finding('config-file', 'warning', undefined, {
            message: `proxy-config.json ${inputs.configFileProblem}; the proxy uses its defaults.`,
            recommendation: 'Fix the file, or remove it.'
          })
        ]
  return bySeverity([
    ...configFile,
    ...serverFindings(inputs.server, isLoopback),
    ...exposureFindings(inputs.models),
    ...aliasFindings(inputs.models),
    ...loginFindings(inputs.models),
    ...credentialFindings(inputs.credentials),
    ...fallbackFindings(inputs.fallback, inputs.fallbacksByAlias)
  ])
}

/** Severity order, most serious first. */
const SEVERITY_RANK: Readonly<Record<Severity, number>> = { error: 0, warning: 1, advice: 2 }

/**
 * Sorts findings by severity, keeping each severity's order.
 *
 * @param findings - the findings
 * @returns them, errors first
 */
export function bySeverity(findings: readonly Finding[]): Finding[] {
  return findings.toSorted(
    (left, right) => SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity]
  )
}

/**
 * Says whether a model's API caches by `prompt_cache_key`.
 *
 * @param model - the catalog entry
 * @returns whether it is one of {@link KEYED_CACHE_APIS}
 */
function cachesByKey(model: Pick<CatalogModel, 'api' | 'baseUrl'>): boolean {
  const host = URL.parse(model.baseUrl)?.hostname
  return KEYED_CACHE_APIS.some(
    (keyed) => keyed.api === model.api && (keyed.host === undefined || keyed.host === host)
  )
}

/**
 * Works out the share of expired writes above which long retention costs less:
 * `0.75 ÷ (2 − cache-read price ÷ input price)` (`docs/caching.md`, Retention).
 *
 * @param cost - the model's prices
 * @returns the share, from 0 to 1; `undefined` when the model has no input price
 */
export function retentionBreakEven(cost: CatalogModel['cost']): number | undefined {
  if (cost.input <= 0) return undefined
  return RETENTION_SHORT_WRITE / (RETENTION_LONG_WRITE - cost.cacheRead / cost.input)
}

/**
 * Checks a model's hit rate.
 *
 * @param stats - the model's numbers
 * @returns a finding when it is under {@link LOW_HIT_RATE}
 */
function hitRateFinding(stats: ModelStats): Finding | undefined {
  const rate = cacheHitRate(stats)
  if (rate === undefined || rate >= LOW_HIT_RATE) return undefined
  return finding('hit-rate', 'warning', stats.model, {
    message: `${percent(rate)} of the prompt was read from the cache over ${String(stats.attempts)} calls.`,
    recommendation:
      "The client likely changes its prompt's start between turns, or its prompts are under the provider's minimum: see docs/caching.md 'Keeping the prefix stable'."
  })
}

/**
 * Checks the share of a model's cost spent writing the cache, at catalog prices.
 *
 * @param stats - the model's numbers
 * @param cost - its catalog prices
 * @returns a finding when it is over {@link WRITE_COST_SHARE}
 */
function writeCostFinding(stats: ModelStats, cost: CatalogModel['cost']): Finding | undefined {
  const write = stats.cacheWriteTokens * cost.cacheWrite
  const total =
    stats.inputTokens * cost.input +
    stats.outputTokens * cost.output +
    stats.cacheReadTokens * cost.cacheRead +
    write
  if (total <= 0 || write / total <= WRITE_COST_SHARE) return undefined
  return finding('cache-write-cost', 'advice', stats.model, {
    message: `Cache writes are ${percent(write / total)} of its cost (${dollars(write)} of ${dollars(total)} at catalog prices; on a subscription login, not what is billed).`,
    recommendation:
      "Writes come from new messages, a changed prefix or an expired cache: see docs/caching.md 'Reading the numbers'."
  })
}

/**
 * Checks `PI_CACHE_RETENTION` against the break-even, on the APIs where long retention costs more
 * per write.
 *
 * @param stats - the model's numbers
 * @param model - its catalog entry
 * @param retentionLong - whether `PI_CACHE_RETENTION=long` is set
 * @returns a finding when the setting does not match the model's cold writes
 */
function retentionFinding(
  stats: ModelStats,
  model: CatalogModel,
  retentionLong: boolean
): Finding | undefined {
  const breakEven = retentionBreakEven(model.cost)
  if (!RETENTION_APIS.has(model.api) || breakEven === undefined || stats.cacheWriteTokens === 0) {
    return undefined
  }
  const cold = stats.coldCacheWriteTokens / stats.cacheWriteTokens
  const measured = `${percent(cold)} of cache writes look cold (cold_pct), against a break-even of ${percent(breakEven)}.`
  if (!retentionLong && cold > breakEven) {
    return finding('retention', 'advice', stats.model, {
      message: measured,
      recommendation:
        "Try PI_CACHE_RETENTION=long in the proxy's environment, then compare a day's cost_usd (cold_pct is a heuristic)."
    })
  }
  if (retentionLong && cold < breakEven) {
    return finding('retention', 'advice', stats.model, {
      message: `${measured} PI_CACHE_RETENTION=long is set.`,
      recommendation:
        "Remove PI_CACHE_RETENTION=long from the proxy's environment: 1-hour writes cost more than the expiries they save."
    })
  }
  return undefined
}

/**
 * Checks how often a model's calls moved on to another model or login.
 *
 * @param stats - the model's numbers
 * @returns a finding when the fallbacks are over {@link FALLBACK_SHARE} of its calls
 */
function fallbackShareFinding(stats: ModelStats): Finding | undefined {
  if (stats.fallbacks / stats.attempts <= FALLBACK_SHARE) return undefined
  return finding('fallbacks', 'advice', stats.model, {
    message: `${String(stats.fallbacks)} of ${String(stats.attempts)} calls moved on to the next model or login, which starts that conversation's cache cold.`,
    recommendation:
      "Check the failures behind them (the console's Stats view), and the fallbackOn lists: see docs/caching.md 'Routing and the cache'."
  })
}

/**
 * Checks the share of a model's requests sent without a `prompt_cache_key`, on an API that caches
 * by key.
 *
 * @param stats - the model's numbers
 * @param model - its catalog entry
 * @returns a finding when the share is over {@link KEYLESS_SHARE}
 */
function cacheKeyFinding(stats: ModelStats, model: CatalogModel): Finding | undefined {
  if (!cachesByKey(model) || stats.requests === 0) return undefined
  const keyless = 1 - stats.promptCacheKeyRequests / stats.requests
  if (keyless <= KEYLESS_SHARE) return undefined
  return finding('prompt-cache-key', 'advice', stats.model, {
    message: `${percent(keyless)} of ${String(stats.requests)} requests sent no prompt_cache_key, on an API that caches by key. Requests recorded before the stats counted keys (schema version 2) count as keyless.`,
    recommendation: 'Have the client send one prompt_cache_key per conversation.'
  })
}

/**
 * Judges one model with enough calls.
 *
 * @param stats - its numbers
 * @param inputs - the catalog and the retention setting
 * @returns its findings
 */
function modelFindings(stats: ModelStats, inputs: CacheInputs): Finding[] {
  const model = inputs.catalog.get(stats.model)
  const priced =
    model === undefined
      ? []
      : [
          writeCostFinding(stats, model.cost),
          retentionFinding(stats, model, inputs.retentionLong),
          cacheKeyFinding(stats, model)
        ]
  return [hitRateFinding(stats), ...priced, fallbackShareFinding(stats)].filter(
    (found) => found !== undefined
  )
}

/**
 * Says why the stats could not be read, as the cache section's one finding.
 *
 * @param stats - the stats file's state, other than read
 * @returns the finding
 */
function statsFinding(stats: Exclude<StatsState, { kind: 'read' }>): Finding {
  if (stats.kind === 'unreadable') {
    return finding('stats', 'warning', undefined, {
      message: `The stats file could not be read: ${stats.reason}`,
      recommendation: 'Fix what the reason says; the proxy recreates a deleted file.'
    })
  }
  return stats.kind === 'missing'
    ? finding('stats', 'advice', undefined, {
        message: `There is no stats file yet (${stats.path}).`,
        recommendation: 'Start the proxy with stats on and let it serve some traffic.'
      })
    : finding('stats', 'advice', undefined, {
        message: 'Stats are off: there is nothing to judge the cache by.',
        recommendation: 'Turn stats on and let the proxy serve some traffic.'
      })
}

/**
 * Judges the cache section: each model with at least {@link MIN_CALLS} calls in the window.
 *
 * @param inputs - the stats, the catalog and the retention setting
 * @returns the findings, warnings first; one finding saying why when there was nothing to judge
 */
export function cacheFindings(inputs: CacheInputs): Finding[] {
  if (inputs.stats.kind !== 'read') return [statsFinding(inputs.stats)]
  const judged = inputs.stats.models.filter((stats) => stats.attempts >= MIN_CALLS)
  if (judged.length === 0) {
    return [
      finding('stats', 'advice', undefined, {
        message: `No model had ${String(MIN_CALLS)} calls in the window, so none was judged.`,
        recommendation: 'Try a longer window (--window all), or come back after more traffic.'
      })
    ]
  }
  return bySeverity(judged.flatMap((stats) => modelFindings(stats, inputs)))
}

/**
 * Builds the report.
 *
 * @param general - the general section's inputs
 * @param cache - the cache section's inputs
 * @param options - the window, and whether a host is a loopback address
 * @returns the report
 */
export function doctorReport(
  general: GeneralInputs,
  cache: CacheInputs,
  options: { readonly window: StatsWindow; readonly isLoopback: (host: string) => boolean }
): DoctorReport {
  return {
    general: generalFindings(general, options.isLoopback),
    cache: cacheFindings(cache),
    window: options.window,
    statsAvailable: cache.stats.kind === 'read',
    limits: LIMITS
  }
}

/**
 * The doctor's exit status: 1 when the general section has an error (what makes `/healthz/models`
 * or `/healthz/creds` answer 503, or the proxy refuse to start), else 0. Cache findings and
 * warnings never fail it.
 *
 * @param report - the report
 * @returns 0 or 1
 */
export function doctorExitCode(report: Pick<DoctorReport, 'general'>): 0 | 1 {
  return report.general.some((found) => found.severity === 'error') ? 1 : 0
}
