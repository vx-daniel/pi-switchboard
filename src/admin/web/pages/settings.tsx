/**
 * The Settings page (#367, phase 2): `proxy-config.json`'s settings, grouped as the console's
 * Settings view groups them. An editor changes them here; a viewer only reads them. Proxy auth
 * shows whether a token is set and is changed in the console only.
 *
 * @packageDocumentation
 */

import {
  ApiError,
  putSetting,
  readApi,
  type Setting,
  type Settings,
  SettingsSchema
} from '@proxy/admin/web/api'
import { Loaded } from '@proxy/admin/web/loaded'
import type { PageView } from '@proxy/admin/web/router'
import {
  ChoiceControl,
  IntControl,
  ManyControl,
  PrefixesControl,
  SharesControl,
  SwitchControl,
  TextControl
} from '@proxy/admin/web/setting-controls'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ReactElement } from 'react'

/** The query's key. */
const SETTINGS_KEY = ['settings'] as const

/** The sections, in the console's order, with their headings. */
const SECTIONS = [
  { id: 'server', title: 'Server' },
  { id: 'features', title: 'Features' },
  { id: 'auth', title: 'Proxy auth' },
  { id: 'models', title: 'Models' },
  { id: 'routing', title: 'Routing' }
] as const

/** When a section's settings apply, as the page says it. */
const APPLIES = {
  live: 'applies to the next request',
  restart: 'applies when pi-switchboard restarts'
} as const

/** A change to send: the setting, the value, and whether the operator confirmed it. */
interface Change {
  readonly key: string
  readonly value: unknown
  readonly confirm: boolean
}

/**
 * The control an editor changes a setting with.
 *
 * @param edit - the setting, and how to save it
 * @param edit.setting - the setting
 * @param edit.save - saves a new value
 * @param edit.busy - whether a save is under way
 * @returns the control
 */
function Control(edit: {
  readonly setting: Setting
  readonly save: (value: unknown) => void
  readonly busy: boolean
}): ReactElement {
  const { setting, save, busy } = edit
  const { input } = setting
  switch (input.kind) {
    case 'text':
      return <TextControl setting={{ ...setting, input }} save={save} busy={busy} />
    case 'int':
      return <IntControl setting={{ ...setting, input }} save={save} busy={busy} />
    case 'switch':
      return <SwitchControl setting={{ ...setting, input }} save={save} busy={busy} />
    case 'choice':
      return <ChoiceControl setting={{ ...setting, input }} save={save} busy={busy} />
    case 'many':
      return <ManyControl setting={{ ...setting, input }} save={save} busy={busy} />
    case 'prefixes':
      return <PrefixesControl setting={{ ...setting, input }} save={save} busy={busy} />
    case 'shares':
      return <SharesControl setting={{ ...setting, input }} save={save} busy={busy} />
    case 'console':
    default:
      return <span className="text-sm text-base-content/60">Change it in the console (p).</span>
  }
}

/**
 * One setting: its name, value, what holds it, its help and, for an editor, its control.
 *
 * @param row - the setting and the edit
 * @param row.setting - the setting
 * @param row.editor - whether the operator may change it
 * @param row.save - saves a new value
 * @param row.busy - whether a save is under way
 * @param row.error - why the last save of this setting was refused, if it was
 * @returns the row
 */
function SettingRow(row: {
  readonly setting: Setting
  readonly editor: boolean
  readonly save: (value: unknown) => void
  readonly busy: boolean
  readonly error: string | undefined
}): ReactElement {
  const { setting } = row
  return (
    <div className="flex flex-col gap-1 border-b border-base-300 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{setting.label}</span>
        <span className="font-mono text-sm">{setting.saved}</span>
        {setting.running === undefined ? null : (
          <span className="badge badge-warning badge-sm">running {setting.running}</span>
        )}
        {setting.override === undefined ? null : (
          <span className="badge badge-ghost badge-sm">held by {setting.override}</span>
        )}
      </div>
      <p className="text-sm text-base-content/60">{setting.help}</p>
      {row.editor ? <Control setting={setting} save={row.save} busy={row.busy} /> : null}
      {row.error === undefined ? null : (
        <div role="alert" className="alert alert-error alert-soft text-sm">
          {row.error}
        </div>
      )}
    </div>
  )
}

