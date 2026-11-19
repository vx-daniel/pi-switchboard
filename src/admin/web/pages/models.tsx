/**
 * The Models page (#367): the models a client can name, the aliases and what each points at, and
 * why any is left out. An editor adds, edits, renames and deletes the configured aliases here, as
 * in the console's Models view; the built-in `-latest` ones are not the config's to change.
 *
 * @packageDocumentation
 */

import { type AliasDraft, aliasText, draftBody, draftOf } from '@proxy/admin/web/alias-draft'
import { AliasEditor } from '@proxy/admin/web/alias-editor'
import {
  ApiError,
  type Exposed,
  type Models,
  ModelsSchema,
  readApi,
  sendApi
} from '@proxy/admin/web/api'
import { DataTable } from '@proxy/admin/web/data-table'
import { tokens } from '@proxy/admin/web/format'
import { Loaded } from '@proxy/admin/web/loaded'
import type { PageView } from '@proxy/admin/web/router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactElement, useState } from 'react'

/** The query's key. */
const MODELS_KEY = ['models'] as const

/** The alias being edited: its name, the name it had (absent for a new one), and its draft. */
interface Editing {
  readonly name: string
  readonly previousName: string | undefined
  readonly draft: AliasDraft
}

/** A write to the aliases: a save, or a delete. */
type AliasWrite =
  | {
      readonly kind: 'save'
      readonly name: string
      readonly previousName: string | undefined
      readonly draft: AliasDraft
    }
  | { readonly kind: 'delete'; readonly name: string }

/**
 * Shows the exposed models.
 *
 * @param table - the models
 * @param table.models - each model a client can name
 * @returns the table
 */
function ModelsTable(table: { readonly models: readonly Exposed[] }): ReactElement {
  return (
    <DataTable headings={['Model', 'Provider', 'Context', 'Reasoning', 'Input']}>
      {table.models.map((model) => (
        <tr key={`${model.provider}/${model.id}`}>
          <td className="font-mono text-xs">{model.id}</td>
          <td>{model.provider}</td>
          <td>{model.context_window === undefined ? '' : tokens(model.context_window)}</td>
          <td>
            <div className="flex flex-wrap gap-1">
              {model.reasoning_efforts.map((effort) => (
                <span key={effort} className="badge badge-ghost badge-xs">
                  {effort}
                </span>
              ))}
            </div>
          </td>
          <td className="text-xs">{model.input.join(', ')}</td>
        </tr>
      ))}
    </DataTable>
  )
}

/** What the aliases table is given. */
interface AliasesView {
  readonly models: Models
  /** Whether the operator may change aliases. */
  readonly editor: boolean
  readonly onEdit: (name: string) => void
  readonly onDelete: (name: string) => void
}

/**
 * Shows the aliases: the configured ones, then the built-in `-latest` ones.
 *
 * @param list - the models data, and for an editor how to edit an alias
 * @returns the table
 */
