/**
 * What an editor does to a login on the Accounts page (#367, phase 2), as the console's account
 * menu does: put it first among its provider's logins, disable or enable it, label it, and end its
 * cooldowns. Logging in and out stay in a terminal; nothing here touches a credential.
 *
 * @packageDocumentation
 */

import {
  type Account,
  AccountsSchema,
  ApiError,
  EndedCooldownsSchema,
  sendApi
} from '@proxy/admin/web/api'
import { type UseMutationResult, useMutation, useQueryClient } from '@tanstack/react-query'
import { type ReactElement, useState } from 'react'

/** A change to the logins. */
export type LoginWrite =
  | { readonly kind: 'first'; readonly login: string }
  | {
      readonly kind: 'disabled'
      readonly login: string
      readonly disabled: boolean
      readonly confirm: boolean
    }
  | { readonly kind: 'label'; readonly login: string; readonly label: string }
  | { readonly kind: 'cooldowns'; readonly login: string | undefined }

/**
 * Sends a change to the logins.
 *
 * @param write - the change
 * @returns the Accounts page's data after it, or `undefined` after ending cooldowns
 */
async function sendLogin(write: LoginWrite): Promise<Account[] | undefined> {
  if (write.kind === 'cooldowns') {
    const query = write.login === undefined ? '' : `?provider=${encodeURIComponent(write.login)}`
    await sendApi({ method: 'DELETE', path: `/cooldowns${query}` }, EndedCooldownsSchema)
    return undefined
  }
  const path = `/logins/${encodeURIComponent(write.login)}`
  switch (write.kind) {
    case 'first':
      return sendApi({ method: 'POST', path: `${path}/first` }, AccountsSchema)
    case 'disabled':
      return sendApi(
        {
          method: 'PUT',
          path: `${path}/disabled`,
          body: { disabled: write.disabled, confirm: write.confirm }
        },
        AccountsSchema
      )
    case 'label':
    default:
      return sendApi(
        { method: 'PUT', path: `${path}/label`, body: { label: write.label } },
        AccountsSchema
      )
  }
}

/**
 * Says whether a refusal asks the operator to confirm the change: only an unconfirmed one does.
 *
 * @param error - why the change failed
 * @param write - the change
 * @returns whether to ask them
 */
function asksToConfirm(error: Error, write: LoginWrite): boolean {
  return (
    error instanceof ApiError &&
    error.code === 'confirm_required' &&
    write.kind === 'disabled' &&
    !write.confirm
  )
}

/**
 * The Accounts page's writes: each answers with the page's data, or for cooldowns has the
 * accounts and the status strip read again. Disabling a provider's last enabled login asks once.
 *
 * @returns the mutation
 */
export function useLoginWrites(): UseMutationResult<Account[] | undefined, Error, LoginWrite> {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: sendLogin,
    onSuccess: async (accounts) => {
      if (accounts === undefined) {
        await queryClient.invalidateQueries({ queryKey: ['accounts'] })
        await queryClient.invalidateQueries({ queryKey: ['status'] })
      } else {
        queryClient.setQueryData(['accounts'], accounts)
      }
    },
    onError: (error, write) => {
      if (
        write.kind === 'disabled' &&
        asksToConfirm(error, write) &&
        window.confirm(error.message)
      ) {
        mutation.mutate({ ...write, confirm: true })
      }
    }
  })
  return mutation
}

/**
 * Says why the last change to a login was refused, unless it only asked for a confirmation.
 *
 * @param mutation - the writes
 * @param login - the login
 * @returns the message, or `undefined`
 */
export function refusalFor(
  mutation: UseMutationResult<Account[] | undefined, Error, LoginWrite>,
  login: string
): string | undefined {
  const { error, variables } = mutation
  if (!(error instanceof ApiError) || variables === undefined || variables.login !== login) {
    return undefined
  }
  return asksToConfirm(error, variables) ? undefined : error.message
}

/** What a login's actions are given. */
interface AccountActionsView {
  readonly account: Account
  readonly write: (write: LoginWrite) => void
  readonly busy: boolean
}

/**
 * An editor's actions on one login.
 *
 * @param actions - the login, and how to change it
 * @returns the buttons, and the label field while it is open
 */
export function AccountActions(actions: AccountActionsView): ReactElement {
  const { account, write } = actions
  const { place } = account
  const [labelling, setLabelling] = useState(false)
  const [label, setLabel] = useState(account.label ?? '')
  const disabled = place?.disabled === true
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1">
        {place !== null && place.count > 1 && !place.first && !disabled ? (
          <button
            type="button"
            className="btn btn-xs"
            disabled={actions.busy}
            onClick={() => {
              write({ kind: 'first', login: account.provider })
            }}
          >
            Use first
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-xs"
          disabled={actions.busy}
          onClick={() => {
            write({
              kind: 'disabled',
              login: account.provider,
              disabled: !disabled,
              confirm: false
            })
          }}
        >
          {disabled ? 'Enable' : 'Disable'}
        </button>
        <button
          type="button"
          className="btn btn-xs"
          onClick={() => {
            setLabelling(!labelling)
          }}
        >
          Label…
        </button>
        {account.cooldowns.length === 0 ? null : (
          <button
            type="button"
            className="btn btn-xs"
            disabled={actions.busy}
            onClick={() => {
              write({ kind: 'cooldowns', login: account.provider })
            }}
          >
            End cooldowns
          </button>
        )}
      </div>
      {labelling ? (
        <div className="flex gap-2">
          <input
            className="input input-xs w-48"
            aria-label={`Label for ${account.provider}`}
            placeholder="work, personal…"
            value={label}
            onChange={(event) => {
              setLabel(event.target.value)
            }}
          />
          <button
            type="button"
            className="btn btn-xs"
            disabled={actions.busy}
            onClick={() => {
              write({ kind: 'label', login: account.provider, label })
              setLabelling(false)
            }}
          >
            Save
          </button>
        </div>
      ) : null}
    </div>
  )
}
