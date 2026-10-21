/**
 * Subscription quota from provider response headers (#69).
 *
 * Subscriptions report how much of each usage window an account has used, on every response.
 * The proxy keeps the latest report per provider, in memory, and shows it on `/healthz/creds` and
 * `/v1/switchboard/models`. Read on 2026-10-21 from a live probe of each logged-in subscription
 * (PLAN "Quota (#69)"):
 *
 * - **Anthropic** (Claude subscription): `anthropic-ratelimit-unified-<window>-utilization` (a 0–1
 *   fraction), `-reset` (Unix seconds) and `-status`, for the `5h` and `7d` windows, plus an
 *   overall `anthropic-ratelimit-unified-status`.
 * - **Codex** (ChatGPT plan): `x-codex-<primary|secondary>-used-percent` (0–100), `-reset-at`
 *   (Unix seconds) and `-window-minutes`, plus `x-codex-plan-type`. Codex sends them only over
 *   SSE, which the proxy uses for Codex (#185).
 *
 * Only these named fields are read, each checked for its type. The same responses carry account,
 * organization and workspace IDs, cookies and an opaque turn token, none of which is kept.
 *
 * @packageDocumentation
 */

/** One usage window: how much of it is used, and when it resets. */
export interface QuotaWindow {
  /** The provider's name for it: `5h`, `7d`, `primary`, `secondary`. */
  readonly name: string
  /** The share used, from 0 to 1. */
  readonly used: number
  /** When it resets, in milliseconds since the epoch. */
  readonly resetsAt: number | undefined
  /** Its length in minutes, where the provider says or its name does (`5h`). */
  readonly windowMinutes: number | undefined
  /** The provider's status for it, such as Anthropic's `allowed` or `rejected`. */
  readonly status: string | undefined
}

/** A provider's latest quota report. */
export interface ProviderQuota {
  readonly provider: string
  /** When the response carrying it arrived, in milliseconds since the epoch. */
  readonly observedAt: number
  /** The provider's overall status, such as Anthropic's `allowed`. */
  readonly status: string | undefined
  /** The subscription plan, such as Codex's `plus`. */
  readonly plan: string | undefined
  readonly windows: readonly QuotaWindow[]
}

/** What one response's headers report, before it is tied to a provider. */
type QuotaReport = Omit<ProviderQuota, 'provider' | 'observedAt'>

/** `anthropic-ratelimit-unified-<window>-<field>`, for the fields a window has. */
const ANTHROPIC_WINDOW =
  /^anthropic-ratelimit-unified-([a-z0-9_]{1,16})-(utilization|reset|status)$/
/** `x-codex-<window>-<field>`, for the fields a window has. */
const CODEX_WINDOW = /^x-codex-(primary|secondary)-(used-percent|reset-at|window-minutes)$/
/** A status or plan word: kept only if it looks like one. */
const WORD = /^[a-z][a-z_]{0,31}$/i
/** A window name that gives its length: `5h`, `7d`. */
const NAMED_LENGTH = /^(\d{1,3})([hd])$/
/** Minutes in an hour. */
const MINUTES_PER_HOUR = 60
/** Minutes in a day. */
const MINUTES_PER_DAY = 1440
/** Minutes per unit of a {@link NAMED_LENGTH} name. */
const MINUTES_PER: ReadonlyMap<string, number> = new Map([
  ['h', MINUTES_PER_HOUR],
  ['d', MINUTES_PER_DAY]
])
/** Milliseconds per second. */
const MS_PER_SECOND = 1000
/** A Codex percentage's whole. */
const PERCENT = 100

/** The fields of one window, as read so far. */
interface WindowFields {
  used?: number
  resetsAt?: number
  windowMinutes?: number
  status?: string
}

/** The latest report per provider. */
const quotas = new Map<string, ProviderQuota>()

/**
 * Reads a plain non-negative number.
 *
 * @param text - the header value
 * @returns the number, or `undefined` when it is not one
 */
function plainNumber(text: string): number | undefined {
  if (!/^\s*\d+(?:\.\d+)?\s*$/.test(text)) return undefined
  return Number.parseFloat(text)
}

/**
 * Reads a status or plan word, lower-cased.
 *
 * @param text - the header value
 * @returns the word, or `undefined` when it does not look like one
 */
function word(text: string | null): string | undefined {
  return text !== null && WORD.test(text.trim()) ? text.trim().toLowerCase() : undefined
}

/**
 * Reads a share used: 0 to 1, or a percentage when `percent` is set.
 *
 * @param text - the header value
 * @param percent - whether it is written as 0–100
 * @returns the share from 0 to 1, or `undefined` when out of range or not a number
 */
