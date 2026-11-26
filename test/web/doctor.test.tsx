import { screen } from '@testing-library/react'
import { describe, expect, test } from 'vite-plus/test'

import { renderApp, stubApi, VIEWER } from './harness'

describe('the Doctor page', () => {
  // Catches a finding shown without its recommendation, under the wrong severity, or the limits
  // left out.
  test('groups the findings by severity, with their recommendations', async () => {
    stubApi({
      '/session': VIEWER,
      '/doctor?window=today': {
        general: [
          {
            check: 'exposure',
            severity: 'error',
            message: 'No model is exposed (0 available).',
            recommendation: 'Log in to a provider.'
          }
        ],
        cache: [
          {
            check: 'hit-rate',
            severity: 'advice',
            subject: 'anthropic/claude-opus-5-5',
            message: 'The cache hit rate is 20%.',
            recommendation: 'Keep the prompt prefix stable.'
          }
        ],
        window: 'today',
        statsAvailable: true,
        limits: ['No login was verified.']
      }
    })

    renderApp('#/doctor')

    expect(await screen.findByText('No model is exposed (0 available).')).toBeTruthy()
    expect(screen.getByText('Log in to a provider.')).toBeTruthy()
    expect(screen.getByText('Errors')).toBeTruthy()
    expect(screen.getByText('hit-rate · anthropic/claude-opus-5-5')).toBeTruthy()
    expect(screen.getByText('Advice')).toBeTruthy()
    expect(screen.queryByText('Warnings')).toBeNull()
    expect(screen.getByText('No login was verified.')).toBeTruthy()
  })

  // Catches a clean report shown as an empty page, which reads as not loaded.
  test('says so when there is nothing to report', async () => {
    stubApi({
      '/session': VIEWER,
      '/doctor?window=today': {
        general: [],
        cache: [],
        window: 'today',
        statsAvailable: false,
        limits: []
      }
    })

    renderApp('#/doctor')

    expect(await screen.findByText('Nothing to report.')).toBeTruthy()
  })
})
