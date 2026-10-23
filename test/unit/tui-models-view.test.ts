import type { Api, Model } from '@earendil-works/pi-ai'
import { stripTerminalSequences } from '@earendil-works/pi-tui'
import type { ExposedModel } from '@proxy/openai/model-exposure'
import { modelsItemAt, modelsRows, type ModelsView, modelsViewData } from '@proxy/tui/models-view'
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
    const view = {
      models,
      aliases: { reviewer: 'alpha/m1' },
      diagnostics: [],
      families: [],
      selected: 20
    }

    const rows = rendered(view, 6)

    expect(rows).toHaveLength(6)
    expect(rows.at(-1)).toMatch(/^› reviewer +alpha\/m1$/u)
    // Shorter than the headings: the selected row alone.
    expect(rendered(view, 1)).toEqual([expect.stringMatching(/^› reviewer/u)])
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
        families: [],
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

  // Catches a family alias shown without what it serves now, a pin shown as if it followed the
  // newest, or a hidden newer model left unmentioned (#231).
  test('shows what each family alias resolves to, its pin and a hidden newer model', () => {
    const family = 'anthropic/claude-opus'
    const rows = rendered(
      {
        models: [],
        aliases: {
          'opus-latest': { family, reasoningEffort: 'high' },
          'opus-steady': { family, pin: 'anthropic/claude-opus-5' }
        },
        diagnostics: [],
        families: [
          {
            alias: 'opus-latest',
            position: 0,
            family,
            pin: null,
            resolved: 'anthropic/claude-opus-5-5',
            newest: 'anthropic/claude-opus-5-5',
            newerHidden: 'anthropic/claude-opus-6'
          },
          {
            alias: 'opus-steady',
            position: 0,
            family,
            pin: 'anthropic/claude-opus-5',
            resolved: 'anthropic/claude-opus-5',
            newest: 'anthropic/claude-opus-5-5',
            newerHidden: null
          }
        ],
        selected: 0
      },
      10
    )

    expect(rows.slice(2, 4)).toEqual([
      expect.stringMatching(
        /^› opus-latest +anthropic\/claude-opus → claude-opus-5-5 \(newest\) · newer hidden: claude-opus-6 @high$/u
      ) as unknown,
      expect.stringMatching(
        /^ {2}opus-steady +anthropic\/claude-opus pinned: claude-opus-5 · newest: claude-opus-5-5$/u
      ) as unknown
    ])
  })

  // Catches a selection left past the end after a delete opening nothing, or the wrong row.
  test('a selection past the end acts on the new-alias row', () => {
    const data = {
      models: [exposed('m0')],
      aliases: { only: 'alpha/m0' },
      diagnostics: [],
      families: []
    }

    expect(modelsItemAt(data, 1)).toMatchObject({ kind: 'alias', name: 'only' })
    expect(modelsItemAt(data, 9)).toEqual({ kind: 'new' })
  })

  // Catches an invalid exposure config shown as an empty list, which looks like no models at all.
  test('says why when the exposure config is invalid', () => {
    const data = modelsViewData({ exposure: undefined, aliases: {}, exposed: 'duplicate prefix' })

    expect(rendered({ ...data, selected: 0 }, 5)).toEqual([
      '  Models unavailable: duplicate prefix'
    ])
  })
})
