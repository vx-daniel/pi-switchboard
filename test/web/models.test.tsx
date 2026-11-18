import { screen } from '@testing-library/react'
import { describe, expect, test } from 'vite-plus/test'

import { renderApp, stubApi, VIEWER } from './harness'

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

describe('the Models page', () => {
  // Catches an alias shown without what it points at, a left-out alias shown as reachable, or the
  // exposed count wrong.
  test('lists the models and what each alias points at', async () => {
    stubApi({
      '/session': VIEWER,
      '/models': {
        models: [model('claude-opus-5-5', 'anthropic'), model('gpt-6-sol', 'openai-codex')],
        aliases: [model('quick', 'anthropic')],
        configured: {
          quick: 'anthropic/claude-haiku-5-5',
          coding: {
            targets: ['anthropic/claude-opus-5-5', 'openai-codex/gpt-6-sol'],
            fallbackOn: ['rate_limit']
          }
        },
        latest: { 'opus-latest': { family: 'anthropic/claude-opus' } },
        aliasDiagnostics: [{ alias: 'coding', message: 'coding: a target is not exposed' }],
        available: 5,
        modelsJsonError: null
      }
    })

    renderApp('#/models')

    expect(await screen.findByText('claude-opus-5-5')).toBeTruthy()
    expect(screen.getByText('2 of 5 available')).toBeTruthy()
    expect(screen.getAllByText('200K')).toHaveLength(2)
    expect(screen.getByText('anthropic/claude-haiku-5-5')).toBeTruthy()
    expect(
      screen.getByText('anthropic/claude-opus-5-5 → openai-codex/gpt-6-sol on rate_limit')
    ).toBeTruthy()
    expect(screen.getByText('newest anthropic/claude-opus')).toBeTruthy()
    expect(screen.getAllByText('left out')).toHaveLength(2)
    expect(screen.getByText('coding: a target is not exposed')).toBeTruthy()
  })
})
