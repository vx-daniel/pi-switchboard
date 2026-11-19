/**
 * The admin UI's pages served by the admin listener (#367), from a build directory as on Node: the
 * app's `index.html` and its assets, with the listener's headers, and nothing else on disk.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type AdminAppOptions, createAdminApp } from '@proxy/admin/app'
import { type AdminAssets, directoryAssets } from '@proxy/admin/assets'
import { resolveAdminUi } from '@proxy/config/admin'
import { ADMIN_UI_DEFAULTS } from '@proxy/config/admin-schema'
import type { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test'

import { testConfig } from '../helpers'

const HOST = '127.0.0.1:4142'
const ENV = {
  PI_SWITCHBOARD_GITHUB_CLIENT_ID: 'Iv1.notarealclient',
  PI_SWITCHBOARD_GITHUB_CLIENT_SECRET: 'notarealsecret-client-secret',
  PI_SWITCHBOARD_ADMIN_SESSION_KEY: 'notarealsecret-session-key-0123456789abcdef'
}
const INDEX = '<!doctype html><script type="module" src="/admin/assets/index-abc.js"></script>'

let build: string
let assets: AdminAssets | undefined

beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), 'admin-pages-'))
  build = join(root, 'admin-ui')
  mkdirSync(join(build, 'assets'), { recursive: true })
  writeFileSync(join(build, 'index.html'), INDEX)
  writeFileSync(join(build, 'assets', 'index-abc.js'), 'console.log(1)')
  writeFileSync(join(root, 'secret.txt'), 'notarealsecret-outside-the-build')
  assets = await directoryAssets(build)
})

afterAll(() => {
  rmSync(join(build, '..'), { recursive: true, force: true })
})

/**
 * Creates the admin app with these assets.
 *
 * @param pages - the built pages, or `undefined` for a build without them
 * @returns the app
 */
function adminApp(pages: AdminAppOptions['assets']): Hono {
  const settings = resolveAdminUi({ ...ADMIN_UI_DEFAULTS, enabled: true, viewers: ['alice'] }, ENV)
  const { signIn } = settings
  if (signIn === undefined) throw new Error('sign-in should be configured')
  return createAdminApp({
    settings: { ...settings, signIn },
    server: { running: testConfig(), overrides: {}, proxyAuth: false },
    assets: pages
  })
}

/**
 * Asks the admin app for a path, as a browser on the admin UI would.
 *
 * @param app - the admin app
 * @param path - the path
 * @returns the response
 */
function get(app: Hono, path: string): Promise<Response> {
  return Promise.resolve(app.request(path, { headers: { host: HOST } }))
}

describe('admin pages', () => {
  // Catches the app's page not served, served as another type, or without the listener's CSP.
  test("/admin/ answers the app's index.html under the admin UI's headers", async () => {
    const response = await get(adminApp(assets), '/admin/')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'")
    expect(await response.text()).toBe(INDEX)
  })

  // Catches a script served with a type the browser refuses under `nosniff`.
  test('serves an asset with its type', async () => {
    const response = await get(adminApp(assets), '/admin/assets/index-abc.js')

    expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(await response.text()).toBe('console.log(1)')
  })

  // Catches a path reaching past the build onto the disk.
  test.each([
    '/admin/assets/../../secret.txt',
    '/admin/assets/%2e%2e/%2e%2e/secret.txt',
    '/admin/assets/missing.js'
  ])('%s answers 404', async (path) => {
    const response = await get(adminApp(assets), path)

    expect(response.status).toBe(404)
    expect(await response.text()).not.toContain('notarealsecret')
  })

  // Catches `/admin` without its slash left unanswered, which is what someone types.
  test('/admin redirects to /admin/', async () => {
    const response = await get(adminApp(assets), '/admin')

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/admin/')
  })

  // Catches a build without pages answering a blank page instead of why.
  test('says so when this build has no pages', async () => {
    const response = await get(adminApp(undefined), '/admin/')

    expect(response.status).toBe(503)
    expect(await response.text()).toContain('pnpm run build')
  })

  // Catches the build directory missing read as an error that stops the listener.
  test('a missing build directory is no pages', async () => {
    expect(await directoryAssets(join(build, 'nothing-here'))).toBeUndefined()
  })
})
