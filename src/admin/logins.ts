/**
 * The admin UI's login routing (#367, phase 2): putting a login first, disabling or enabling it,
 * labelling it, and ending cooldowns, through the console's own writers
 * (`src/config/login-routing.ts`, `clearCooldownsAnswer`), each logged for audit.
 *
 * @remarks
 * None of these touches a credential: a disabled login keeps its credential in pi's store, and a
 * label is the operator's note beside the proxy's settings. Disabling a provider's only enabled
 * login withdraws its models, so it needs a confirmation, as the console asks for one.
 *
 * @packageDocumentation
 */

import { badRequest, fileUnusable, notFound, notWritten, type Refusal } from '@proxy/admin/answers'
import {
  loginPlaces,
  saveLoginDisabled,
  saveLoginFirst,
  saveLoginLabel
} from '@proxy/config/login-routing'
import { loadConfigFromFile } from '@proxy/config/schema'
import { proxyLogger } from '@proxy/logging'
import type { ModelExposureResult } from '@proxy/openai/model-exposure'
import { getCredentialStatuses } from '@proxy/pi/registry'
import { clearCooldownsAnswer, type CooldownView } from '@proxy/server/cooldowns'
import { HTTP_OK } from '@proxy/server/http-status'

/** Logger for the changes operators make. */
const auditLogger = proxyLogger('admin', 'audit')

/** A change to one login: who makes it, and which login. */
export interface LoginChange {
  /** The operator, an editor, for the audit line. */
  readonly operator: string
  /** The login, as pi names it (`anthropic-account-2`). */
  readonly login: string
}

/**
 * Reads the logins pi has a credential for, and refuses a change to any other.
 *
 * @param login - the login the change names
 * @returns every login, or the refusal
 */
async function knownLogins(login: string): Promise<readonly string[] | Refusal> {
  const logins = (await getCredentialStatuses(false)).map((account) => account.provider)
  return logins.includes(login) ? logins : notFound('unknown_login', `There is no login ${login}.`)
}

/**
 * Checks that a change can be made: the file can be written, and the login exists.
 *
 * @param login - the login
 * @returns every login, or the refusal
 */
async function writable(login: string): Promise<readonly string[] | Refusal> {
  return fileUnusable() ?? (await knownLogins(login))
}

/**
 * Puts a login first among its provider's logins.
 *
 * @param change - who, and which login
 * @returns why it was refused, or `undefined` when it was saved
 */
export async function useLoginFirst(change: LoginChange): Promise<Refusal | undefined> {
  const logins = await writable(change.login)
  if ('status' in logins) return logins
  if (!saveLoginFirst(change.login, logins)) return notWritten()
  auditLogger.info('{operator} put login {login} first', { ...change })
  return undefined
}

/** Disabling or enabling a login. */
export interface LoginDisabledChange extends LoginChange {
  readonly disabled: boolean
  /** Whether the operator confirmed disabling the provider's only enabled login. */
  readonly confirmed: boolean
}

/**
 * Disables a login, so routing never calls it, or enables it again.
 *
 * @param change - who, which login, and whether to disable it
 * @returns why it was refused, or `undefined` when it was saved
 */
export async function setLoginDisabled(change: LoginDisabledChange): Promise<Refusal | undefined> {
  const logins = await writable(change.login)
  if ('status' in logins) return logins
  const place = loginPlaces(logins, loadConfigFromFile().routing.logins).get(change.login)
  if (change.disabled && place?.lastEnabled === true && !change.confirmed) {
    return badRequest(
      'confirm_required',
      `${change.login} is its provider's only enabled login: disabling it withdraws the provider's models.`
    )
  }
  if (!saveLoginDisabled(change.login, change.disabled)) return notWritten()
  auditLogger.info(
    change.disabled ? '{operator} disabled login {login}' : '{operator} enabled login {login}',
    {
      operator: change.operator,
      login: change.login
    }
  )
  return undefined
}

/**
 * Sets a login's label, or removes it when the label is empty.
 *
 * @param change - who, and which login
 * @param label - the label; empty removes it
 * @returns why it was refused, or `undefined` when it was saved
 */
export async function setLoginLabel(
  change: LoginChange,
  label: string
): Promise<Refusal | undefined> {
  const logins = await writable(change.login)
  if ('status' in logins) return logins
  const before = loadConfigFromFile().labels[change.login] ?? 'none'
  if (!saveLoginLabel(change.login, label)) return notWritten()
  auditLogger.info('{operator} labelled login {login}: {before} to {after}', {
    ...change,
    before,
    after: label.trim() === '' ? 'none' : label.trim()
  })
  return undefined
}

/** Which cooldowns to end: a login's, a model's, or (neither named) every one. */
export interface CooldownsChange {
  /** The operator, an editor, for the audit line. */
  readonly operator: string
  readonly provider: string | undefined
  readonly model: string | undefined
}

/**
 * Ends cooldowns early, as the console's `c` and `DELETE /v1/switchboard/cooldowns` do.
 *
 * @param change - who, and which cooldowns
 * @param exposure - reads the exposure, to check a name no cooldown matches
 * @param now - the current time
 * @returns the cooldowns ended, or why the name was refused
 */
export async function endCooldowns(
  change: CooldownsChange,
  exposure: () => Promise<ModelExposureResult>,
  now: number
): Promise<readonly CooldownView[] | Refusal> {
  const answer = await clearCooldownsAnswer(
    { provider: change.provider, model: change.model },
    exposure,
    now
  )
  if (answer.status !== HTTP_OK) {
    const { param, message } = answer.body.error
    return notFound(param === 'model' ? 'unknown_model' : 'unknown_login', message)
  }
  auditLogger.info('{operator} ended {ended} cooldowns of {scope}', {
    operator: change.operator,
    ended: answer.body.data.length,
    scope: change.provider ?? change.model ?? 'every login'
  })
  return answer.body.data
}
