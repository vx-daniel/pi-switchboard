/**
 * The admin pages' client for `/admin/api/` (#367): one `fetch` per read, its answer checked
 * against a schema of the fields the pages show, so a changed answer fails loudly instead of
 * showing nonsense.
 *
 * @remarks
 * The schemas are loose: an answer may carry more than a page reads. A `401` is
 * {@link NotSignedInError}, which the app answers with the sign-in screen; any other failure is an
 * {@link ApiError} with the proxy's message.
 *
 * @packageDocumentation
 */

import * as z from 'zod'

/** The session expired, or there never was one. */
export class NotSignedInError extends Error {
  /** Names the error. */
  override readonly name = 'NotSignedInError'
}

/** The proxy answered with an error other than a missing session. */
class ApiError extends Error {
  /** Names the error. */
  override readonly name = 'ApiError'

  /**
   * Makes the error.
   *
   * @param message - the proxy's message, or a description of the failure
   * @param status - the HTTP status
   */
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}

/** The HTTP status of a request without a session. */
const UNAUTHORIZED = 401

/** An error body, as the proxy sends one. */
const ErrorBodySchema = z.looseObject({
  error: z.looseObject({ message: z.string().trim() })
})

/** `GET /admin/api/session`. */
export const SessionSchema = z.looseObject({
  login: z.string().trim(),
  role: z.enum(['editor', 'viewer'])
})
/** Who is signed in. */
export type Session = z.infer<typeof SessionSchema>

/** One HTTP request the proxy keeps. */
const HttpRequestSchema = z.looseObject({
  sequence: z.int(),
  requestId: z.string().trim(),
  method: z.string().trim(),
  path: z.string().trim(),
  startedAt: z.number(),
  status: z.int().optional(),
  endedAt: z.number().optional()
})

/** One chat request, in flight or finished. */
const ChatSchema = z.looseObject({
  requestId: z.string().trim(),
  alias: z.string().trim().nullable(),
  model: z.string().trim(),
  attempt: z.int(),
  stream: z.boolean(),
  startedAt: z.number(),
  outcome: z.enum(['ok', 'failed', 'left', 'rejected']).optional(),
  endedAt: z.number().optional()
})

/** One lifecycle event. */
const EventSchema = z.looseObject({
  sequence: z.int(),
  at: z.number(),
  level: z.enum(['info', 'warning', 'error']),
  text: z.string().trim()
})

/** `GET /admin/api/requests`, and each event of its stream. */
export const RequestsSchema = z.looseObject({
  requests: z.array(HttpRequestSchema),
  active: z.array(ChatSchema),
  finished: z.array(ChatSchema),
  events: z.array(EventSchema)
})
/** The Requests page's data. */
export type Requests = z.infer<typeof RequestsSchema>
/** One HTTP request. */
export type HttpRequest = z.infer<typeof HttpRequestSchema>
/** One chat request. */
export type Chat = z.infer<typeof ChatSchema>
/** One lifecycle event. */
export type ProxyEvent = z.infer<typeof EventSchema>

/** One window of a login's quota. */
const QuotaWindowSchema = z.looseObject({
  name: z.string().trim(),
  used: z.number(),
  resetsAt: z.number().optional()
})

/** One login. */
const AccountSchema = z.looseObject({
  provider: z.string().trim(),
  base: z.string().trim(),
  type: z.enum(['oauth', 'api_key']),
  source: z.string().trim().optional(),
  availableModelCount: z.int(),
  label: z.string().trim().nullable(),
  quota: z.looseObject({ windows: z.array(QuotaWindowSchema) }).nullable(),
  belowReserve: z
    .looseObject({ window: z.string().trim(), left: z.number(), reserve: z.number() })
    .nullable(),
  cooldowns: z.array(
    z.looseObject({
      model: z.string().trim().optional(),
      reason: z.string().trim(),
      until: z.number()
    })
  ),
  place: z
    .looseObject({ position: z.int(), count: z.int(), first: z.boolean(), disabled: z.boolean() })
    .nullable()
})

/** `GET /admin/api/accounts`. */
export const AccountsSchema = z.array(AccountSchema)
/** One login, as the Accounts page shows it. */
export type Account = z.infer<typeof AccountSchema>

/** One exposed model or alias. */
const ExposedSchema = z.looseObject({
  id: z.string().trim(),
  provider: z.string().trim(),
  reasoning_efforts: z.array(z.string().trim()),
  context_window: z.int().optional(),
  max_output_tokens: z.int().optional(),
  input: z.array(z.string().trim())
})

/** `GET /admin/api/models`. */
export const ModelsSchema = z.looseObject({
  models: z.array(ExposedSchema),
  aliases: z.array(ExposedSchema),
  configured: z.record(z.string().trim(), z.unknown()),
  latest: z.record(z.string().trim(), z.unknown()),
  aliasDiagnostics: z.array(
    z.looseObject({ alias: z.string().trim().optional(), message: z.string().trim() })
  ),
  available: z.int(),
  modelsJsonError: z.string().trim().nullable()
})
/** The Models page's data. */
export type Models = z.infer<typeof ModelsSchema>
/** One exposed model or alias. */
export type Exposed = z.infer<typeof ExposedSchema>

