/**
 * The Stats page's budget editor (#366): an editor sets each project's budget per window, in US
 * dollars, or removes it. The proxy saves it to `proxy-config.json` and logs who changed it;
 * budgets are reported beside each project's usage and in the doctor, never enforced.
 *
 * @packageDocumentation
 */

import { type Budgets, BudgetsSchema, readApi, sendApi } from '@proxy/admin/web/api'
import { Loaded } from '@proxy/admin/web/loaded'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactElement, useState } from 'react'

/** The stats windows a budget is set for, in the order the editor shows them. */
const WINDOWS = ['today', 'week', 'all'] as const

/** One stats window. */
type BudgetWindow = (typeof WINDOWS)[number]

/** A budget as typed: each window's amount as text, empty for none. */
type BudgetDraft = Readonly<Record<BudgetWindow, string>>

/** A change to one project's budget: its windows, or `undefined` to remove it. */
interface BudgetWrite {
  readonly project: string
  readonly draft: BudgetDraft | undefined
}

/**
 * Turns a project's budget into what its inputs show.
 *
 * @param budget - the saved budget, or `undefined` for a new project
 * @returns each window's amount as text
 */
function draftOf(budget: Budgets[string] | undefined): BudgetDraft {
  return {
    today: budget?.today?.toString() ?? '',
    week: budget?.week?.toString() ?? '',
    all: budget?.all?.toString() ?? ''
  }
}

/**
 * Turns what was typed into the body the proxy takes: the windows with an amount. The proxy
 * refuses one that isn't a number above 0 and says why.
 *
 * @param draft - each window's amount as text
 * @returns window -> amount
 */
function bodyOf(draft: BudgetDraft): Partial<Record<BudgetWindow, number>> {
  return Object.fromEntries(
    WINDOWS.filter((window) => draft[window].trim() !== '').map((window) => [
      window,
      Number(draft[window])
    ])
  )
}

/**
 * Sends a change to one project's budget.
 *
 * @param write - the project, and its windows or `undefined` to remove it
 * @returns the budgets after it
 */
function sendBudget(write: BudgetWrite): Promise<Budgets> {
  const path = `/budgets/${encodeURIComponent(write.project)}`
  const sent =
    write.draft === undefined
      ? sendApi({ method: 'DELETE', path }, BudgetsSchema)
      : sendApi({ method: 'PUT', path, body: bodyOf(write.draft) }, BudgetsSchema)
  return sent.then((answer) => answer.budgets)
}

/** What one project's row is given. */
interface BudgetRowView {
  /** The project, or `undefined` for the row that adds one. */
  readonly project: string | undefined
  readonly budget: Budgets[string] | undefined
  readonly busy: boolean
  readonly write: (change: BudgetWrite) => void
}

/**
 * One project's budget, or the row that adds a project.
 *
 * @param row - the project, its budget, and how to change it
 * @returns the row
 */
function BudgetRow(row: BudgetRowView): ReactElement {
  const [project, setProject] = useState(row.project ?? '')
  const [draft, setDraft] = useState(draftOf(row.budget))
  const name = row.project ?? 'the new project'
  return (
    <tr>
      <td>
        {row.project === undefined ? (
          <input
            className="input input-xs w-56 font-mono"
            aria-label="New project"
            placeholder="owner/repository"
            value={project}
            onChange={(event) => {
              setProject(event.target.value)
            }}
          />
        ) : (
          <span className="font-mono text-xs">{row.project}</span>
        )}
      </td>
      {WINDOWS.map((window) => (
        <td key={window}>
          <input
            className="input input-xs w-24"
            inputMode="decimal"
            aria-label={`${window} budget for ${name}`}
            placeholder="none"
            value={draft[window]}
            onChange={(event) => {
              setDraft({ ...draft, [window]: event.target.value })
            }}
          />
        </td>
      ))}
      <td className="flex gap-1">
        <button
          type="button"
          className="btn btn-xs"
          disabled={row.busy || project.trim() === ''}
          onClick={() => {
            row.write({ project: project.trim(), draft })
          }}
        >
          {row.project === undefined ? 'Add' : 'Save'}
        </button>
        {row.project === undefined ? null : (
          <button
            type="button"
            className="btn btn-xs"
            disabled={row.busy}
            onClick={() => {
              row.write({ project: project.trim(), draft: undefined })
            }}
          >
            Remove
          </button>
        )}
      </td>
    </tr>
  )
}

/**
 * The budget editor, for an editor: each project's budget, and a row to add one.
 *
 * @returns the editor
 */
export function BudgetEditor(): ReactElement {
  const client = useQueryClient()
  const query = useQuery({
    queryKey: ['budgets'],
    queryFn: () => readApi('/budgets', BudgetsSchema)
  })
  const mutation = useMutation({
    mutationFn: sendBudget,
    onSuccess: async (budgets) => {
      client.setQueryData(['budgets'], { budgets })
      // Each project's budget for the window shows in the Projects table.
      await client.invalidateQueries({ queryKey: ['stats'] })
    }
  })
  const write = (change: BudgetWrite): void => {
    mutation.mutate(change)
  }
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold">Budgets</h2>
      <p className="text-sm text-base-content/60">
        US dollars per window, for the projects clients name in X-Switchboard-Project. Reported
        beside each project's spend and by the doctor; never enforced.
      </p>
      {mutation.error === null ? null : (
        <div role="alert" className="alert alert-error alert-soft text-sm">
          {mutation.error.message}
        </div>
      )}
      <Loaded query={query}>
        {(answer) => (
          <table className="table table-sm">
            <thead>
              <tr>
                <th>Project</th>
                {WINDOWS.map((window) => (
                  <th key={window}>{window}</th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {Object.entries(answer.budgets).map(([project, budget]) => (
                <BudgetRow
                  key={`${project} ${JSON.stringify(budget)}`}
                  project={project}
                  budget={budget}
                  busy={mutation.isPending}
                  write={write}
                />
              ))}
              <BudgetRow
                key={Object.keys(answer.budgets).join(' ')}
                project={undefined}
                budget={undefined}
                busy={mutation.isPending}
                write={write}
              />
            </tbody>
          </table>
        )}
      </Loaded>
    </section>
  )
}
