import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

import { EDITOR, renderApp, stubApi, VIEWER, writesTo } from './harness'

const MINUTE_MS = 60_000

/**
 * One login of `groq`, as the Accounts page reads it.
 *
 * @param provider - the login
 * @param position - its place in the routing order, from 1
 * @param extra - what else it has: cooldowns
 * @returns the account
 */
function login(
  provider: string,
  position: number,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    provider,
    base: 'groq',
    type: 'api_key',
    availableModelCount: 3,
    label: null,
    quota: null,
    belowReserve: null,
    cooldowns: [],
    place: { position, count: 2, first: position === 1, disabled: false },
    ...extra
  }
}

/** The page's logins: `groq` first and cooling down, `groq-2` second. */
const ACCOUNTS = [
  login('groq', 1, { cooldowns: [{ reason: 'rate_limit', until: Date.now() + 5 * MINUTE_MS }] }),
  login('groq-2', 2)
]

afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * Finds a login's card.
 *
 * @param provider - the login
 * @returns its card
 */
async function card(provider: string): Promise<HTMLElement> {
  const name = await screen.findByText(provider, { selector: 'span.font-mono' })
  const element = name.closest('.card')
  if (!(element instanceof HTMLElement)) throw new Error(`${provider} should have a card`)
  return element
}

describe("an editor's login actions", () => {
  // Catches a viewer offered changes the API would refuse.
  test('a viewer sees no actions', async () => {
    stubApi({ '/session': VIEWER, '/accounts': ACCOUNTS })
    renderApp('#/accounts')

    expect(within(await card('groq')).queryByRole('button', { name: 'Disable' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'End all cooldowns' })).toBeNull()
  })

  // Catches "Use first" offered to the login already first, or sent for the wrong login.
  test('puts the second login first', async () => {
    const calls = stubApi({
      '/session': EDITOR,
      '/accounts': ACCOUNTS,
      '/logins/groq-2/first': ACCOUNTS
    })
    renderApp('#/accounts')

    expect(within(await card('groq')).queryByRole('button', { name: 'Use first' })).toBeNull()
    fireEvent.click(within(await card('groq-2')).getByRole('button', { name: 'Use first' }))

    await waitFor(() => {
      expect(writesTo(calls, 'POST', '/logins/groq-2/first')).toHaveLength(1)
    })
  })

  // Catches a provider's last enabled login disabled without asking, or asked again and again:
  // one question, one confirmed resend, and the refusal shown when the proxy still refuses.
  test('asks once before disabling the last enabled login', async () => {
    const confirm = vi.fn(() => true)
    vi.stubGlobal('confirm', confirm)
    const calls = stubApi({
      '/session': EDITOR,
      '/accounts': ACCOUNTS,
      '/logins/groq/disabled': {
        status: 400,
        body: {
          error: { code: 'confirm_required', message: "groq is its provider's only enabled login" }
        }
      }
    })
    renderApp('#/accounts')

    fireEvent.click(within(await card('groq')).getByRole('button', { name: 'Disable' }))

    expect(await screen.findByText("groq is its provider's only enabled login")).toBeTruthy()
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(writesTo(calls, 'PUT', '/logins/groq/disabled')).toEqual([
      { disabled: true, confirm: false },
      { disabled: true, confirm: true }
    ])
  })

  // Catches a label sent for another login, or the field left open after it is saved.
  test('labels a login', async () => {
    const calls = stubApi({
      '/session': EDITOR,
      '/accounts': ACCOUNTS,
      '/logins/groq-2/label': ACCOUNTS
    })
    renderApp('#/accounts')

    const groq2 = within(await card('groq-2'))
    fireEvent.click(groq2.getByRole('button', { name: 'Label…' }))
    fireEvent.change(groq2.getByRole('textbox', { name: 'Label for groq-2' }), {
      target: { value: 'work' }
    })
    fireEvent.click(groq2.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(writesTo(calls, 'PUT', '/logins/groq-2/label')).toEqual([{ label: 'work' }])
    })
    expect(groq2.queryByRole('textbox', { name: 'Label for groq-2' })).toBeNull()
  })

  // Catches cooldowns ended for every login when one login's was asked, or the other way round.
  test("ends one login's cooldowns, or every one", async () => {
    const ended = { ended: [{ provider: 'groq' }] }
    const calls = stubApi({
      '/session': EDITOR,
      '/accounts': ACCOUNTS,
      '/cooldowns?provider=groq': ended,
      '/cooldowns': ended
    })
    renderApp('#/accounts')

    fireEvent.click(within(await card('groq')).getByRole('button', { name: 'End cooldowns' }))
    await waitFor(() => {
      expect(writesTo(calls, 'DELETE', '/cooldowns?provider=groq')).toHaveLength(1)
    })
    fireEvent.click(screen.getByRole('button', { name: 'End all cooldowns' }))
    await waitFor(() => {
      expect(writesTo(calls, 'DELETE', '/cooldowns')).toHaveLength(1)
    })
  })
})
