/**
 * Starting the admin listener (#367), apart from the API's, and refusing to when it would be
 * unsafe (constitution principle III).
 *
 * @packageDocumentation
 */

import { type ServerType, serve } from '@hono/node-server'
import { createAdminApp } from '@proxy/admin/app'
import { type AdminUiSettings, adminUiProblems } from '@proxy/config/admin'
import { proxyLogger } from '@proxy/logging'
import { untilListening } from '@proxy/server/startup'

/** Logger for the admin listener. */
const adminLogger = proxyLogger('admin')

/**
 * Says whether the headless server may start with these admin UI settings, logging each reason
 * it may not at `fatal`.
 *
 * @param settings - the resolved admin UI settings
 * @returns `true` when the admin UI is off or may start; `false` when the proxy must not start
 */
export function adminUiMayStart(settings: AdminUiSettings): boolean {
  const problems = adminUiProblems(settings)
  for (const problem of problems) {
    adminLogger.fatal('Refusing to start: the admin UI is on, but {problem}', { problem })
  }
  return problems.length === 0
}

/**
 * Starts the admin listener.
 *
 * @param settings - the resolved settings; sign-in configured ({@link adminUiMayStart})
 * @returns the listening server
 * @throws Error when sign-in is not configured, or the listener cannot listen (`EADDRINUSE`)
 */
export async function openAdminServer(settings: AdminUiSettings): Promise<ServerType> {
  const { signIn } = settings
  if (signIn === undefined) throw new Error('The admin UI needs sign-in configured to start')
  const app = createAdminApp({ settings: { ...settings, signIn } })
  const server = serve({ fetch: app.fetch, port: settings.port, hostname: settings.host })
  await untilListening(server)
  adminLogger.info('Admin UI at {publicUrl}, listening on {host}:{port}', {
    publicUrl: settings.publicUrl,
    host: settings.host,
    port: settings.port
  })
  return server
}
