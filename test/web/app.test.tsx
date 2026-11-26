import { fireEvent, screen, within } from '@testing-library/react'
import { describe, expect, test } from 'vite-plus/test'

import { renderApp, stubApi, stubEventSource, VIEWER } from './harness'

describe('the admin UI shell', () => {
  // Catches someone signed out shown a broken page instead of the way in.
  test('offers sign-in without a session', async () => {
    stubApi({ '/session': { status: 401, body: { error: { message: 'Sign in' } } } })

    renderApp()

    const link = await screen.findByRole('link', { name: 'Sign in with GitHub' })
    expect(link.getAttribute('href')).toBe('/admin/auth/sign-in')
  })

  // Catches the operator not shown who they are signed in as, or a tab missing.
  test('names the operator and their role, with a tab per page', async () => {
    stubEventSource()
    stubApi({
      '/session': VIEWER,
      '/requests': { requests: [], active: [], finished: [], events: [] }
    })

    renderApp()

    expect(await screen.findByText('alice')).toBeTruthy()
    expect(screen.getByText('viewer')).toBeTruthy()
    const tabs = within(screen.getByRole('tablist')).getAllByRole('tab')
    // Each tab carries its number key, in the console's order, as the console's do.
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      '1Requests',
      '2Accounts',
      '3Stats',
      '4Models',
      '5Settings',
      '6Doctor',
      '7Logins'
    ])
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true')
  })

  // Catches a page whose session ended mid-use left blank or showing a raw error.
  test('offers sign-in again when a page finds the session ended', async () => {
    stubApi({ '/session': VIEWER, '/accounts': { status: 401, body: { error: { message: 'x' } } } })

    renderApp('#/accounts')

    expect(await screen.findByText('Your session has ended.')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Sign in again' }).getAttribute('href')).toBe(
      '/admin/auth/sign-in'
    )
  })

  // Catches a failed read hidden, or shown without the proxy's reason.
  test("shows the proxy's message when a read fails", async () => {
    stubApi({
      '/session': VIEWER,
      '/models': { status: 503, body: { error: { message: 'The exposure config is invalid' } } }
    })

    renderApp('#/models')

    expect(await screen.findByText('The exposure config is invalid')).toBeTruthy()
  })

  // Catches sign-out sent as a GET (which the admin listener does not take) or not sent.
  test('signs out with a POST', async () => {
    stubEventSource()
    const calls = stubApi({
      '/session': VIEWER,
      '/requests': { requests: [], active: [], finished: [], events: [] }
    })
    renderApp()

    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }))

    await expect
      .poll(() => calls.find((call) => call.path === '/admin/auth/sign-out'))
      .toEqual({ method: 'POST', path: '/admin/auth/sign-out' })
  })

  // Catches the Logins page offering a way to log in over the web, or not the terminal command.
  test('the Logins page gives the terminal commands', async () => {
    stubApi({ '/session': VIEWER })

    renderApp('#/logins')

    expect(
      await screen.findByText('docker exec -it <container> pi auth login <provider>')
    ).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
  })
})