function AliasesTable(list: AliasesView): ReactElement {
  const exposed = new Set(list.models.aliases.map((alias) => alias.id))
  const rows = [
    ...Object.entries(list.models.configured).map(([name, target]) => ({
      name,
      target,
      builtIn: false
    })),
    ...Object.entries(list.models.latest).map(([name, target]) => ({ name, target, builtIn: true }))
  ]
  if (rows.length === 0) return <p className="text-base-content/60">No aliases.</p>
  return (
    <DataTable headings={['Alias', 'Points at', '']}>
      {rows.map((row) => (
        <tr key={row.name}>
          <td className="font-mono text-xs">{row.name}</td>
          <td className="font-mono text-xs">{aliasText(row.target)}</td>
          <td>
            <div className="flex items-center gap-1">
              {row.builtIn ? <span className="badge badge-ghost badge-xs">built in</span> : null}
              {exposed.has(row.name) ? null : (
                <span className="badge badge-warning badge-xs">left out</span>
              )}
              {list.editor && !row.builtIn ? (
                <>
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs"
                    onClick={() => {
                      list.onEdit(row.name)
                    }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs"
                    onClick={() => {
                      list.onDelete(row.name)
                    }}
                  >
                    Delete
                  </button>
                </>
              ) : null}
            </div>
          </td>
        </tr>
      ))}
    </DataTable>
  )
}

/** What the Models page's content is given. */
interface ModelsContent {
  readonly models: Models
  readonly editor: boolean
  readonly write: (write: AliasWrite) => void
  readonly busy: boolean
  readonly error: string | undefined
  /** The alias being edited, or `null`. */
  readonly editing: Editing | null
  readonly onEditing: (editing: Editing | null) => void
}

/**
 * Shows the Models page's data, and for an editor the alias editor.
 *
 * @param view - the data, and what an editor changes
 * @returns the page's content
 */
function ModelsView(view: ModelsContent): ReactElement {
  const { models, editing } = view
  const edit = (name: string): void => {
    const draft = draftOf(models.configured[name])
    if (draft !== undefined) view.onEditing({ name, previousName: name, draft })
  }
  const firstModel = models.options.models[0]?.id
  return (
    <div className="flex flex-col gap-6">
      {models.modelsJsonError === null ? null : (
        <div role="alert" className="alert alert-warning">
          models.json: {models.modelsJsonError}
        </div>
      )}
      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">
          Models{' '}
          <span className="text-base-content/60 text-sm">
            {models.models.length} of {models.available} available
          </span>
        </h2>
        <ModelsTable models={models.models} />
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          Aliases
          {view.editor && editing === null && firstModel !== undefined ? (
            <button
              type="button"
              className="btn btn-xs"
              onClick={() => {
                view.onEditing({
                  name: '',
                  previousName: undefined,
                  draft: {
                    targets: [{ kind: 'model', model: firstModel, effort: null }],
                    fallbackOn: []
                  }
                })
              }}
            >
              + New alias
            </button>
          ) : null}
        </h2>
        {editing === null ? null : (
          <AliasEditor
            key={editing.previousName ?? ''}
            options={models.options}
            name={editing.name}
            draft={editing.draft}
            busy={view.busy}
            error={view.error}
            onSave={(name, draft) => {
              view.write({ kind: 'save', name, previousName: editing.previousName, draft })
            }}
            onCancel={() => {
              view.onEditing(null)
            }}
          />
        )}
        <AliasesTable
          models={models}
          editor={view.editor}
          onEdit={edit}
          onDelete={(name) => {
            if (window.confirm(`Delete the alias ${name}? Requests naming it will fail.`)) {
              view.write({ kind: 'delete', name })
            }
          }}
        />
        {models.aliasDiagnostics.map((diagnostic) => (
          <div
            key={`${diagnostic.alias ?? ''}-${diagnostic.message}`}
            role="alert"
            className="alert alert-soft text-sm"
          >
            {diagnostic.message}
          </div>
        ))}
      </section>
    </div>
  )
}

/**
 * Sends a write to the aliases.
 *
 * @param write - a save or a delete
 * @returns the Models page's data after it
 */
function sendAlias(write: AliasWrite): Promise<Models> {
  const path = `/aliases/${encodeURIComponent(write.name)}`
  return write.kind === 'save'
    ? sendApi(
        { method: 'PUT', path, body: draftBody(write.draft, write.previousName) },
        ModelsSchema
      )
    : sendApi({ method: 'DELETE', path }, ModelsSchema)
}

/**
 * The Models page.
 *
 * @param page - who is signed in, as every page is given it
 * @returns the page
 */
export function ModelsPage(page: PageView): ReactElement {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState<Editing | null>(null)
  const query = useQuery({ queryKey: MODELS_KEY, queryFn: () => readApi('/models', ModelsSchema) })
  const mutation = useMutation({
    mutationFn: sendAlias,
    onSuccess: (models) => {
      queryClient.setQueryData(MODELS_KEY, models)
      setEditing(null)
    }
  })
  return (
    <Loaded query={query}>
      {(models) => (
        <ModelsView
          models={models}
          editor={page.editor}
          write={(write) => {
            mutation.mutate(write)
          }}
          busy={mutation.isPending}
          error={mutation.error instanceof ApiError ? mutation.error.message : undefined}
          editing={editing}
          onEditing={(next) => {
            mutation.reset()
            setEditing(next)
          }}
        />
      )}
    </Loaded>
  )
}
