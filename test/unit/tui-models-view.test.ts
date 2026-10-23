import type { Api, Model } from '@earendil-works/pi-ai'
import { stripTerminalSequences } from '@earendil-works/pi-tui'
import type { ExposedModel } from '@proxy/openai/model-exposure'
import { modelsRows, type ModelsView } from '@proxy/tui/models-view'
import { describe, expect, test } from 'vite-plus/test'

/**
 * Builds an exposed model without reasoning.
 *
 * @param id - its model ID, under the `alpha` provider
 * @returns the exposed model
 */
function exposed(id: string): ExposedModel {
  const model: Model<Api> = {
    id,
    name: id,
    api: 'openai-completions',
    provider: 'alpha',
    baseUrl: 'http://127.0.0.1:9/v1',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100
  }
  return { publicId: id, canonicalId: `alpha/${id}`, model, provider: 'alpha', login: 'alpha' }
}

/**
 * Renders the view as plain text.
 *
 * @param view - what the view shows
 * @param height - rows available
 * @returns the rows, without colour codes or trailing spaces
 */
function rendered(view: ModelsView, height: number): string[] {
  return modelsRows(view, height, 0).map((row) => stripTerminalSequences(row).trimEnd())
}

describe('the console Models view', () => {
  // Catches a selection on an alias drawn off screen when many models are exposed: the operator
  // would edit an alias they can't see.
  test('scrolls to keep the selected alias on screen', () => {
    const models = Array.from({ length: 20 }, (_, position) => exposed(`m${String(position)}`))
    const rows = rendered(
      { models, aliases: { reviewer: 'alpha/m1' }, diagnostics: [], selected: 20 },
      6
    )

    expect(rows).toHaveLength(6)
    expect(rows.at(-1)).toMatch(/^› reviewer +alpha\/m1$/u)
  })

  // Catches an alias the proxy leaves out shown as if it worked: its diagnostic is under it.
  test("shows each alias's targets, efforts, fallback classes and diagnostics", () => {
    const rows = rendered(
      {
        models: [exposed('m0')],
        aliases: {
          'builder-high': {
            targets: [{ model: 'alpha/m0', reasoningEffort: 'none' }, 'alpha/gone'],
            fallbackOn: ['rate_limit']
          }
        },
        diagnostics: [
          {
            code: 'target-not-exposed',
            alias: 'builder-high',
            target: 'alpha/gone',
            message: 'not exposed'
          }
        ],
        selected: 0
      },
      10
    )

    expect(rows.slice(2)).toEqual([
      expect.stringMatching(/^ {2}alias +targets$/u) as unknown,
      expect.stringMatching(
        /^ {2}builder-high +alpha\/m0 @none › alpha\/gone {2}on rate_limit$/u
      ) as unknown,
      '      target-not-exposed: not exposed',
      '  + New alias…'
    ])
  })
})