/**
 * Shows the settings.
 *
 * @param view - the settings and what the operator may do
 * @param view.settings - the page's data
 * @param view.editor - whether the operator may change them
 * @param view.save - sends a change
 * @param view.saving - the setting being saved, if one is
 * @param view.failed - the setting whose last save was refused, and why
 * @returns the page's content
 */
function SettingsView(view: {
  readonly settings: Settings
  readonly editor: boolean
  readonly save: (change: Change) => void
  readonly saving: string | undefined
  readonly failed: { readonly key: string; readonly message: string } | undefined
}): ReactElement {
  const { settings } = view
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-base-content/60">
        Saved to <span className="font-mono">{settings.path}</span>
        {view.editor ? '' : ' · read only: only an editor may change them'}
      </p>
      {settings.fileProblem === null ? null : (
        <div role="alert" className="alert alert-error">
          proxy-config.json {settings.fileProblem}: fix or remove it first; nothing is saved over
          it.
        </div>
      )}
      {settings.pendingRestart === 0 ? null : (
        <div role="alert" className="alert alert-warning alert-soft">
          {settings.pendingRestart} saved{' '}
          {settings.pendingRestart === 1 ? 'setting is' : 'settings are'} not running yet: restart
          pi-switchboard (or its container) to apply.
        </div>
      )}
      {SECTIONS.map((section) => {
        const rows = settings.settings.filter((setting) => setting.section === section.id)
        if (rows.length === 0) return null
        return (
          <section key={section.id} className="rounded-box bg-base-100 px-4 py-2">
            <h2 className="pt-2 text-xs font-semibold tracking-wider text-base-content/60">
              {section.title.toUpperCase()} · {APPLIES[rows[0]?.applies ?? 'live']}
            </h2>
            {rows.map((setting) => (
              <SettingRow
                key={setting.key}
                setting={setting}
                editor={view.editor}
                busy={view.saving === setting.key}
                error={view.failed?.key === setting.key ? view.failed.message : undefined}
                save={(value) => {
                  view.save({ key: setting.key, value, confirm: false })
                }}
              />
            ))}
          </section>
        )
      })}
    </div>
  )
}

/**
 * Says whether a refusal asks the operator to confirm the change: only an unconfirmed one does.
 *
 * @param error - why the change failed
 * @param change - the change
 * @returns whether to ask them
 */
function asksToConfirm(error: Error, change: Change): boolean {
  return error instanceof ApiError && error.code === 'confirm_required' && !change.confirm
}

/**
 * The Settings page.
 *
 * @param page - who is signed in, as every page is given it
 * @returns the page
 */
export function SettingsPage(page: PageView): ReactElement {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: () => readApi('/settings', SettingsSchema)
  })
  const mutation = useMutation({
    mutationFn: (change: Change) => putSetting(change.key, change.value, change.confirm),
    onSuccess: (settings) => {
      queryClient.setQueryData(SETTINGS_KEY, settings)
    },
    onError: (error, change) => {
      // The proxy asks before listening beyond this machine with auth off, as the console does.
      // Asked once: a confirmed change it still refuses shows its refusal instead.
      if (asksToConfirm(error, change) && window.confirm(error.message)) {
        mutation.mutate({ ...change, confirm: true })
      }
    }
  })
  const { error, variables } = mutation
  const failed =
    error instanceof ApiError && variables !== undefined && !asksToConfirm(error, variables)
      ? { key: variables.key, message: error.message }
      : undefined
  return (
    <Loaded query={query}>
      {(settings) => (
        <SettingsView
          settings={settings}
          editor={page.editor}
          save={(change) => {
            mutation.mutate(change)
          }}
          saving={mutation.isPending ? mutation.variables.key : undefined}
          failed={failed}
        />
      )}
    </Loaded>
  )
}