function share(text: string, percent: boolean): number | undefined {
  const value = plainNumber(text)
  if (value === undefined) return undefined
  const fraction = percent ? value / PERCENT : value
  return fraction <= 1 ? fraction : undefined
}

/**
 * Adds one header's field to its window.
 *
 * @param fields - the window's fields so far
 * @param field - the header's field name
 * @param value - the header value
 */
function addField(fields: WindowFields, field: string, value: string): void {
  switch (field) {
    case 'utilization':
    case 'used-percent': {
      const used = share(value, field === 'used-percent')
      if (used !== undefined) fields.used = used
      return
    }
    case 'reset':
    case 'reset-at': {
      const seconds = plainNumber(value)
      if (seconds !== undefined) fields.resetsAt = seconds * MS_PER_SECOND
      return
    }
    case 'window-minutes': {
      const minutes = plainNumber(value)
      if (minutes !== undefined) fields.windowMinutes = minutes
      return
    }
    default: {
      const status = word(value)
      if (status !== undefined) fields.status = status
    }
  }
}

/**
 * Says how long a window named like `5h` or `7d` is.
 *
 * @param name - the window's name
 * @returns its length in minutes, or `undefined` when the name doesn't say
 */
function minutesFromName(name: string): number | undefined {
  const match = NAMED_LENGTH.exec(name)
  const per = match?.[2] === undefined ? undefined : MINUTES_PER.get(match[2])
  return match?.[1] === undefined || per === undefined ? undefined : Number(match[1]) * per
}

/**
 * Reads the usage windows a response reports.
 *
 * @param headers - the response headers
 * @returns the windows that report a share used, in header order
 */
function readWindows(headers: Headers): QuotaWindow[] {
  const byName = new Map<string, WindowFields>()
  for (const [headerName, headerValue] of headers) {
    const match = ANTHROPIC_WINDOW.exec(headerName) ?? CODEX_WINDOW.exec(headerName)
    if (match?.[1] === undefined || match[2] === undefined) continue
    const fields = byName.get(match[1]) ?? {}
    addField(fields, match[2], headerValue)
    byName.set(match[1], fields)
  }
  return [...byName]
    .filter(([, fields]) => fields.used !== undefined)
    .map(([name, fields]) => ({
      name,
      used: fields.used ?? 0,
      resetsAt: fields.resetsAt,
      windowMinutes: fields.windowMinutes ?? minutesFromName(name),
      status: fields.status
    }))
}

/**
 * Reads the quota a response's headers report.
 *
 * @param headers - the response headers
 * @returns the report, or `undefined` when the response reports no usage window
 */
export function readQuota(headers: Headers): QuotaReport | undefined {
  const windows = readWindows(headers)
  if (windows.length === 0) return undefined
  return {
    status: word(headers.get('anthropic-ratelimit-unified-status')),
    plan: word(headers.get('x-codex-plan-type')),
    windows
  }
}

/**
 * Keeps the quota a provider's response reports, replacing its last report. A response that
 * reports none leaves the last report as it is.
 *
 * @param provider - the provider that answered, on the proxy's own login
 * @param headers - the response headers
 * @param now - when the response arrived
 */
export function recordQuota(provider: string, headers: Headers, now: number = Date.now()): void {
  const report = readQuota(headers)
  if (report !== undefined) quotas.set(provider, { provider, observedAt: now, ...report })
}

/**
 * Returns a provider's latest quota, without the windows that have reset since: their share used
 * is no longer known. Once one has, the overall status is unknown too, as it may have been that
 * window's (#189 review).
 *
 * @param provider - the provider
 * @param now - the current time
 * @returns the quota, or `undefined` when the provider reported none or every window has reset
 */
export function providerQuota(
  provider: string,
  now: number = Date.now()
): ProviderQuota | undefined {
  const quota = quotas.get(provider)
  if (quota === undefined) return undefined
  const windows = quota.windows.filter(
    (window) => window.resetsAt === undefined || window.resetsAt > now
  )
  if (windows.length === 0) return undefined
  return windows.length === quota.windows.length ? quota : { ...quota, status: undefined, windows }
}

/** Forgets every report, as a restart does. Tests share this process-wide state. */
export function clearAllQuotas(): void {
  quotas.clear()
}

/**
 * Wraps `fetch` so that every response's headers are passed to `onHeaders` before pi reads it.
 *
 * @param onHeaders - receives each response's headers
 * @param base - the `fetch` to wrap
 * @returns the wrapped `fetch`, for pi's `fetch` stream option
 */
export function observingFetch(
  onHeaders: (headers: Headers) => void,
  base: typeof globalThis.fetch
): typeof globalThis.fetch {
  return async (input, init) => {
    const response = await base(input, init)
    onHeaders(response.headers)
    return response
  }
}
