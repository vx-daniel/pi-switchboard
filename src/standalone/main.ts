/**
 * Entry point of the standalone binary (`bun build --compile`, see `scripts/build-binary.ts`). The
 * npm package runs `src/index.ts` on Node; this file first repeats the setup pi's own Bun binary
 * does (pi-coding-agent `dist/bun/`), because a compiled binary holds only what the bundler could
 * follow:
 *
 * - pi-ai loads its OAuth flows and its Bedrock provider through variable import specifiers, which
 *   no bundler follows. Unless they are registered statically, the binary starts and serves, then
 *   fails every request once an OAuth access token needs refreshing (`Cannot find module
 *   './anthropic.js'`, seen in #61's spike).
 * - A compiled Bun binary sees an empty `process.env` inside some sandboxes (oven-sh/bun#27802). On
 *   Linux it is recovered from `/proc/self/environ` before any module reads it: losing
 *   `PI_PROXY_AUTH_TOKEN` that way would turn proxy auth off.
 *
 * The imports after the restore are dynamic because static imports are evaluated before this
 * module's body runs; their specifiers are literals, so the bundler still embeds them.
 */

import { readFileSync } from 'node:fs'

function restoreSandboxEnv(): void {
  if (Object.keys(process.env).length > 0) return
  let environ: string
  try {
    environ = readFileSync('/proc/self/environ', 'utf-8')
  } catch {
    // Not Linux, or not readable: nothing to recover from.
    return
  }
  for (const assignment of environ.split('\0')) {
    const separator = assignment.indexOf('=')
    if (separator > 0) {
      process.env[assignment.slice(0, separator)] = assignment.slice(separator + 1)
    }
  }
}

restoreSandboxEnv()

const { registerBunOAuthFlows } = await import('@earendil-works/pi-ai/bun-oauth')
const { bedrockProviderModule } = await import('@earendil-works/pi-ai/bedrock-provider')
const { setBedrockProviderModule } = await import('@earendil-works/pi-ai/compat')
registerBunOAuthFlows()
setBedrockProviderModule(bedrockProviderModule)

await import('@proxy/index')
