import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

import { EDITOR, renderApp, stubApi, VIEWER, writesTo } from './harness'

/** A project as clients name it, with the `/` the path must encode. */
const PROJECT = 'vx-daniel/pi-switchboard'

/** Its budget path, as the page sends it. */
const PROJECT_PATH = `/budgets/${encodeURIComponent(PROJECT)}`

/** A window with no requests: the Stats page draws no chart. */
const IDLE = {
  window: 'today',
  bucket_minutes: 60,
  models: [],
  failures: [],
  rejected: [],
  projects: [],
  timeline: []
}

/** The budgets saved. */
const BUDGETS = { budgets: { [PROJECT]: { week: 50, all: 150 } } }

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("the Stats page's budget editor", () => {
  // Catches a cleared window sent as 0 or left out of the change, which would keep the old amount,
  // or a project with a `/` sent unencoded, which no route matches.
  test("saves a project's budget with only the windows that have an amount", async () => {
    const calls = stubApi({
      '/session': EDITOR,
      '/stats?window=today': IDLE,
      '/budgets': BUDGETS,
      [PROJECT_PATH]: { budgets: { [PROJECT]: { today: 2, all: 150 } } }
    })
    renderApp('#/stats')

    const week = await screen.findByLabelText(`week budget for ${PROJECT}`)
    fireEvent.change(week, { target: { value: '' } })
    fireEvent.change(screen.getByLabelText(`today budget for ${PROJECT}`), {
      target: { value: '2' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(writesTo(calls, 'PUT', PROJECT_PATH)).toEqual([{ today: 2, all: 150 }])
    })
  })

  // Catches a new project's name lost on the way, or its budget written to another project.
  test('adds a project, and removes one', async () => {
    const calls = stubApi({
      '/session': EDITOR,
      '/stats?window=today': IDLE,
      '/budgets': BUDGETS,
      '/budgets/team%2Fother': { budgets: {} },
      [PROJECT_PATH]: { budgets: {} }
    })
    renderApp('#/stats')

    fireEvent.change(await screen.findByLabelText('New project'), {
      target: { value: ' team/other ' }
    })
    fireEvent.change(screen.getByLabelText('week budget for the new project'), {
      target: { value: '10' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))

    await waitFor(() => {
      expect(writesTo(calls, 'PUT', '/budgets/team%2Fother')).toEqual([{ week: 10 }])
      expect(writesTo(calls, 'DELETE', PROJECT_PATH)).toEqual([null])
    })
  })

  // Catches a refusal swallowed, which leaves the editor believing the budget was saved.
  test("shows the proxy's refusal", async () => {
    stubApi({
      '/session': EDITOR,
      '/stats?window=today': IDLE,
      '/budgets': BUDGETS,
      [PROJECT_PATH]: {
        status: 400,
        body: { error: { code: 'invalid_body', message: 'US dollars above 0' } }
      }
    })
    renderApp('#/stats')

    fireEvent.click(await screen.findByRole('button', { name: 'Save' }))

    expect(await screen.findByText('US dollars above 0')).toBeTruthy()
  })

  // Catches a viewer offered an editor the proxy would refuse.
  test('is not shown to a viewer', async () => {
    stubApi({ '/session': VIEWER, '/stats?window=today': IDLE, '/budgets': BUDGETS })
    renderApp('#/stats')

    await screen.findByText('No requests in this window.')

    expect(screen.queryByRole('heading', { name: 'Budgets' })).toBeNull()
  })
})
