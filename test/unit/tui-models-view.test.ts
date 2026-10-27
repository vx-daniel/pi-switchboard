import type { Api, Model } from '@earendil-works/pi-ai'
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import type { ExposedModel } from '@proxy/openai/model-exposure'
import { clearAllCooldowns, startCooldown } from '@proxy/pi/cooldowns'
import {
  modelsItemAt,
  modelsItems,
  modelsRows,
  type ModelsView,
  modelsViewData
} from '@proxy/tui/models-view'
import { afterEach, describe, expect, test } from 'vite-plus/test'

/** A view too narrow for the ALIASES box beside the matrix: it goes under it. */
const STACKED = 100
/** A view wide enough for the ALIASES box beside the matrix. */
const SIDE_BY_SIDE = 160

/**
 * Builds an exposed model.
 *
 * @param id - its model ID
 * @param provider - its provider
 * @param reasoning - whether it reasons, which gives it efforts past `none`
 * @returns the exposed model
 */
function exposed(id: string, provider = 'alpha', reasoning = false): ExposedModel {
  const model: Model<Api> = {
    id,
    name: id,
    api: 'openai-completions',
    provider,
    baseUrl: 'http://127.0.0.1:9/v1',
    reasoning,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100
  }
  return { publicId: id, canonicalId: `${provider}/${id}`, model, provider, login: provider }
}

/**
 * Renders the view as plain text.
 *
 * @param view - what the view shows
 * @param height - rows available
 * @param width - columns available
 * @returns the rows, without colour codes or trailing spaces
 */
function rendered(view: ModelsView, height: number, width = STACKED): string[] {
  return modelsRows(view, { height, width }, 0).rows.map((row) =>
    stripTerminalSequences(row).trimEnd()
  )
}

/**
 * Reads a box's content off the plain rows of a stacked view: the rows between its borders,
 * without them.
 *
 * @param rows - the plain rows
 * @param title - the box's title
 * @returns the box's lines, without trailing spaces
 */
function boxLines(rows: readonly string[], title = 'ALIASES'): string[] {
  const top = rows.findIndex((row) => row.startsWith(`╭─ ${title}`))
  const bottom = rows.findIndex((row, rowIndex) => rowIndex > top && row.startsWith('╰'))
  return rows.slice(top + 1, bottom).map((row) => row.slice(2, -1).trimEnd())
}

