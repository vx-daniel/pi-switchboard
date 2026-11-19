/**
 * The Models page (#367): the models a client can name, the aliases and what each points at, and
 * why any is left out.
 *
 * @packageDocumentation
 */

import { aliasText } from '@proxy/admin/web/alias-text'
import { type Exposed, type Models, ModelsSchema, readApi } from '@proxy/admin/web/api'
import { DataTable } from '@proxy/admin/web/data-table'
import { tokens } from '@proxy/admin/web/format'
import { Loaded } from '@proxy/admin/web/loaded'
import { useQuery } from '@tanstack/react-query'
import type { ReactElement } from 'react'

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

/**
 * Shows the aliases: the configured ones, then the built-in `-latest` ones.
 *
 * @param list - the models data
 * @param list.models - the exposure, for which aliases a client can name now
 * @returns the table
 */
function AliasesTable(list: { readonly models: Models }): ReactElement {
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
            <div className="flex gap-1">
              {row.builtIn ? <span className="badge badge-ghost badge-xs">built in</span> : null}
              {exposed.has(row.name) ? null : (
                <span className="badge badge-warning badge-xs">left out</span>
              )}
            </div>
          </td>
        </tr>
      ))}
    </DataTable>
  )
}

/**
 * Shows the Models page's data.
 *
 * @param view - the data
 * @param view.models - the exposure, the aliases and their diagnostics
 * @returns the page's content
 */
function ModelsView(view: { readonly models: Models }): ReactElement {
  const { models } = view
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
        <h2 className="text-lg font-semibold">Aliases</h2>
        <AliasesTable models={models} />
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
 * The Models page.
 *
 * @returns the page
 */
export function ModelsPage(): ReactElement {
  const query = useQuery({ queryKey: ['models'], queryFn: () => readApi('/models', ModelsSchema) })
  return <Loaded query={query}>{(models) => <ModelsView models={models} />}</Loaded>
}