/** One model's or alias's numbers. */
const UsageFieldsSchema = z.looseObject({
  requests: z.int(),
  failed: z.int(),
  average_ms: z.number().nullable(),
  fallbacks: z.int(),
  input_tokens: z.int(),
  output_tokens: z.int(),
  cache_read_tokens: z.int(),
  cost_usd: z.number()
})

/** `GET /admin/api/stats`. */
export const UsageSchema = z.looseObject({
  window: z.enum(['today', 'week', 'all']),
  bucket_minutes: z.int(),
  models: z.array(UsageFieldsSchema.extend({ model: z.string().trim() })),
  failures: z.array(z.looseObject({ class: z.string().trim(), count: z.int() })),
  rejected: z.array(z.looseObject({ status: z.int(), count: z.int() })),
  timeline: z.array(
    z.looseObject({
      start: z.string().trim(),
      requests: z.int(),
      failed: z.int(),
      rejected: z.int()
    })
  )
})
/** The Stats page's data. */
export type Usage = z.infer<typeof UsageSchema>

/** One doctor finding. */
const FindingSchema = z.looseObject({
  check: z.string().trim(),
  severity: z.enum(['error', 'warning', 'advice']),
  subject: z.string().trim().optional(),
  message: z.string().trim(),
  recommendation: z.string().trim()
})

/** `GET /admin/api/doctor`. */
export const DoctorSchema = z.looseObject({
  general: z.array(FindingSchema),
  cache: z.array(FindingSchema),
  window: z.enum(['today', 'week', 'all']),
  statsAvailable: z.boolean(),
  limits: z.array(z.string().trim())
})
/** The Doctor page's data. */
export type Doctor = z.infer<typeof DoctorSchema>
/** One doctor finding. */
export type Finding = z.infer<typeof FindingSchema>

/** One route's traffic since the proxy started. */
const RouteTotalsSchema = z.looseObject({
  alias: z.string().trim().nullable(),
  model: z.string().trim(),
  requests: z.int(),
  failures: z.int(),
  fallbacks: z.int(),
  inputTokens: z.int(),
  outputTokens: z.int(),
  cacheReadTokens: z.int()
})

/** `GET /admin/api/status`: the status strip's and the sidebar's data. */
export const StatusSchema = z.looseObject({
  version: z.string().trim(),
  address: z.string().trim(),
  proxyAuth: z.enum(['token', 'off']),
  beyondLoopback: z.boolean(),
  uptimeMs: z.number(),
  available: z.int(),
  exposed: z.union([z.int(), z.string().trim()]),
  modelsJsonError: z.string().trim().nullable(),
  cooldowns: z.int(),
  perMinute: z.array(z.int()),
  saturated: z.boolean(),
  todayCostUsd: z.number().nullable(),
  session: z.looseObject({ since: z.number(), totals: z.array(RouteTotalsSchema) })
})
/** The proxy's status. */
export type Status = z.infer<typeof StatusSchema>

/** A stats window. */
export type StatsWindow = Doctor['window']

/**
 * Reads why a failed answer failed: the proxy's message, or its status.
 *
 * @param response - the failed answer
 * @returns the message
 */
async function failureMessage(response: Response): Promise<string> {
  const body = ErrorBodySchema.safeParse(await response.json().catch(() => undefined))
  return body.success ? body.data.error.message : `The proxy answered ${String(response.status)}`
}

/**
 * Checks a value against a schema.
 *
 * @typeParam T - the value's type
 * @param schema - the schema
 * @param value - the value
 * @param path - where it came from, for the error
 * @returns the value, checked
 * @throws ApiError when it does not fit the schema
 */
export function checked<T>(schema: z.ZodType<T>, value: unknown, path: string): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new ApiError(`Unexpected answer from ${path}`, 0)
  return parsed.data
}

/**
 * Reads one API path.
 *
 * @typeParam T - the answer's type
 * @param path - the path under `/admin/api`, with its query
 * @param schema - what the answer must look like
 * @returns the answer
 * @throws NotSignedInError when there is no session; ApiError for any other failure
 */
export async function readApi<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const response = await fetch(`/admin/api${path}`, { headers: { Accept: 'application/json' } })
  if (response.status === UNAUTHORIZED) throw new NotSignedInError('Not signed in')
  if (!response.ok) throw new ApiError(await failureMessage(response), response.status)
  return checked(schema, await response.json(), path)
}

/**
 * Signs out: clears the session cookie, then reloads the page, which shows the sign-in screen.
 */
export async function signOut(): Promise<void> {
  await fetch('/admin/auth/sign-out', { method: 'POST' })
  window.location.reload()
}
