/**
 * The console's doctor (#325): judges the running proxy as `pi-switchboard doctor` would (#299),
 * from what the console already holds, for the Doctor view and its tab's count.
 *
 * @remarks
 * The inputs are live: the running server's settings and the proxy auth `p` applies now, the
 * request config and logins of the last status read, the last verification from the Accounts
 * view (`v`), and the stats through the Stats view's open file, over the window the two views
 * share. Nothing calls a provider or writes a file: a login never verified is reported as not
 * verified, pointing at `v`. `PI_CACHE_RETENTION` is the proxy's own, since the console is the
 * proxy's process.
 *
 * @packageDocumentation
 */

import { type DoctorInputs, judgeDoctorInputs, serverSettingsOf } from '@proxy/doctor/collect'
import type { CredentialsInput, DoctorReport } from '@proxy/doctor/findings'
import {
  getLoginRegistration,
  type LoginRegistration,
  type ProviderCredentialStatus
} from '@proxy/pi/registry'
import type { ConsoleContext } from '@proxy/tui/console'
import type { Status } from '@proxy/tui/console-state'

/** What the doctor reads of the console. */
export type DoctorConsole = Pick<ConsoleContext, 'config' | 'state' | 'proxyAuth' | 'statsView'>

/** How long a report is reused while nothing it reads has changed, in milliseconds. */
const REPORT_MS = 5000

/** The not-verified advice's recommendation in the console: the Accounts view's `v`. */
const HOW_TO_VERIFY =
  'Verify the logins in the Accounts view (v; as /healthz/creds?verify=true, it may refresh an OAuth token).'

/**
 * Builds the credentials the doctor judges from the logins the console last read, each with the
 * Accounts view's last verification merged in (`status-refresh.ts`). No credential is resolved.
 *
 * @param accounts - the logins, with their last verification where they have one
 * @param logins - whether pi's credential store could be listed at startup
 * @returns the credentials input: `verified` once every login has a result
 */
export function consoleCredentials(
  accounts: readonly ProviderCredentialStatus[],
  logins: LoginRegistration
): CredentialsInput {
  return {
    verified: accounts.every((account) => account.verified !== undefined),
    loginsRegistered: logins.registered,
    ...(logins.registered ? {} : { loginsError: logins.reason }),
    providers: accounts,
    howToVerify: HOW_TO_VERIFY
  }
}

/**
 * Gathers the doctor's inputs from the console.
 *
 * @param context - the console
 * @param status - the last status read
 * @returns the inputs
 */
function doctorInputs(context: DoctorConsole, status: Status): DoctorInputs {
  const { config, state } = context
  return {
    server: serverSettingsOf(config, context.proxyAuth.current().kind === 'token'),
    requestConfig: status.requestConfig,
    credentials: consoleCredentials(state.accounts, getLoginRegistration()),
    configFileProblem: status.fileProblem,
    stats: context.statsView.doctorStats(state.statsWindow),
    window: state.statsWindow
  }
}

/**
 * Lists what a report depends on, to tell when it must be judged again: the window, the last
 * status and accounts read, the running config and Stats view (a restart replaces both), and the
 * proxy auth.
 *
 * @param context - the console
 * @returns the parts, compared by identity
 */
function reportKey(context: DoctorConsole): readonly unknown[] {
  const { state } = context
  return [
    state.statsWindow,
    state.status,
    state.accounts,
    context.config,
    context.statsView,
    context.proxyAuth.current().kind
  ]
}

/**
 * Creates the console's doctor: judged again when what it reads changes (a status read every few
 * seconds, `v`, `p`, a window key, a restart), and at most every {@link REPORT_MS} otherwise, so
 * the tab's count on every redraw costs nothing.
 *
 * @param now - the clock
 * @returns a function from the console to its report; `undefined` before the first status read
 */
export function createDoctorSource(
  now: () => number = Date.now
): (context: DoctorConsole) => DoctorReport | undefined {
  let cached: { key: readonly unknown[]; at: number; report: DoctorReport } | undefined
  return (context) => {
    const { status } = context.state
    if (status === undefined) return undefined
    const key = reportKey(context)
    const at = now()
    const previous = cached
    if (
      previous !== undefined &&
      at - previous.at < REPORT_MS &&
      key.every((part, index) => part === previous.key[index])
    ) {
      return previous.report
    }
    const report = judgeDoctorInputs(doctorInputs(context, status))
    cached = { key, at, report }
    return report
  }
}
