import type { ProviderCredentialStatus } from '@proxy/pi/registry'
import { createRefresh, credentialChanged, type RefreshState } from '@proxy/tui/status-refresh'
import { describe, expect, test } from 'vite-plus/test'

/** A read the test finishes when it chooses. */
interface PendingRead<Value> {
  readonly promise: Promise<Value>
  readonly finish: (value: Value) => void
}

/**
 * Creates a read the test finishes later.
 *
 * @typeParam Value - what the read returns
 * @returns the read and the function that finishes it
 */
function pendingRead<Value>(): PendingRead<Value> {
  let finish: (value: Value) => void = () => undefined
  const promise = new Promise<Value>((resolve) => {
    finish = resolve
  })
  return { promise, finish }
}

/**
 * Builds one provider's credential status.
 *
 * @param provider - the provider
 * @param verified - the verification result, if the read verified
 * @returns the status
 */
function account(provider: string, verified?: boolean): ProviderCredentialStatus {
  return {
    provider,
    type: 'oauth',
    source: 'auth.json',
    availableModelCount: 1,
    ...(verified === undefined ? {} : { verified })
  }
}

/**
 * Creates an empty console state.
 *
 * @returns the state
 */
function emptyState(): RefreshState<string> {
  return {
    status: undefined,
    accounts: [],
    verification: new Map(),
    credentialChanges: new Map()
  }
}

/**
 * Creates a reader whose reads the test finishes one by one, in any order.
 *
 * @param state - the state the reads update
 * @returns the reader and its reads, in the order they started
 */
function controlledRefresh(state: RefreshState<string>): {
  refresh: (verify?: boolean) => Promise<void>
  reads: PendingRead<readonly ProviderCredentialStatus[]>[]
} {
  const reads: PendingRead<readonly ProviderCredentialStatus[]>[] = []
  const refresh = createRefresh(
    state,
    {
      status: async () => `read ${String(reads.length)}`,
      accounts: async () => {
        const read = pendingRead<readonly ProviderCredentialStatus[]>()
        reads.push(read)
        return read.promise
      }
    },
    () => undefined
  )
  return { refresh, reads }
}

describe('the console status reader', () => {
  // Catches an older, slower read overwriting what a newer one showed.
  test('a read that finishes after a newer one does not replace it', async () => {
    const state = emptyState()
    const { refresh, reads } = controlledRefresh(state)
    const older = refresh()
    const newer = refresh()

    reads[1]?.finish([account('anthropic')])
    await newer
    reads[0]?.finish([])
    await older

    expect(state.accounts.map((status) => status.provider)).toEqual(['anthropic'])
  })

  // Catches a verification lost because a plain read started after it finished first.
  test('a verification is kept even when a newer read finished first', async () => {
    const state = emptyState()
    const { refresh, reads } = controlledRefresh(state)
    const verifying = refresh(true)
    const plain = refresh()

    reads[1]?.finish([account('anthropic')])
    await plain
    reads[0]?.finish([account('anthropic', true)])
    await verifying

    expect(state.accounts).toEqual([expect.objectContaining({ verified: true })])
  })

  // Catches "✓ verified" shown for a new credential: a verification that began before a logout
  // or a new login is about the credential that is gone (second #195 review).
  test('a verification under way when a login changes is dropped for that provider', async () => {
    const state = emptyState()
    const { refresh, reads } = controlledRefresh(state)
    const verifying = refresh(true)

    credentialChanged(state, 'anthropic')
    const afterLogin = refresh()
    reads[1]?.finish([account('anthropic'), account('openai-codex')])
    await afterLogin
    reads[0]?.finish([account('anthropic', true), account('openai-codex', true)])
    await verifying

    expect(state.accounts).toEqual([
      expect.not.objectContaining({ verified: true }),
      expect.objectContaining({ provider: 'openai-codex', verified: true })
    ])
  })
})
