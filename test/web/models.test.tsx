import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, test } from 'vite-plus/test'

import { EDITOR, renderApp, stubApi, VIEWER, writesTo } from './harness'

/**
 * One exposed model, as the API lists it.
 *
 * @param id - its public ID
 * @param provider - its provider
 * @returns the model
 */
const model = (id: string, provider: string): Record<string, unknown> => ({
  id,
  provider,
  reasoning_efforts: ['low', 'high'],
  context_window: 200_000,
  input: ['text', 'image']
})

/** What the alias editor offers. */
const OPTIONS = {
  models: [
    { id: 'anthropic/claude-opus-5-5', efforts: ['low', 'high'] },
    { id: 'openai-codex/gpt-6-sol', efforts: ['medium'] }
  ],
  families: [
    {
      family: 'anthropic/claude-opus',
      members: ['anthropic/claude-opus-5-5', 'anthropic/claude-opus-5'],
      newest: 'anthropic/claude-opus-5-5'
    }
  ],
  failures: ['rate_limit', 'timeout']
}

/** The Models page's data. */
const MODELS = {
  models: [model('claude-opus-5-5', 'anthropic'), model('gpt-6-sol', 'openai-codex')],
  aliases: [model('quick', 'anthropic')],
  configured: {
    quick: 'anthropic/claude-haiku-5-5',
    coding: {
      targets: [
        { family: 'anthropic/claude-opus', pin: 'anthropic/claude-opus-5' },
        'openai-codex/gpt-6-sol'
      ],
      fallbackOn: ['rate_limit']
    }
  },
  latest: { 'opus-latest': { family: 'anthropic/claude-opus' } },
  aliasDiagnostics: [{ alias: 'coding', message: 'coding: a target is not exposed' }],
  available: 5,
  modelsJsonError: null,
  options: OPTIONS
}

describe('the Models page', () => {
  // Catches an alias shown without what it points at (a family in a chain among them), a
  // left-out alias shown as reachable, the exposed count wrong, or a viewer offered edits.
  test('lists the models and what each alias points at', async () => {
    stubApi({ '/session': VIEWER, '/models': MODELS })

    renderApp('#/models')

    expect(await screen.findByText('claude-opus-5-5')).toBeTruthy()
    expect(screen.getByText('2 of 5 available')).toBeTruthy()
    expect(screen.getAllByText('200K')).toHaveLength(2)
    expect(screen.getByText('anthropic/claude-haiku-5-5')).toBeTruthy()
    expect(
      screen.getByText(
        'anthropic/claude-opus pinned to anthropic/claude-opus-5 → openai-codex/gpt-6-sol on rate_limit'
      )
    ).toBeTruthy()
    expect(screen.getByText('newest anthropic/claude-opus')).toBeTruthy()
    expect(screen.getAllByText('left out')).toHaveLength(2)
    expect(screen.getByText('coding: a target is not exposed')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
    expect(screen.queryByRole('button', { name: '+ New alias' })).toBeNull()
  })

  // Catches a new alias sent without its name or effort, or a built-in `-latest` alias offered
  // for editing: only the configured ones are the config's to change.
  test('an editor adds an alias', async () => {
    const calls = stubApi({ '/session': EDITOR, '/models': MODELS, '/aliases/fast': MODELS })
    renderApp('#/models')

    fireEvent.click(await screen.findByRole('button', { name: '+ New alias' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Alias name' }), {
      target: { value: 'fast' }
    })
    fireEvent.change(screen.getByRole('combobox', { name: 'Target 1 effort' }), {
      target: { value: 'high' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(writesTo(calls, 'PUT', '/aliases/fast')).toEqual([
        {
          targets: [{ model: 'anthropic/claude-opus-5-5', reasoningEffort: 'high' }],
          fallbackOn: []
        }
      ])
    })
    expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(2)
  })

  // Catches a family target sent as a model, its pin lost, a second target added with no model,
  // or the chain's fallback classes left out.
  test('an editor builds a chain that follows a family', async () => {
    const calls = stubApi({ '/session': EDITOR, '/models': MODELS, '/aliases/opus': MODELS })
    renderApp('#/models')

    fireEvent.click(await screen.findByRole('button', { name: '+ New alias' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Alias name' }), {
      target: { value: 'opus' }
    })
    fireEvent.change(screen.getByRole('combobox', { name: 'Target 1 kind' }), {
      target: { value: 'family' }
    })
    fireEvent.change(screen.getByRole('combobox', { name: 'Target 1 pin' }), {
      target: { value: 'anthropic/claude-opus-5' }
    })
    fireEvent.click(screen.getByRole('button', { name: '+ Add a target' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Target 2 model' }), {
      target: { value: 'openai-codex/gpt-6-sol' }
    })
    fireEvent.click(screen.getByRole('checkbox', { name: 'timeout' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(writesTo(calls, 'PUT', '/aliases/opus')).toEqual([
        {
          targets: [
            { family: 'anthropic/claude-opus', pin: 'anthropic/claude-opus-5' },
            { model: 'openai-codex/gpt-6-sol' }
          ],
          fallbackOn: ['timeout']
        }
      ])
    })
  })

  // Catches an edit that loses a family target's pin or the chain's fallback classes, or a rename
  // sent without the name it had, which would leave the old alias behind.
  test('an editor renames an alias, keeping its chain', async () => {
    const calls = stubApi({ '/session': EDITOR, '/models': MODELS, '/aliases/builder': MODELS })
    renderApp('#/models')

    const coding = (await screen.findByText('coding')).closest('tr')
    if (coding === null) throw new Error('the coding alias should have a row')
    fireEvent.click(within(coding).getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Alias name' }), {
      target: { value: 'builder' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(writesTo(calls, 'PUT', '/aliases/builder')).toEqual([
        {
          targets: [
            { family: 'anthropic/claude-opus', pin: 'anthropic/claude-opus-5' },
            { model: 'openai-codex/gpt-6-sol' }
          ],
          fallbackOn: ['rate_limit'],
          previousName: 'coding'
        }
      ])
    })
  })
})
