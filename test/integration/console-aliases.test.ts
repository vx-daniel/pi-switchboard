/**
 * The console's alias editor (#230), end to end: its menus, answered by scripted dialogs, refuse a
 * bad name with its reason, and creating, editing, renaming and deleting an alias rewrites
 * `proxy-config.json` so that the next request uses the change, with no restart. The proxy runs as
 * deployed (its config file read per request) against the mock provider.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import { loadConfigFromFile } from '@proxy/config/schema'
import { computeModelExposure, type ModelExposureResult } from '@proxy/openai/model-exposure'
import { getAvailableModels } from '@proxy/pi/registry'
import { createApp } from '@proxy/server/app'
import { fileConfigReader } from '@proxy/server/routes'
import { type AliasEditor, runModelsItem } from '@proxy/tui/console-models'
import { type ModelsItem, modelsItems, modelsViewData } from '@proxy/tui/models-view'
import { isRecord } from '@proxy/utils/guards'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'
import {
  finishChunk,
  type MockProvider,
  sse,
  startMockProvider,
  textChunks
} from '../fixtures/mock-provider'
import { testConfig } from '../helpers'

const MOCK_KEY = 'notarealsecret-mock-provider-key'

let mock: MockProvider
let agentDir: FixtureAgentDir

beforeAll(async () => {
  const answer = sse([...textChunks('ok'), finishChunk('stop')])
  mock = await startMockProvider({ 'deep-mock': answer, 'quick-mock': answer })
  agentDir = await loadFixtureAgentDir({
    modelsJson: {
      providers: {
        alpha: {
          baseUrl: `${mock.origin}/v1`,
          api: 'openai-completions',
          apiKey: MOCK_KEY,
          models: [
            { id: 'deep-mock', reasoning: true },
            { id: 'quick-mock', reasoning: true }
          ]
        }
      }
    }
  })
})

beforeEach(() => {
  writeFileSync(join(agentDir.path, 'proxy-config.json'), JSON.stringify({ port: 4141 }))
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await mock.close()
  agentDir.remove()
})

/**
 * Sends one chat request and reads what the upstream was asked.
 *
 * @param model - the request's `model`
 * @returns the status, and the upstream call's model and `reasoning_effort`
 */
async function ask(model: string): Promise<{ status: number; upstream: unknown[] }> {
  const before = mock.requests.length
  const response = await createApp(testConfig(), fileConfigReader).request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Say ok' }] })
  })
  await response.text()
  const upstream = mock.requests.slice(before).map((request) => {
    const body = isRecord(request.body) ? request.body : {}
    return [body['model'], body['reasoning_effort']]
  })
  return { status: response.status, upstream }
}

/**
 * Computes the exposure as the console does.
 *
 * @returns the exposure; the test fails when the config is invalid
 */
async function exposure(): Promise<ModelExposureResult> {
  const outcome = computeModelExposure(
    getAvailableModels(),
    await fileConfigReader(),
    getSupportedThinkingLevels
  )
  if (!outcome.ok) throw new Error(outcome.message)
  return outcome
}

/** What the scripted dialogs saw. */
interface Seen {
  /** Each dialog's title, in order. */
  readonly titles: string[]
  /** Each selector's options, in order. */
  readonly options: (readonly string[])[]
}

/**
 * Runs Enter on one Models view row, with dialogs that answer from scripts.
 *
 * @param pick - finds the row among the view's items
 * @param picks - the selectors' answers, in order; `undefined` cancels
 * @param typed - the inputs' answers, in order; `undefined` cancels
 * @returns what the dialogs saw
 */
async function enterOn(
  pick: (items: readonly ModelsItem[]) => ModelsItem | undefined,
  picks: (string | undefined)[],
  typed: (string | undefined)[] = []
): Promise<Seen> {
  const seen: Seen = { titles: [], options: [] }
  const current = await exposure()
  const aliases = loadConfigFromFile().aliases
  const editor: AliasEditor = {
    screens: {
      select: (title, labels) => {
        seen.titles.push(title)
        seen.options.push(labels)
        return Promise.resolve(picks.shift())
      },
      input: (title) => {
        seen.titles.push(title)
        return Promise.resolve(typed.shift())
      }
    },
    exposure: current,
    aliases,
    refresh: () => Promise.resolve()
  }
  const item = pick(modelsItems(modelsViewData(current, aliases)))
  if (item === undefined) throw new Error('No such row')
  await runModelsItem(editor, item)
  return seen
}

/**
 * Finds an alias's row.
 *
 * @param name - the alias
 * @returns the finder
 */
function aliasRow(name: string): (items: readonly ModelsItem[]) => ModelsItem | undefined {
  return (items) => items.find((row) => row.kind === 'alias' && row.name === name)
}

/**
 * Finds the new-alias row.
 *
 * @param items - the view's items
 * @returns the row
 */
function newRow(items: readonly ModelsItem[]): ModelsItem | undefined {
  return items.at(-1)
}

/**
 * Writes the config file with these aliases.
 *
 * @param aliases - the `aliases` field
 */
function setAliases(aliases: Record<string, unknown>): void {
  writeFileSync(join(agentDir.path, 'proxy-config.json'), JSON.stringify({ port: 4141, aliases }))
}

