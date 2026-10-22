/**
 * The console's status and accounts reader (#61): reads can overlap, and only the newest may show.
 *
 * @packageDocumentation
 */

import type { ProviderCredentialStatus } from '@proxy/pi/registry'

/** A provider's last verification result. */
export type Verification = Pick<ProviderCredentialStatus, 'verified' | 'error'>

/** The part of the console's state the reads update. */
export interface RefreshState<Status> {
  status: Status | undefined
  accounts: readonly ProviderCredentialStatus[]
  /** The last verification of each provider (`v`), kept until its next login or logout. */
  verification: Map<string, Verification>
  /** How many times each provider's credential changed (a login or logout) while running. */
  readonly credentialChanges: Map<string, number>
}

/** Where the reads come from. */
export interface RefreshSources<Status> {
  /** Reads the status line's numbers. */
  readonly status: () => Promise<Status>
  /**
   * Reads pi's credential statuses.
   *
   * @param verify - whether to resolve each credential now
   */
  readonly accounts: (verify: boolean) => Promise<readonly ProviderCredentialStatus[]>
}

/**
 * Keeps a status's verification result, with only the fields it has.
 *
 * @param account - a status read with `verify`
 * @returns its verification
 */
function verificationOf({ verified, error }: ProviderCredentialStatus): Verification {
  return {
    ...(verified === undefined ? {} : { verified }),
    ...(error === undefined ? {} : { error })
  }
}

/**
 * Records that a provider's credential changed (a login or logout): drops its verification, and
 * makes a verification already under way drop its result for that provider when it finishes.
 *
 * @typeParam Status - what the status line shows
 * @param state - the console's state
 * @param provider - the provider whose credential changed
 */
export function credentialChanged<Status>(state: RefreshState<Status>, provider: string): void {
  state.verification.delete(provider)
  state.credentialChanges.set(provider, (state.credentialChanges.get(provider) ?? 0) + 1)
}

/**
 * Creates the console's status and accounts reader.
 *
 * @remarks
 * Reads can overlap (the 5 s timer, `v`, a login or logout): only the newest read replaces the
 * status and accounts, so a slower, older one never overwrites them. A verification is kept
 * whenever it finishes, except for a provider whose credential changed after it began: that
 * result is about the credential that is gone.
 *
 * @typeParam Status - what the status line shows
 * @param state - the console's state, which the reads update
 * @param sources - where the reads come from
 * @param redraw - asks for a redraw after each read
 * @returns the reader: `verify` resolves each credential now, which may refresh an OAuth token
 */
export function createRefresh<Status>(
  state: RefreshState<Status>,
  sources: RefreshSources<Status>,
  redraw: () => void
): (verify?: boolean) => Promise<void> {
  let latest = 0
  return async (verify = false) => {
    latest += 1
    const ticket = latest
    const changesBefore = new Map(state.credentialChanges)
    const [status, accounts] = await Promise.all([sources.status(), sources.accounts(verify)])
    if (verify) {
      const unchanged = accounts.filter(
        (account) =>
          state.credentialChanges.get(account.provider) === changesBefore.get(account.provider)
      )
      state.verification = new Map(
        unchanged.map((account) => [account.provider, verificationOf(account)])
      )
    }
    if (ticket === latest) {
      state.status = status
      state.accounts = accounts
    }
    state.accounts = state.accounts.map((account) => ({
      ...account,
      ...state.verification.get(account.provider)
    }))
    redraw()
  }
}
