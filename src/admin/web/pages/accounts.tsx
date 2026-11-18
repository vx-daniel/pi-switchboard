/**
 * The Accounts page (#367): each login pi has a credential for, with its quota, reserve,
 * cooldowns and place in its provider's routing order. It never shows a credential, and logging
 * in stays in a terminal (the Logins page).
 *
 * @packageDocumentation
 */

import { type Account, AccountsSchema, readApi } from '@proxy/admin/web/api'
import { percent, until } from '@proxy/admin/web/format'
import { Loaded } from '@proxy/admin/web/loaded'
import { useQuery } from '@tanstack/react-query'
import type { ReactElement } from 'react'

/** A quota share used past this is a warning. */
const HIGH_USE = 0.8
/** The progress bars' scale. */
const PROGRESS_MAX = 100

/**
 * Says where a login stands in its provider's routing order.
 *
 * @param account - the login
 * @returns `1st of 3`, `disabled`, or `undefined` for a provider's only login
 */
function placeText(account: Account): string | undefined {
  const { place } = account
  if (place === null || place.count <= 1) return place?.disabled === true ? 'disabled' : undefined
  if (place.disabled) return `disabled · ${String(place.position)} of ${String(place.count)}`
  return place.first
    ? `first of ${String(place.count)}`
    : `${String(place.position)} of ${String(place.count)}`
}

/**
 * Shows a login's quota windows.
 *
 * @param quota - the login
 * @param quota.account - its latest quota report
 * @returns one bar per window, or nothing when it reported none
 */
function QuotaBars(quota: { readonly account: Account }): ReactElement | null {
  const windows = quota.account.quota?.windows ?? []
  if (windows.length === 0) return null
  const now = Date.now()
  return (
    <div className="flex flex-col gap-2">
      {windows.map((window) => (
        <div key={window.name} className="text-sm">
          <div className="flex justify-between">
            <span>{window.name}</span>
            <span className="text-base-content/60">
              {percent(window.used)} used
              {window.resetsAt === undefined ? '' : ` · resets ${until(window.resetsAt, now)}`}
            </span>
          </div>
          <progress
            className={`progress w-full ${window.used > HIGH_USE ? 'progress-warning' : 'progress-success'}`}
            value={Math.round(window.used * PROGRESS_MAX)}
            max={PROGRESS_MAX}
          />
        </div>
      ))}
    </div>
  )
}

/**
 * Shows one login.
 *
 * @param card - the login
 * @param card.account - its status
 * @returns the card
 */
function AccountCard(card: { readonly account: Account }): ReactElement {
  const { account } = card
  const place = placeText(account)
  const now = Date.now()
  return (
    <div className="card card-border bg-base-100">
      <div className="card-body gap-3">
        <h3 className="card-title flex-wrap">
          <span className="font-mono">{account.provider}</span>
          {account.label === null ? null : (
            <span className="badge badge-outline">{account.label}</span>
          )}
          <span className="badge badge-ghost badge-sm">
            {account.type === 'oauth' ? 'subscription' : 'API key'}
          </span>
          {place === undefined ? null : <span className="badge badge-ghost badge-sm">{place}</span>}
        </h3>
        <p className="text-sm text-base-content/60">
          {account.availableModelCount} models
          {account.source === undefined ? '' : ` · ${account.source}`}
        </p>
        <QuotaBars account={account} />
        {account.belowReserve === null ? null : (
          <div role="alert" className="alert alert-warning alert-soft text-sm">
            {percent(account.belowReserve.left)} of {account.belowReserve.window} left, below its
            reserve of {percent(account.belowReserve.reserve)}: routing calls it last
          </div>
        )}
        {account.cooldowns.map((cooldown) => (
          <div
            key={`${cooldown.model ?? ''}-${String(cooldown.until)}`}
            role="alert"
            className="alert alert-soft text-sm"
          >
            Cooling {cooldown.model ?? 'every model'} after {cooldown.reason},{' '}
            {until(cooldown.until, now)}
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * Groups the logins by the provider they log in to, in the order the providers first appear,
 * each provider's logins in routing order.
 *
 * @param accounts - the logins, in pi's order
 * @returns one group per provider
 */
function providerGroups(
  accounts: readonly Account[]
): { readonly base: string; readonly logins: readonly Account[] }[] {
  const groups = new Map<string, Account[]>()
  for (const account of accounts) {
    groups.set(account.base, [...(groups.get(account.base) ?? []), account])
  }
  return [...groups].map(([base, logins]) => ({
    base,
    logins: logins.toSorted(
      (left, right) => (left.place?.position ?? 0) - (right.place?.position ?? 0)
    )
  }))
}

/**
 * The Accounts page.
 *
 * @returns the page
 */
export function AccountsPage(): ReactElement {
  const query = useQuery({
    queryKey: ['accounts'],
    queryFn: () => readApi('/accounts', AccountsSchema)
  })
  return (
    <Loaded query={query}>
      {(accounts) =>
        accounts.length === 0 ? (
          <p className="p-4 text-base-content/60">No logins yet: see the Logins page.</p>
        ) : (
          <div className="flex flex-col gap-6">
            {providerGroups(accounts).map((group) => (
              <section key={group.base} className="flex flex-col gap-2">
                <h2 className="text-lg font-semibold">
                  {group.base}{' '}
                  <span className="text-sm text-base-content/60">
                    {group.logins.length} {group.logins.length === 1 ? 'login' : 'logins'}
                  </span>
                </h2>
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                  {group.logins.map((account) => (
                    <AccountCard key={account.provider} account={account} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )
      }
    </Loaded>
  )
}
