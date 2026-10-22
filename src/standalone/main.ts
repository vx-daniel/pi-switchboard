/**
 * Entry point of the standalone binary (`bun build --compile`, see `scripts/build-binary.ts`). The
 * npm package runs `src/index.ts` on Node; this file first repeats the setup pi's own Bun binary
 * does (pi-coding-agent `dist/bun/`), because a compiled binary holds only what the bundler could
 * follow:
 *
 * - The environment is recovered when a sandbox emptied it (`@proxy/standalone/sandbox-env`).
 * - pi-ai loads its OAuth flows and its Bedrock provider through variable import specifiers, which
 *   no bundler follows. Unless they are registered statically, the binary starts and serves, then
 *   fails every request once an OAuth access token needs refreshing (`Cannot find module
 *   './anthropic.js'`, seen in #61's spike). `test/binary/` holds this to account.
 *
 * The imports after the restore are dynamic because static imports are evaluated before this
 * module's body runs, so they would read the environment before it is recovered. Their specifiers
 * are literals, so the bundler still embeds them.
 *
 * @packageDocumentation
 */

import { restoreSandboxEnv } from '@proxy/standalone/sandbox-env'

restoreSandboxEnv()

/** pi-ai's Bedrock provider, embedded so `setBedrockProviderModule` need not load it by variable path. */
const { bedrockProviderModule } = await import('@earendil-works/pi-ai/bedrock-provider')
;(await import('@earendil-works/pi-ai/bun-oauth')).registerBunOAuthFlows()
;(await import('@earendil-works/pi-ai/compat')).setBedrockProviderModule(bedrockProviderModule)

await import('@proxy/index')
