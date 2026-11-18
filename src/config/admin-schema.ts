/**
 * The config file's `adminUi` section (#367): its schema, apart from `src/config/schema.ts`, which
 * imports it and repairs it like the other sections.
 *
 * @packageDocumentation
 */

import type { FieldReaderFactory } from '@proxy/config/field-reader'
import * as z from 'zod'

/**
 * The highest TCP port. `schema.ts` exports the same number as `MAX_PORT` for the package's
 * `./config` entry; this module cannot import it, as `schema.ts` imports this one.
 */
const MAX_TCP_PORT = 65_535

/**
 * A GitHub user login: 1 to 39 letters, digits or single hyphens, starting and ending with a letter
 * or digit, as GitHub allows them.
 */
const GITHUB_LOGIN_PATTERN = '[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}'

/**
 * Who an admin UI role admits (#367): a GitHub login (`alice`), or a team as its organization and
 * slug (`my-org/ops`).
 */
export const GitHubPrincipalSchema = z
  .string()
  .trim()
  .regex(new RegExp(`^${GITHUB_LOGIN_PATTERN}(?:/[A-Za-z0-9][A-Za-z0-9._-]{0,99})?$`, 'u'))
/** Logins and teams a role admits; see {@link GitHubPrincipalSchema}. */
const GitHubPrincipalsSchema = z.array(GitHubPrincipalSchema).readonly()

/**
 * Says whether a URL is an origin only: no path past `/`, no query, no fragment, no credentials.
 *
 * @remarks
 * Zod runs a refinement even when the URL check before it failed, so a value that is no URL at all
 * reaches here and must be refused, not thrown on: a throw would escape `safeParse` and stop the
 * config from being repaired.
 *
 * @param value - the value, a URL or not
 * @returns whether it parses as a URL and names an origin
 */
function isOriginOnly(value: string): boolean {
  const url = URL.parse(value)
  if (url === null) return false
  return (
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === '' &&
    url.username === '' &&
    url.password === ''
  )
}

/** An `http` or `https` origin, as the admin UI's own address (`https://admin.example.com`). */
const HttpOriginSchema = z
  .url({ protocol: /^https?$/u })
  .refine(isOriginOnly, 'must be an origin, without a path')

/** The admin UI's address: an origin, or `''` for the listener's own (`http://<host>:<port>`). */
const AdminPublicUrlSchema = z.union([z.literal(''), HttpOriginSchema])

/** GitHub's web address: `https://github.com`, or a GitHub Enterprise Server's. */
const GitHubUrlSchema = z
  .url({ protocol: /^https$/u })
  .refine(isOriginOnly, 'must be an origin, without a path')

/**
 * The admin web UI (#367): its own listener, off by default, signed in with the operator's own
 * GitHub App. The App's client and the session key are never here: they come from the environment
 * (`src/config/admin.ts`).
 */
export const AdminUiConfigSchema = z.object({
  /** Start the admin listener with the headless server. */
  enabled: z.boolean(),
  /** Its bind address; loopback by default. */
  host: z.string().trim().min(1),
  /** Its port, apart from the API's. */
  port: z.int().min(1).max(MAX_TCP_PORT),
  /** The address operators open, for GitHub's callback; `''` is the listener's own. */
  publicUrl: AdminPublicUrlSchema,
  /** GitHub's web address. */
  githubUrl: GitHubUrlSchema,
  /** Logins and teams that may change settings. */
  editors: GitHubPrincipalsSchema,
  /** Logins and teams that may only read. */
  viewers: GitHubPrincipalsSchema
})
/** The `adminUi` section: see {@link AdminUiConfigSchema}. */
export type AdminUiConfig = z.infer<typeof AdminUiConfigSchema>

/**
 * Keeps the logins and teams a role list may hold, dropping the rest.
 *
 * @param value - the list's raw value
 * @returns its valid entries; empty when it is not a list
 */
function validPrincipals(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((principal: unknown) => {
    const parsed = GitHubPrincipalSchema.safeParse(principal)
    return parsed.success ? [parsed.data] : []
  })
}

/** The `adminUi` section when the config file leaves it out: off, on loopback, nobody admitted. */
export const ADMIN_UI_DEFAULTS: AdminUiConfig = {
  enabled: false,
  host: '127.0.0.1',
  port: 4142,
  publicUrl: '',
  githubUrl: 'https://github.com',
  editors: [],
  viewers: []
}

/**
 * Repairs a port: a finite number to the nearest one in range, anything else to the default.
 *
 * @param value - the field's raw value
 * @returns a port
 */
function clampPort(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return ADMIN_UI_DEFAULTS.port
  return Math.max(1, Math.min(MAX_TCP_PORT, Math.round(value)))
}

/**
 * Reads the `adminUi` section, repairing invalid fields.
 *
 * @param raw - the section's raw value
 * @param corrected - collects the paths of repaired fields; appended to
 * @param readerFor - `schema.ts`'s field reader factory
 * @returns the valid section
 */
export function readAdminUi(
  raw: unknown,
  corrected: string[],
  readerFor: FieldReaderFactory
): AdminUiConfig {
  const field = readerFor<keyof AdminUiConfig>(raw, corrected, 'adminUi')
  const fields = AdminUiConfigSchema.shape
  const defaults = ADMIN_UI_DEFAULTS
  return {
    enabled: field('enabled', fields.enabled, () => defaults.enabled),
    host: field('host', fields.host, () => defaults.host),
    port: field('port', fields.port, clampPort),
    publicUrl: field('publicUrl', fields.publicUrl, () => defaults.publicUrl),
    githubUrl: field('githubUrl', fields.githubUrl, () => defaults.githubUrl),
    editors: field('editors', fields.editors, validPrincipals),
    viewers: field('viewers', fields.viewers, validPrincipals)
  }
}
