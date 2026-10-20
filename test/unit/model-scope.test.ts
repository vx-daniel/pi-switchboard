/**
 * The ported `enabledModels` resolver (`src/pi/model-scope.ts`) against pi's own exported one, over
 * the same models and patterns. pi exports only an async resolver that refreshes availability, so
 * the proxy ports the synchronous one; this is the guard that the port still selects what pi
 * selects. A pi upgrade that changes the rules fails here: port the change, then update this.
 */

import { resolveModelScopeWithDiagnostics } from '@earendil-works/pi-coding-agent'
import { resolveModelScope } from '@proxy/pi/model-scope'
import { getRuntime } from '@proxy/pi/registry'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir, offlineProvider } from '../fixtures/agent-dir'

let agentDir: FixtureAgentDir

beforeAll(async () => {
  agentDir = await loadFixtureAgentDir({
    modelsJson: {
      providers: {
        alpha: offlineProvider(
          { id: 'sonnet-4-5', name: 'Sonnet Four Five' },
          { id: 'sonnet-4-5-20250929', name: 'Sonnet Four Five (dated)' },
          { id: 'opus-mock', name: 'Opus Mock', reasoning: true },
          { id: 'shared-id', name: 'Shared on alpha' },
          { id: 'big[1m]', name: 'Bracketed context' }
        ),
        beta: offlineProvider(
          { id: 'shared-id', name: 'Shared on beta' },
          { id: 'alpha/opus-mock', name: 'Gateway copy of opus' },
          { id: 'gpt-mock', name: 'Gamma Turbo' },
          { id: 'big[1m]', name: 'Bracketed context on beta' }
        )
      }
    }
  })
})

afterAll(() => {
  vi.unstubAllEnvs()
  agentDir.remove()
})

/** Each kind of pattern pi resolves, and the edge cases its rules decide. */
const PATTERNS: readonly (readonly [string, readonly string[]])[] = [
  ['exact provider/id', ['alpha/opus-mock']],
  ['case-insensitive', ['ALPHA/Opus-Mock']],
  ['bare ID', ['gpt-mock']],
  ['bare ID on two providers', ['shared-id']],
  ['provider/id that is also a gateway ID', ['beta/alpha/opus-mock']],
  ['provider glob', ['beta/*']],
  ['ID glob', ['*mock*']],
  ['glob with a thinking suffix', ['alpha/*:high']],
  ['bracketed ID, not a glob', ['alpha/big[1m]']],
  ['bracketed ID on two providers', ['big[1m]']],
  ['thinking suffix', ['alpha/opus-mock:high']],
  ['invalid thinking suffix', ['alpha/opus-mock:turbo']],
  ['fuzzy ID', ['opus']],
  ['fuzzy name', ['gamma']],
  ['fuzzy prefers the alias over the dated ID', ['sonnet']],
  ['fuzzy across providers', ['shared']],
  ['no match', ['nothing-like-this']],
  ['blank', ['   ']],
  [
    'several, with duplicates',
    ['alpha/*', 'opus', 'beta/gpt-mock', 'gpt-mock', 'nothing-like-this']
  ]
]

describe('resolveModelScope selects what pi selects', () => {
  // Catches the port drifting from pi: a pattern selecting other models than pi's /scoped-models
  // does, in another order, or reporting other diagnostics.
  test.each(PATTERNS)('%s', async (_case, patterns) => {
    const runtime = getRuntime()
    const pi = await resolveModelScopeWithDiagnostics([...patterns], runtime)
    const port = resolveModelScope(patterns, runtime.getAvailableSnapshot())

    expect({
      models: port.models.map((model) => `${model.provider}/${model.id}`),
      diagnostics: port.diagnostics
    }).toEqual({
      models: pi.scopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`),
      diagnostics: pi.diagnostics.map(({ code, pattern, message }) => ({ code, pattern, message }))
    })
  })
})
