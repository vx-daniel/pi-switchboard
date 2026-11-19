/**
 * The admin UI's API (#367): who is signed in, the pages' data, and an editor's changes, under
 * `/admin/api/` on the admin listener. Every route needs a session; every write, an editor's.
 *
 * @remarks
 * A request without a valid session cookie is answered `401` before any route runs, so an unknown
 * path tells nobody signed out what exists. The Requests page follows `/admin/api/requests/stream`,
 * a server-sent event stream of the same snapshot `/admin/api/requests` answers, sent at most
 * twice a second while the requests change, with a comment every 15 seconds to keep proxies from
 * closing it.
 *
 * @packageDocumentation
 */

import { AliasBodySchema, changeAlias, removeAlias } from '@proxy/admin/aliases'
import type { Refusal } from '@proxy/admin/answers'
import { readBudgets, setBudget } from '@proxy/admin/budgets'
import {
  endCooldowns,
  type LoginChange,
  setLoginDisabled,
  setLoginLabel,
  useLoginFirst
} from '@proxy/admin/logins'
import {
  accountsSnapshot,
  type AdminServerFacts,
  doctorSnapshot,
  modelsSnapshot,
  readExposure,
  requestsSnapshot
} from '@proxy/admin/reads'
import type { AdminRole } from '@proxy/admin/roles'
import { changeSetting, settingsSnapshot } from '@proxy/admin/settings'
import { statusSnapshot } from '@proxy/admin/status'
import { BudgetSchema } from '@proxy/config/projects'
import { proxyLogger } from '@proxy/logging'
import type { ModelExposureResult } from '@proxy/openai/model-exposure'
import { onActiveRequestsChange } from '@proxy/server/active-requests'
import { onConsoleEventsChange } from '@proxy/server/console-events'
import { onHttpRequestsChange } from '@proxy/server/http-requests'
import {
  HTTP_BAD_REQUEST,
  HTTP_FORBIDDEN,
  HTTP_OK,
  HTTP_SERVICE_UNAVAILABLE,
  HTTP_UNAUTHORIZED
} from '@proxy/server/http-status'
import { createUsageAnswer } from '@proxy/server/usage'
import { isStatsWindow, type StatsWindow } from '@proxy/stats/windows'
import { errorMessage } from '@proxy/utils/guards'
import { type Context, Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import * as z from 'zod'

/** Logger for the admin UI's reads. */
const adminLogger = proxyLogger('admin')

/** How often a changed snapshot is sent at most, in milliseconds. */
const STREAM_FLUSH_MS = 500
/** How often an idle stream sends a comment, in milliseconds. */
const STREAM_HEARTBEAT_MS = 15_000

/** A signed-in operator. */
export interface AdminSession {
  readonly login: string
  readonly id: number
  readonly role: AdminRole
}

/** What the API reads with. */
export interface AdminApiDeps {
  /**
   * Opens the session a request's cookies carry.
   *
   * @param cookieHeader - the request's `Cookie` header, or `undefined` when it sent none
   * @returns the operator, or `undefined` when there is no valid session
   */
  readonly sessionOf: (cookieHeader: string | undefined) => AdminSession | undefined
  /** The API listener's settings, for the doctor and the stats. */
  readonly server: AdminServerFacts
  /** The time, in milliseconds since the epoch. */
  readonly now: () => number
}

/** The API's Hono env: the session the middleware found. */
interface AdminApiEnv {
  readonly Variables: { readonly session: AdminSession }
}

/** The answer to a request without a session. */
const NOT_SIGNED_IN = {
  error: { code: 'not_signed_in', message: 'Sign in at /admin/auth/sign-in' }
} as const

/** The answer to a `window` that is no window. */
const BAD_WINDOW = {
  error: { code: 'invalid_window', message: '`window` must be `today`, `week` or `all`' }
} as const

/**
 * Reads the `window` query value: `today` when absent, `undefined` when it is no window.
 *
 * @param value - the query value
 * @returns the window, or `undefined` when it is not one
 */
function windowOf(value: string | undefined): StatsWindow | undefined {
  const asked = value ?? 'today'
  return isStatsWindow(asked) ? asked : undefined
}

/**
 * Adds the requests routes: the snapshot, and the stream that sends it again on each change.
 *
 * @param api - the API app
 */
function addRequests(api: Hono<AdminApiEnv>): void {
  api.get('/requests', (context) => context.json(requestsSnapshot()))
  api.get('/requests/stream', (context) =>
    streamSSE(context, async (stream) => {
      let changed = true
      const mark = (): void => {
        changed = true
      }
      const unsubscribe = [
        onHttpRequestsChange(mark),
        onActiveRequestsChange(mark),
        onConsoleEventsChange(mark)
      ]
      let close = (): void => undefined
      // The executor form: `Promise.withResolvers` is past this project's TypeScript lib.
      const closed = new Promise<void>((resolve) => {
        close = resolve
      })
      const flush = setInterval(() => {
        if (!changed) return
        changed = false
        stream
          .writeSSE({ event: 'requests', data: JSON.stringify(requestsSnapshot()) })
          .catch(close)
      }, STREAM_FLUSH_MS)
      const heartbeat = setInterval(() => {
        stream.write(': heartbeat\n\n').catch(close)
      }, STREAM_HEARTBEAT_MS)
      stream.onAbort(close)
      await closed
      clearInterval(flush)
      clearInterval(heartbeat)
      for (const stop of unsubscribe) stop()
    })
  )
}

/**
 * Adds the page routes: accounts, models, stats and the doctor.
 *
 * @param api - the API app
 * @param deps - what the API reads with
 */
function addPages(api: Hono<AdminApiEnv>, deps: AdminApiDeps): void {
  const usage = createUsageAnswer(deps.server.running.statsEnabled)

  api.get('/accounts', async (context) => context.json(await accountsSnapshot(deps.now())))

  api.get('/models', modelsAnswer)

  api.get('/stats', (context) => {
    const answer = usage(context.req.query('window'), deps.now())
    return context.json(answer.body, answer.status)
  })

  api.get('/status', async (context) => {
    const now = deps.now()
    const today = usage('today', now)
    const cost =
      today.status === HTTP_OK
        ? today.body.models.reduce((total, model) => total + model.cost_usd, 0)
        : null
    return context.json(await statusSnapshot(deps.server, cost, now))
  })

  api.get('/doctor', async (context) => {
    const window = windowOf(context.req.query('window'))
    if (window === undefined) return context.json(BAD_WINDOW, HTTP_BAD_REQUEST)
    return context.json(await doctorSnapshot(deps.server, window, deps.now()))
  })
}

/** What a settings write sends: the new value, and whether a confirmation was given. */
const SettingBodySchema = z.object({
  value: z.unknown(),
  confirm: z.boolean().optional()
})

/** What disabling or enabling a login sends. */
const DisabledBodySchema = z
  .object({
    disabled: z.boolean(),
    confirm: z.boolean().optional()
  })
  .strict()

/** What labelling a login sends; an empty label removes it. */
const LabelBodySchema = z.object({ label: z.string().trim() }).strict()

/** The API's request context. */
type ApiContext = Context<AdminApiEnv>

/**
 * Reads a write's JSON body.
 *
 * @typeParam Body - what it must be
 * @param context - the request
 * @param schema - what it must look like
 * @returns the body, or `undefined` when it isn't JSON of that shape
 */
async function bodyOf<Body>(
  context: ApiContext,
  schema: z.ZodType<Body>
): Promise<Body | undefined> {
  const parsed = schema.safeParse(
    await context.req.json<unknown>().catch((): undefined => undefined)
  )
  return parsed.success ? parsed.data : undefined
}

/**
 * Answers a write whose body isn't what the route takes.
 *
 * @param context - the request
 * @param message - what to send instead
 * @returns the `400`
 */
function invalidBody(context: ApiContext, message: string): Response {
  return context.json({ error: { code: 'invalid_body', message } }, HTTP_BAD_REQUEST)
}

/**
 * Answers a refused write, or the page's data after it.
 *
 * @param context - the request
 * @param refusal - why it was refused, or `undefined` when it was made
 * @param fresh - reads the page's data after it
 * @returns the answer
 */
async function written(
  context: ApiContext,
  refusal: Refusal | undefined,
  fresh: () => Promise<unknown>
): Promise<Response> {
  if (refusal !== undefined) return context.json(refusal.body, refusal.status)
  return context.json(await fresh())
}

/**
 * Adds the settings routes: the page's data, and an editor's change to one setting.
 *
 * @param api - the API app
 * @param deps - what the API reads with
 */
function addSettings(api: Hono<AdminApiEnv>, deps: AdminApiDeps): void {
  api.get('/settings', async (context) => context.json(await settingsSnapshot(deps.server)))

  api.put('/settings/:key', async (context) => {
    const body = await bodyOf(context, SettingBodySchema)
    if (body === undefined) return invalidBody(context, 'Send the new value as { "value": … }.')
    const answer = await changeSetting(deps.server, {
      login: context.get('session').login,
      key: context.req.param('key'),
      value: body.value,
      confirmed: body.confirm === true
    })
    return context.json(answer.body, answer.status)
  })
}

/**
 * Answers the Models page's data, or `503` when the exposure config can't be applied.
 *
 * @param context - the request
 * @returns the answer
 */
function modelsAnswer(context: ApiContext): Promise<Response> {
  return modelsSnapshot().then((models) =>
    'unavailable' in models
      ? context.json(
          { error: { code: 'exposure_invalid', message: models.unavailable } },
          HTTP_SERVICE_UNAVAILABLE
        )
      : context.json(models)
  )
}

/**
 * Adds the alias routes: an editor saves, renames or deletes an alias; each answers with the
 * Models page's data.
 *
 * @param api - the API app
 */
function addAliases(api: Hono<AdminApiEnv>): void {
  api.put('/aliases/:name', async (context) => {
    const body = await bodyOf(context, AliasBodySchema)
    if (body === undefined) {
      return invalidBody(context, 'Send { "targets": […], "fallbackOn": […], "previousName"? }.')
    }
    const exposure = await readExposure()
    if (!exposure.ok) return modelsAnswer(context)
    const refusal = changeAlias(exposure, {
      login: context.get('session').login,
      name: context.req.param('name'),
      body
    })
    if (refusal !== undefined) return context.json(refusal.body, refusal.status)
    return modelsAnswer(context)
  })

  api.delete('/aliases/:name', async (context) => {
    const refusal = removeAlias(context.get('session').login, context.req.param('name'))
    if (refusal !== undefined) return context.json(refusal.body, refusal.status)
    return modelsAnswer(context)
  })
}

/**
 * Adds the login routes: an editor puts a login first, disables or enables it, labels it, or
 * ends cooldowns. The first three answer with the Accounts page's data, the last with the
 * cooldowns it ended.
 *
 * @param api - the API app
 * @param deps - what the API reads with
 */
function addLogins(api: Hono<AdminApiEnv>, deps: AdminApiDeps): void {
  const accounts = (): Promise<unknown> => accountsSnapshot(deps.now())
  const changeOf = (context: ApiContext): LoginChange => ({
    operator: context.get('session').login,
    login: context.req.param('login') ?? ''
  })

  api.post('/logins/:login/first', async (context) =>
    written(context, await useLoginFirst(changeOf(context)), accounts)
  )

  api.put('/logins/:login/disabled', async (context) => {
    const body = await bodyOf(context, DisabledBodySchema)
    if (body === undefined) {
      return invalidBody(context, 'Send { "disabled": true|false, "confirm"? }.')
    }
    const refusal = await setLoginDisabled({
      ...changeOf(context),
      disabled: body.disabled,
      confirmed: body.confirm === true
    })
    return written(context, refusal, accounts)
  })

  api.put('/logins/:login/label', async (context) => {
    const body = await bodyOf(context, LabelBodySchema)
    if (body === undefined) return invalidBody(context, 'Send { "label": "…" }; empty removes it.')
    return written(context, await setLoginLabel(changeOf(context), body.label), accounts)
  })

  api.delete('/cooldowns', async (context) => {
    const ended = await endCooldowns(
      {
        operator: context.get('session').login,
        provider: context.req.query('provider'),
        model: context.req.query('model')
      },
      readExposureOrThrow,
      deps.now()
    )
    if ('status' in ended) return context.json(ended.body, ended.status)
    return context.json({ ended })
  })
}

/**
 * Adds the budget routes (#366): the budgets, and an editor's change to one project's, or its
 * removal. Each write answers with the budgets after it. A project is URL-encoded in the path, as
 * a label may hold `/`.
 *
 * @param api - the API app
 */
function addBudgets(api: Hono<AdminApiEnv>): void {
  const budgets = (): Promise<unknown> => Promise.resolve({ budgets: readBudgets() })

  api.get('/budgets', async (context) => context.json(await budgets()))

  api.put('/budgets/:project', async (context) => {
    const body = await bodyOf(context, BudgetSchema)
    if (body === undefined) {
      return invalidBody(context, 'Send { "today"?, "week"?, "all"? }: US dollars above 0.')
    }
    const refusal = setBudget({
      login: context.get('session').login,
      project: context.req.param('project'),
      budget: body
    })
    return written(context, refusal, budgets)
  })

  api.delete('/budgets/:project', async (context) => {
    const refusal = setBudget({
      login: context.get('session').login,
      project: context.req.param('project'),
      budget: {}
    })
    return written(context, refusal, budgets)
  })
}

/**
 * Works out the exposure for the cooldowns check, which needs one that applies.
 *
 * @returns the exposure
 * @throws Error when the exposure config can't be applied; the API answers `503`
 */
async function readExposureOrThrow(): Promise<ModelExposureResult> {
  const exposure = await readExposure()
  if (!exposure.ok) throw new Error(exposure.message)
  return exposure
}

/** The methods that only read: any session may send them. */
const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD'])

/** The answer to a viewer's write. */
const EDITOR_ONLY = {
  error: { code: 'editor_only', message: 'Only an editor may change the proxy.' }
} as const

/**
 * Creates the API, to mount at `/admin/api`.
 *
 * @param deps - what it reads with
 * @returns the API app
 */
export function createAdminApi(deps: AdminApiDeps): Hono<AdminApiEnv> {
  const api = new Hono<AdminApiEnv>()
  api.use('*', async (context, next) => {
    const session = deps.sessionOf(context.req.header('cookie'))
    if (session === undefined) return context.json(NOT_SIGNED_IN, HTTP_UNAUTHORIZED)
    // Every write is an editor's: a viewer's is refused before it reaches any route.
    if (!READ_METHODS.has(context.req.method) && session.role !== 'editor') {
      return context.json(EDITOR_ONLY, HTTP_FORBIDDEN)
    }
    context.set('session', session)
    await next()
    return undefined
  })
  api.onError((error, context) => {
    adminLogger.error('Admin request {path} failed: {error}', {
      path: context.req.path,
      error: errorMessage(error)
    })
    return context.json(
      { error: { code: 'read_failed', message: 'The proxy could not do this; see its log' } },
      HTTP_SERVICE_UNAVAILABLE
    )
  })
  api.get('/session', (context) => {
    const { login, role } = context.get('session')
    return context.json({ login, role })
  })
  addRequests(api)
  addPages(api, deps)
  addSettings(api, deps)
  addAliases(api)
  addLogins(api, deps)
  addBudgets(api)
  return api
}
