/**
 * Runs before every unit and integration test file (the `offline` project in vite.config.ts).
 *
 * No offline test may see the developer's pi login or provider credentials: they make results
 * depend on whose machine runs them, and a test that resolves a real OAuth credential can refresh
 * it, which rotates the refresh token under every other copy of that login. So each file starts
 * with pi pointed at an empty agent directory and with every credential-shaped environment
 * variable removed. A test that needs models loads them with `loadFixtureAgentDir`
 * (`test/fixtures/agent-dir.ts`); `test/conformance` (the `live` project) is the only place that
 * uses a real login.
 *
 * Nor may one reach the network: a call to anything but this machine fails at once. pi refreshes
 * provider catalogs from `pi.dev` after a login, which made a test's time depend on pi.dev's
 * latency; offline, pi keeps its built-in catalog. On this machine, the proxy's default port is
 * refused too: the extension probes it when `proxy-config.json` is absent or unparseable, and the
 * developer's own proxy may be listening there (#257).
 *
 * @packageDocumentation
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_CONFIG } from '@proxy/config/schema'
import { afterAll } from 'vite-plus/test'

/**
 * What pi reads credentials from (`pi-ai/dist/env-api-keys.js`): `<PROVIDER>_API_KEY` and
 * `*_TOKEN` variables, plus ambient cloud credentials that are not key-shaped. Amazon Bedrock
 * counts as configured from `AWS_PROFILE`, `AWS_BEARER_TOKEN_BEDROCK`, container or web-identity
 * variables; Vertex from `GOOGLE_APPLICATION_CREDENTIALS` (or the gcloud ADC file) plus
 * `GOOGLE_CLOUD_PROJECT`/`GCLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION`; Anthropic federation from
 * `ANTHROPIC_*`. Whole prefixes go, so a variable pi adds later in those families goes too.
 * `test/unit/offline-isolation.test.ts` fails if any provider still counts as configured.
 */
const CREDENTIAL_VARIABLE =
  /(?:_API_KEY|_TOKEN|_ACCESS_KEY|_ACCESS_KEY_ID|_SECRET_ACCESS_KEY)$|^(?:ANTHROPIC|AWS|AZURE|GOOGLE|GCLOUD|CLOUDSDK)_/

// Removed for good, not stubbed: `vi.unstubAllEnvs()` in a test would put a stubbed one back.
for (const variableName of Object.keys(process.env)) {
  if (CREDENTIAL_VARIABLE.test(variableName)) Reflect.deleteProperty(process.env, variableName)
}

/** The empty agent directory pi is pointed at; deleted after the file's tests. */
const emptyAgentDir = mkdtempSync(join(tmpdir(), 'pi-proxy-offline-'))
process.env.PI_CODING_AGENT_DIR = emptyAgentDir

/** Hosts an offline test may reach: the mock provider, the recorder, the proxy itself. */
const LOOPBACK: Readonly<Record<string, true>> = {
  '127.0.0.1': true,
  'localhost': true,
  '[::1]': true,
  '::1': true
}

/**
 * The proxy's default port, refused on loopback too: whatever listens there is the developer's,
 * not the test's. Tests that start a proxy pick a free port.
 */
const DEVELOPER_PORT = String(DEFAULT_CONFIG.port)

/** The fetch the offline guard passes loopback calls to. */
const realFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (LOOPBACK[url.hostname] !== true) {
    return Promise.reject(new TypeError(`offline test: no network access to ${url.hostname}`))
  }
  if (url.port === DEVELOPER_PORT) {
    return Promise.reject(new TypeError(`offline test: no access to the default port ${url.port}`))
  }
  return realFetch(input, init)
}

afterAll(() => {
  rmSync(emptyAgentDir, { recursive: true, force: true })
})