describe('the console Models view', () => {
  afterEach(() => {
    clearAllCooldowns()
  })

  // Catches a selection drawn off screen when many models are exposed: the operator would edit an
  // alias they can't see, or press Enter on a model scrolled out of the matrix.
  test('scrolls the matrix and the box to keep the selection on screen', () => {
    const models = Array.from({ length: 20 }, (_, position) => exposed(`m${String(position)}`))
    const data = { models, aliases: { reviewer: 'alpha/m1' }, diagnostics: [], families: [] }

    const onAlias = rendered({ ...data, selected: 20 }, 14)
    const onLastModel = rendered({ ...data, selected: 19 }, 14)

    expect(onAlias).toHaveLength(14)
    expect(boxLines(onAlias)).toContainEqual(expect.stringMatching(/^› reviewer +alpha\/m1$/u))
    expect(onLastModel).toContainEqual(expect.stringMatching(/^› m19 /u))
  })

  // Catches the frame saying how many models there are while the matrix is scrolled past some,
  // so the operator can't tell the list goes on, or a wrong count of those on screen.
  test.each([STACKED, SIDE_BY_SIDE])(
    'says how many models show while the matrix is scrolled, %d columns',
    (width) => {
      const models = Array.from({ length: 20 }, (_, position) => exposed(`m${String(position)}`))
      const data = { models, aliases: {}, diagnostics: [], families: [] }

      const scrolled = modelsRows({ ...data, selected: 0 }, { height: 20, width }, 0)
      const shown = scrolled.rows.filter((row) => /^[› ] m\d/u.test(stripTerminalSequences(row)))
      expect(scrolled.note).toBe(`${String(shown.length)} of 20 models shown · ↑↓`)
      expect(shown.length).toBeLessThan(20)
      expect(modelsRows({ ...data, selected: 0 }, { height: 40, width }, 0).note).toBe('')
    }
  )

  // Catches a screen too short for the matrix and the box together showing the part without the
  // selection, or neither: below ten rows the part with the selection takes them all.
  test('on a very short view, only the part with the selection shows', () => {
    const models = Array.from({ length: 20 }, (_, position) => exposed(`m${String(position)}`))
    const data = { models, aliases: { reviewer: 'alpha/m1' }, diagnostics: [], families: [] }

    const onAlias = rendered({ ...data, selected: 20 }, 6)
    const onModel = rendered({ ...data, selected: 12 }, 6)

    expect(onAlias[0]).toMatch(/^╭─ ALIASES 1 /u)
    expect(onAlias).toContainEqual(expect.stringMatching(/^│ › reviewer/u))
    expect(onModel.some((row) => row.includes('ALIASES'))).toBe(false)
    expect(onModel).toContainEqual(expect.stringMatching(/^› m12 /u))
  })

  // Catches the matrix's groups and the selection's order disagreeing: with providers interleaved
  // in the list, Enter would edit a model other than the one marked.
  test('groups the models by provider, and the selection moves in the same order', () => {
    const data = {
      models: [exposed('a1'), exposed('b1', 'beta'), exposed('a2')],
      aliases: {},
      diagnostics: [],
      families: []
    }

    const rows = rendered({ ...data, selected: 1 }, 20)

    expect(
      modelsItems(data).map((listed) => (listed.kind === 'model' ? listed.model.publicId : ''))
    ).toEqual(['a1', 'a2', 'b1', ''])
    expect(rows.slice(0, 6)).toEqual([
      `  ${'model'.padEnd(30)} none  min   low   med   high  xhi   max`,
      '  alpha  2 models',
      expect.stringMatching(/^ {2}a1 /u),
      expect.stringMatching(/^› a2 /u),
      '',
      '  beta  1 model'
    ])
  })

  // Catches a dot under an effort the model doesn't run at as asked, or none under one it does.
  test('marks each effort a model supports', () => {
    const rows = rendered(
      {
        models: [exposed('plain'), exposed('thinker', 'alpha', true)],
        aliases: {},
        diagnostics: [],
        families: [],
        selected: 0
      },
      10
    )
    const cellsOf = (name: string): string =>
      (rows.find((row) => row.slice(2).startsWith(`${name} `)) ?? '').slice(32, 74)

    expect(cellsOf('plain')).toBe(`  ●   ${'  ·   '.repeat(5)}  ·`)
    // A reasoning model runs from off to high; xhigh and max only when its definition maps them.
    expect(cellsOf('thinker')).toBe(`${'  ●   '.repeat(5)}  ·     ·`)
  })

  // Catches a cooling model shown as ready, or a narrow view cutting the countdown before the
  // reason.
  test('shows a model’s cooldown after its efforts, the seconds first', () => {
    const model = exposed('hot')
    startCooldown({ provider: 'alpha', canonicalId: 'alpha/hot' }, 'unavailable', 42_000, 0)
    const view = { models: [model], aliases: {}, diagnostics: [], families: [], selected: 0 }

    expect(rendered(view, 10, 120)).toContainEqual(
      expect.stringMatching(/hot .* cooling 42s unavailable$/u)
    )
    expect(rendered(view, 10, 86)).toContainEqual(expect.stringMatching(/ cooling 42s/u))
  })

  // Catches a long countdown cut at the narrowest side-by-side view (#262 review: a 180 s backoff
  // read `cooling 18…`), or minutes shown as a pile of seconds.
  test.each([
    [180_000, 'cooling 3m00s'],
    [(12 * 24 + 23) * 3_600_000, 'cooling 12d23h']
  ])('beside the matrix at 151 columns, a %i ms cooldown reads %s whole', (waitMs, countdown) => {
    startCooldown({ provider: 'alpha', canonicalId: 'alpha/hot' }, 'unavailable', waitMs, 0)
    const view = {
      models: [exposed('hot')],
      aliases: {},
      diagnostics: [],
      families: [],
      selected: 0
    }

    const row = rendered(view, 10, 151).find((line) => line.startsWith('› hot '))

    expect(row).toContain(` ${countdown} `)
  })

  // Catches a row wider or narrower than the view on either side of the box's move, which the
  // alt screen cuts without a word.
  test.each([
    [40, 12],
    [64, 20],
    [STACKED, 30],
    [150, 30],
    [151, 30],
    [SIDE_BY_SIDE, 8]
  ])('every row is exactly %i columns', (width, height) => {
    const view = {
      models: Array.from({ length: 12 }, (_, position) =>
        exposed(`model-with-a-long-name-${String(position)}`, `provider-${String(position % 3)}`)
      ),
      aliases: { reviewer: { targets: ['provider-0/x', 'provider-1/y'], fallbackOn: [] } },
      diagnostics: [],
      families: [],
      selected: 3
    }
    const { rows } = modelsRows(view, { height, width }, 0)

    expect(rows.length).toBeLessThanOrEqual(height)
    for (const row of rows) expect(visibleWidth(row)).toBe(width)
  })

  // Catches the box left under the matrix on a wide view, or put beside it on a narrow one.
  test('the ALIASES box sits beside the matrix from 151 columns, under it below', () => {
    const view = {
      models: [exposed('m0')],
      aliases: { only: 'alpha/m0' },
      diagnostics: [],
      families: [],
      selected: 0
    }

    expect(rendered(view, 10, 151)[0]).toMatch(/^ {2}model .* ╭─ ALIASES 1 /u)
    expect(rendered(view, 10, 150)[0]).not.toContain('ALIASES')
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
      20
    )

    expect(boxLines(rows)).toEqual([
      '  alias            targets',
      '  builder-high     alpha/m0 @none › alpha/gone  on rate_limit',
      '    target-not-exposed: not exposed',
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
      20,
      120
    )

    expect(boxLines(rows).slice(1, 3)).toEqual([
      expect.stringMatching(
        /^› opus-latest +anthropic\/claude-opus → claude-opus-5-5 \(newest\) · newer hidden: claude-opus-6 @high$/u
      ) as unknown,
      expect.stringMatching(
        /^ {2}opus-steady +anthropic\/claude-opus pinned: claude-opus-5 · newest: claude-opus-5-5$/u
      ) as unknown
    ])
  })

  // Catches the built-in aliases mixed in with the operator's (which are theirs and which the
  // system's must be plain), the new-alias row pushed under them, or the selection skipping them.
  test('the built-in -latest aliases have their own LATEST box, after ALIASES', () => {
    const family = 'anthropic/claude-sonnet'
    const view: ModelsView = {
      models: [exposed('m0')],
      aliases: { reviewer: 'alpha/m0' },
      latest: { 'sonnet-latest': { family } },
      diagnostics: [],
      families: [
        {
          alias: 'sonnet-latest',
          position: 0,
          family,
          pin: null,
          resolved: 'anthropic/claude-sonnet-5-5',
          newest: 'anthropic/claude-sonnet-5-5',
          newerHidden: null
        }
      ],
      selected: 3
    }
    const rows = rendered(view, 30, 120)

    expect(modelsItems(view).map((listed) => listed.kind)).toEqual([
      'model',
      'alias',
      'new',
      'latest'
    ])
    expect(rows).toContainEqual(expect.stringMatching(/^╭─ ALIASES 1 ─/u))
    expect(rows).toContainEqual(expect.stringMatching(/^╭─ LATEST 1 ─/u))
    expect(boxLines(rows)).toEqual([
      expect.stringMatching(/^ {2}alias +targets$/u),
      expect.stringMatching(/^ {2}reviewer +alpha\/m0$/u),
      '  + New alias…'
    ])
    expect(boxLines(rows, 'LATEST')).toEqual([
      expect.stringMatching(/^ {2}alias +family$/u),
      expect.stringMatching(
        /^› sonnet-latest +anthropic\/claude-sonnet → claude-sonnet-5-5 \(newest\)$/u
      )
    ])
  })

  // Catches a selected built-in alias squeezed off a short screen by the ALIASES box above it.
  test('a short view keeps a selected built-in alias on screen', () => {
    const latest = Object.fromEntries(
      Array.from({ length: 6 }, (_, position) => [
        `tier${String(position)}-latest`,
        { family: `anthropic/claude-tier${String(position)}` }
      ])
    )
    const aliases = Object.fromEntries(
      Array.from({ length: 6 }, (_, position) => [`mine${String(position)}`, 'alpha/m0'])
    )
    const view: ModelsView = {
      models: [exposed('m0')],
      aliases,
      latest,
      diagnostics: [],
      families: [],
      // The last built-in alias: after the model, six aliases and the new-alias row.
      selected: 13
    }

    const rows = rendered(view, 14, SIDE_BY_SIDE)

    expect(rows).toHaveLength(14)
    expect(rows).toContainEqual(expect.stringMatching(/› tier5-latest /u))
  })

  // Catches a long chain, its fallback classes or a diagnostic cut with `…` in a narrow box: they
  // say what the alias serves and why a target is left out, so they wrap instead.
  test('wraps a long chain and its diagnostic inside a narrow box, cutting nothing', () => {
    const rows = rendered(
      {
        models: [exposed('m0')],
        aliases: {
          coding: {
            targets: [
              { model: 'alpha/a-model-with-a-long-name', reasoningEffort: 'high' },
              'beta/another-model-with-a-long-name'
            ],
            fallbackOn: ['rate_limit', 'timeout']
          }
        },
        diagnostics: [
          {
            code: 'target-not-exposed',
            alias: 'coding',
            target: 'beta/another-model-with-a-long-name',
            message: 'names a model the exposure config hides, so the chain skips it'
          }
        ],
        families: [],
        selected: 1
      },
      20,
      64
    )
    const box = boxLines(rows)
    const text = box.join(' ').replaceAll(/\s+/gu, ' ')

    // The new-alias row's own `…` aside.
    expect(box.slice(0, -1).some((line) => line.includes('…'))).toBe(false)
    expect(box[1]).toMatch(/^› coding {11}alpha\/a-model-with-a-long-name @high ›$/u)
    expect(box[2]).toMatch(/^ {19}beta\/another-model-with-a-long-name/u)
    expect(text).toContain('on rate_limit, timeout')
    expect(text).toContain(
      'target-not-exposed: names a model the exposure config hides, so the chain skips it'
    )
  })

  // Catches the matrix keeping a cooldown's columns while nothing cools, which narrows the box
  // beside it for nothing.
  test('beside the matrix, the box takes the cooldown columns while no model cools', () => {
    const view = {
      models: [exposed('m0')],
      aliases: { only: 'alpha/m0' },
      diagnostics: [],
      families: [],
      selected: 0
    }
    const boxStart = (): number => rendered(view, 10, 180)[0]?.indexOf('╭─ ALIASES') ?? -1

    const idle = boxStart()
    startCooldown({ provider: 'alpha', canonicalId: 'alpha/m0' }, 'unavailable', 42_000, 0)
    const cooling = boxStart()

    expect(idle).toBe(2 + 30 + 42 + 15 + 2)
    expect(cooling).toBe(2 + 30 + 42 + 29 + 2)
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
