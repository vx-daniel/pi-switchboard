import { act, screen, within } from '@testing-library/react'
import { describe, expect, test } from 'vite-plus/test'

import { openedSources, renderApp, stubApi, stubEventSource, VIEWER } from './harness'

const STARTED = Date.UTC(2026, 10, 18, 14, 3, 27)

/** A snapshot with one chat request and one event. */
const SNAPSHOT = {
  requests: [
    {
      kind: 'request',
      sequence: 2,
      requestId: 'req-1',
      method: 'POST',
      path: '/v1/chat/completions',
      startedAt: STARTED,
      status: 200,
      endedAt: STARTED + 1500
    }
  ],
  active: [],
  finished: [
    {
      requestId: 'req-1',
      alias: 'quick',
      model: 'anthropic/claude-haiku-5-5',
      attempt: 2,
      stream: true,
      startedAt: STARTED,
      outcome: 'ok',
      endedAt: STARTED + 1500
    }
  ],
  events: [
    {
      kind: 'event',
      sequence: 1,
      at: STARTED - 1000,
      level: 'info',
      text: 'Listening on http://127.0.0.1:4141'
    }
  ]
}

describe('the Requests page', () => {
  // Catches a request shown without the chat behind it (alias, model, fallback, outcome).
  test('shows each request with its chat, and the events among them', async () => {
    stubEventSource()
    stubApi({ '/session': VIEWER, '/requests': SNAPSHOT })

    renderApp('#/requests')

    const page = within(await screen.findByRole('main'))
    expect(await page.findByText('/v1/chat/completions', { exact: false })).toBeTruthy()
    expect(page.getByText('quick')).toBeTruthy()
    expect(page.getByText('anthropic/claude-haiku-5-5')).toBeTruthy()
    expect(page.getByText('attempt 2')).toBeTruthy()
    expect(page.getByText('1.5 s')).toBeTruthy()
    expect(page.getByText('Listening on http://127.0.0.1:4141')).toBeTruthy()
  })

  // Catches the page not following the stream, so a new request shows only after a reload.
  test('adds the requests the stream sends', async () => {
    stubEventSource()
    stubApi({ '/session': VIEWER, '/requests': SNAPSHOT })
    renderApp('#/requests')
    await screen.findByText('quick')

    const [source] = openedSources
    act(() => {
      source?.emit('requests', {
        ...SNAPSHOT,
        requests: [
          ...SNAPSHOT.requests,
          {
            kind: 'request',
            sequence: 3,
            requestId: 'req-2',
            method: 'GET',
            path: '/v1/models',
            startedAt: STARTED + 2000
          }
        ]
      })
    })

    expect(source?.url).toBe('/admin/api/requests/stream')
    expect(await screen.findByText('/v1/models', { exact: false })).toBeTruthy()
    expect(screen.getByLabelText('In flight')).toBeTruthy()
  })

  // Catches the stream left open after the page is left, which keeps a connection per visit.
  test('closes the stream when the page is left', async () => {
    stubEventSource()
    stubApi({ '/session': VIEWER, '/requests': SNAPSHOT })
    const rendered = renderApp('#/requests')
    await screen.findByText('quick')

    rendered.unmount()

    expect(openedSources.every((source) => source.closed)).toBe(true)
  })
})
