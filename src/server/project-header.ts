/**
 * `X-Switchboard-Project` (#366): the project a chat request's usage is counted under, for the
 * stats, `GET /v1/switchboard/usage` and the budgets.
 *
 * @remarks
 * The label is the client's word, so it is read only while proxy auth asks for a token: without
 * one, any program that can reach the proxy could charge its traffic to any project. With auth
 * off the header is ignored (the request counts under no project) and the log says why, once per
 * server. With auth on, a label that is not one ({@link ProjectLabelSchema}) is refused with a
 * `400` naming the header, never cut or cleaned. #177 kept client-supplied keys out of usage; this
 * is the one exception, bounded by the label's shape and by the stats' cap on distinct projects a
 * minute.
 *
 * @packageDocumentation
 */

import { ProjectLabelSchema } from '@proxy/config/projects'
import { proxyLogger } from '@proxy/logging'
import { invalidRequest } from '@proxy/server/errors'
import { HTTP_BAD_REQUEST } from '@proxy/server/http-status'
import type { ProxyAuthSwitch } from '@proxy/server/proxy-auth'
import type { ProxyEnv } from '@proxy/server/types'
import type { MiddlewareHandler } from 'hono'

/** Logger for the header's decisions. */
const httpLogger = proxyLogger('server', 'http')

/** The header that names a request's project. */
const PROJECT_HEADER = 'X-Switchboard-Project'

/**
 * Creates the middleware that reads a chat request's project.
 *
 * @param proxyAuth - the auth the server applies now; the label counts only while it asks for a
 *   token
 * @returns the middleware: sets `project`, or answers `400` for a label that is not one
 */
export function projectHeaderMiddleware(proxyAuth: ProxyAuthSwitch): MiddlewareHandler<ProxyEnv> {
  let toldIgnored = false
  return async (context, next) => {
    const sent = context.req.header(PROJECT_HEADER)
    if (sent === undefined) return next()
    if (proxyAuth.current().kind === 'off') {
      if (!toldIgnored) {
        toldIgnored = true
        httpLogger.warn(
          'Ignoring {header}: proxy auth is off, so any client could claim any project. Set a token to count usage by project',
          { header: PROJECT_HEADER }
        )
      }
      return next()
    }
    const label = ProjectLabelSchema.safeParse(sent)
    if (!label.success) {
      httpLogger.warn('Rejected a request with an invalid {header} header', {
        header: PROJECT_HEADER
      })
      return context.json(
        invalidRequest(
          `The ${PROJECT_HEADER} header must be 1 to 64 characters: a letter or digit, then letters, digits and ._:/@-`
        ),
        HTTP_BAD_REQUEST
      )
    }
    context.set('project', label.data)
    return next()
  }
}
