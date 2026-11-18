/**
 * The admin UI's page routes (#367): `/admin/` answers the app's `index.html` and
 * `/admin/assets/*` its scripts and styles, from {@link AdminAssets}. The pages are public code,
 * open to anyone who reaches the listener, like any open-source front end: what they show comes
 * from `/admin/api/`, which needs a session.
 *
 * @packageDocumentation
 */

import { type AdminAssets, readAdminAsset } from '@proxy/admin/assets'
import { HTTP_FOUND, HTTP_NOT_FOUND, HTTP_SERVICE_UNAVAILABLE } from '@proxy/server/http-status'
import type { Context, Hono } from 'hono'

/** What `/admin/` answers when this build has no pages. */
const NOT_BUILT =
  'The admin pages are not in this build (build them with `pnpm run build`); the API under /admin/api/ works without them.'

/**
 * Answers one asset, or a `404` when there is none at the path.
 *
 * @param context - the request
 * @param assets - the assets
 * @param path - the asset's path under `/admin/`
 * @returns the response
 */
async function answerAsset(context: Context, assets: AdminAssets, path: string): Promise<Response> {
  const asset = await readAdminAsset(assets, path)
  if (asset === undefined) return context.text('Not found', HTTP_NOT_FOUND)
  return context.body(asset.body, { headers: { 'Content-Type': asset.type } })
}

/**
 * Adds the page routes.
 *
 * @param app - the admin app
 * @param assets - the built pages, or `undefined` when this build has none
 */
export function addPageRoutes(app: Hono, assets: AdminAssets | undefined): void {
  app.get('/admin', (context) => context.redirect('/admin/', HTTP_FOUND))
  app.get('/admin/', async (context) =>
    assets === undefined
      ? context.text(NOT_BUILT, HTTP_SERVICE_UNAVAILABLE)
      : answerAsset(context, assets, 'index.html')
  )
  app.get('/admin/assets/*', async (context) =>
    assets === undefined
      ? context.text('Not found', HTTP_NOT_FOUND)
      : answerAsset(context, assets, context.req.path.slice('/admin/'.length))
  )
}
