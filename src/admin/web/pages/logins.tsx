/**
 * The Logins page (#367): how to add a provider login. Logging in never happens over the web
 * (constitution, Scope): pi runs every login, in a terminal on the machine the proxy runs on.
 *
 * @packageDocumentation
 */

import type { ReactElement } from 'react'

/** Each way the proxy can run, and the command that logs in there. */
const WAYS = [
  { where: 'On this machine', command: 'pi auth login <provider>' },
  { where: 'In Docker', command: 'docker exec -it <container> pi auth login <provider>' },
  { where: 'In the console', command: 'pi-switchboard tui   # Accounts, then the login row' }
] as const

/**
 * The Logins page.
 *
 * @returns the page
 */
export function LoginsPage(): ReactElement {
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <p>
        Logins are added in a terminal on the machine the proxy runs on, never here: this page
        cannot see or change a credential.
      </p>
      {WAYS.map((way) => (
        <div key={way.where} className="flex flex-col gap-1">
          <h2 className="font-semibold">{way.where}</h2>
          <pre className="rounded-box bg-base-200 p-3 font-mono text-sm">{way.command}</pre>
        </div>
      ))}
    </div>
  )
}