describe('the console alias editor', () => {
  // Catches a name the proxy would ignore or misread saved anyway (whitespace, a model's ID,
  // another alias's), the refusal shown without its reason, or an effort offered that the model
  // doesn't support; then an alias that needs a restart, or a save that rewrites the rest of the
  // file.
  test('a new alias refuses bad names with the reason, then serves the next request', async () => {
    setAliases({ taken: 'alpha/quick-mock' })

    const seen = await enterOn(
      newRow,
      ['alpha/deep-mock', 'high'],
      ['builder high', 'deep-mock', 'taken', 'reviewer']
    )

    expect(seen.titles.slice(0, 4)).toEqual([
      expect.stringMatching(/^Name for the new alias/u),
      expect.stringMatching(/^"builder high" has whitespace/u),
      expect.stringMatching(/^"deep-mock" is an exposed model's ID/u),
      expect.stringMatching(/^An alias named "taken" already exists/u)
    ])
    expect(seen.options.at(-1)).toEqual([
      "The request's effort (not fixed)",
      'none',
      'minimal',
      'low',
      'medium',
      'high'
    ])
    expect(await ask('reviewer')).toEqual({ status: 200, upstream: [['deep-mock', 'high']] })
    const saved: unknown = JSON.parse(
      readFileSync(join(agentDir.path, 'proxy-config.json'), 'utf8')
    )
    expect(saved).toMatchObject({
      port: 4141,
      aliases: {
        taken: 'alpha/quick-mock',
        reviewer: { model: 'alpha/deep-mock', reasoningEffort: 'high' }
      }
    })
  })

  // Catches a model's row starting an alias for another model, or the request's effort written
  // as a fixed one.
  test("a model's row starts an alias for that model, at the request's effort", async () => {
    setAliases({})

    await enterOn(
      (items) =>
        items.find((row) => row.kind === 'model' && row.model.canonicalId === 'alpha/quick-mock'),
      ["The request's effort (not fixed)"],
      ['quick']
    )

    expect(loadConfigFromFile().aliases).toEqual({ quick: 'alpha/quick-mock' })
  })

  // Catches targets edited into a form the schema drops (the alias would vanish), a move that
  // doesn't move, or a chain saved without the fallback classes ticked.
  test('targets and fallback classes edit an alias into a chain', async () => {
    setAliases({ builder: 'alpha/quick-mock' })

    await enterOn(aliasRow('builder'), [
      'Targets and efforts',
      '+ Add a target…',
      'alpha/deep-mock',
      'medium',
      '2. alpha/deep-mock @medium',
      'Move up',
      'Done'
    ])
    await enterOn(aliasRow('builder'), [
      'Fall back on (fallbackOn)',
      '[ ] unavailable',
      '[ ] rate_limit',
      'Done'
    ])

    expect(loadConfigFromFile().aliases).toEqual({
      builder: {
        targets: [{ model: 'alpha/deep-mock', reasoningEffort: 'medium' }, 'alpha/quick-mock'],
        fallbackOn: ['rate_limit', 'unavailable']
      }
    })
    expect(await ask('builder')).toEqual({ status: 200, upstream: [['deep-mock', 'medium']] })
  })

  // Catches an alias left with no target (it would name nothing), a removal that takes the wrong
  // target, or a changed effort not saved.
  test("removing a target keeps the alias's last one, and an effort can be changed", async () => {
    setAliases({
      pair: { targets: ['alpha/deep-mock', 'alpha/quick-mock'], fallbackOn: ['rate_limit'] }
    })

    await enterOn(aliasRow('pair'), [
      'Targets and efforts',
      '1. alpha/deep-mock',
      'Remove',
      '1. alpha/quick-mock',
      'Remove',
      '1. alpha/quick-mock',
      'Set the reasoning effort',
      'low',
      'Done'
    ])

    expect(loadConfigFromFile().aliases).toEqual({
      pair: {
        targets: [{ model: 'alpha/quick-mock', reasoningEffort: 'low' }],
        fallbackOn: ['rate_limit']
      }
    })
  })

  // Catches a cancelled checkbox list saving what was ticked before the cancel.
  test('cancelling the fallback classes saves nothing', async () => {
    setAliases({ builder: 'alpha/quick-mock' })

    await enterOn(aliasRow('builder'), ['Fall back on (fallbackOn)', '[ ] timeout', undefined])

    expect(loadConfigFromFile().aliases).toEqual({ builder: 'alpha/quick-mock' })
  })

  // Catches a rename that leaves the old name serving, adds the alias twice, or moves it to the
  // end of the list.
  test('a renamed alias keeps its place, and the old name stops serving', async () => {
    setAliases({ first: 'alpha/quick-mock', second: 'alpha/deep-mock', third: 'alpha/quick-mock' })

    await enterOn(aliasRow('second'), ['Rename'], ['renamed'])

    expect(Object.keys(loadConfigFromFile().aliases)).toEqual(['first', 'renamed', 'third'])
    expect((await ask('second')).status).toBe(404)
    expect((await ask('renamed')).status).toBe(200)
  })

  // Catches a delete without confirmation, one that leaves the alias serving, or one that takes
  // the other aliases with it.
  test('an alias is deleted only once confirmed, and the others stay', async () => {
    setAliases({ keep: 'alpha/quick-mock', drop: 'alpha/deep-mock' })

    await enterOn(aliasRow('drop'), ['Delete', 'Keep it'])
    expect(Object.keys(loadConfigFromFile().aliases)).toEqual(['keep', 'drop'])

    await enterOn(aliasRow('drop'), ['Delete', 'Delete it'])
    expect(Object.keys(loadConfigFromFile().aliases)).toEqual(['keep'])
    expect((await ask('drop')).status).toBe(404)
  })
})
