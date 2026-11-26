/**
 * The Stats page (#367): the stats file's usage over a window, as `GET /v1/switchboard/usage`
 * answers it: totals, the timeline, each model's numbers, each project's spend against its budget
 * (#366), and what failed.
 *
 * @packageDocumentation
 */

import { readApi, type StatsWindow, type Usage, UsageSchema } from '@proxy/admin/web/api'
import { BudgetEditor } from '@proxy/admin/web/budget-editor'
import { DataTable } from '@proxy/admin/web/data-table'
import { dollars, duration, percent, tokens } from '@proxy/admin/web/format'
import { Loaded } from '@proxy/admin/web/loaded'
import { Timeline } from '@proxy/admin/web/pages/timeline'
import type { PageView } from '@proxy/admin/web/router'
import { useQuery } from '@tanstack/react-query'
import type { ReactElement } from 'react'

/** The windows, as the picker offers them. */
const WINDOWS: readonly { readonly id: StatsWindow; readonly title: string }[] = [
  { id: 'today', title: 'Today' },
  { id: 'week', title: 'Week' },
  { id: 'all', title: 'All (30 days)' }
]

/**
 * Picks a stats window.
 *
 * @param picker - the window shown, and what to do on a pick
 * @param picker.window - the window shown
 * @param picker.onPick - called with the window picked
 * @returns the buttons
 */
export function WindowPicker(picker: {
  readonly window: StatsWindow
  readonly onPick: (window: StatsWindow) => void
}): ReactElement {
  return (
    <div className="join">
      {WINDOWS.map((option) => (
        <button
          key={option.id}
          type="button"
          className={`btn btn-sm join-item ${option.id === picker.window ? 'btn-primary' : ''}`}
          aria-pressed={option.id === picker.window}
          onClick={() => {
            picker.onPick(option.id)
          }}
        >
          {option.title}
        </button>
      ))}
    </div>
  )
}

/**
 * Shows the window's totals.
 *
 * @param totals - the usage
 * @param totals.usage - the window's numbers
 * @returns the stats
 */
function Totals(totals: { readonly usage: Usage }): ReactElement {
  const { models } = totals.usage
  const sum = (field: (model: Usage['models'][number]) => number): number =>
    models.reduce((total, model) => total + field(model), 0)
  return (
    <div className="stats stats-vertical bg-base-100 sm:stats-horizontal">
      <div className="stat">
        <div className="stat-title">Requests</div>
        <div className="stat-value">{sum((model) => model.requests)}</div>
        <div className="stat-desc">{sum((model) => model.failed)} failed</div>
      </div>
      <div className="stat">
        <div className="stat-title">Tokens</div>
        <div className="stat-value">
          {tokens(sum((model) => model.input_tokens + model.cache_read_tokens))}
        </div>
        <div className="stat-desc">in, {tokens(sum((model) => model.output_tokens))} out</div>
      </div>
      <div className="stat">
        <div className="stat-title">Cost</div>
        <div className="stat-value">{dollars(sum((model) => model.cost_usd))}</div>
        <div className="stat-desc">at list prices</div>
      </div>
    </div>
  )
}

/**
 * Shows each model's numbers.
 *
 * @param table - the usage
 * @param table.usage - the window's numbers
 * @returns the table
 */
function ModelsUsage(table: { readonly usage: Usage }): ReactElement {
  return (
    <DataTable headings={['Model', 'Requests', 'Failed', 'Average', 'Fallbacks', 'Cost']}>
      {table.usage.models.map((model) => (
        <tr key={model.model}>
          <td className="font-mono text-xs">{model.model}</td>
          <td>{model.requests}</td>
          <td>{model.failed}</td>
          <td>{model.average_ms === null ? '' : duration(model.average_ms)}</td>
          <td>{model.fallbacks}</td>
          <td>{dollars(model.cost_usd)}</td>
        </tr>
      ))}
    </DataTable>
  )
}

/** From this share of its budget a project's bar is a warning, as the doctor's advice starts. */
const NEAR_BUDGET = 0.8
/** The progress bars' scale. */
const PROGRESS_MAX = 100

/**
 * Picks a project's bar colour, as the doctor judges its spend: past the budget an error, from
 * {@link NEAR_BUDGET} of it a warning.
 *
 * @param share - the share of its budget spent
 * @returns the progress class
 */
function barColor(share: number): string {
  if (share > 1) return 'progress-error'
  return share >= NEAR_BUDGET ? 'progress-warning' : 'progress-success'
}

/**
 * Shows each project's spend against its budget for the window: `X-Switchboard-Project`'s label,
 * counted only with proxy auth on, and `budgets` in proxy-config.json. Reported, never enforced.
 *
 * @param table - the usage
 * @param table.usage - the window's numbers
 * @returns the table
 */
function ProjectsUsage(table: { readonly usage: Usage }): ReactElement {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold">Projects</h2>
      <DataTable headings={['Project', 'Requests', 'Failed', 'Cost', 'Budget', 'Spent']}>
        {table.usage.projects.map((project) => {
          const share =
            project.budget_usd === null ? undefined : project.cost_usd / project.budget_usd
          return (
            <tr key={project.project}>
              <td className="font-mono text-xs">{project.project}</td>
              <td>{project.requests}</td>
              <td>{project.failed}</td>
              <td>{dollars(project.cost_usd)}</td>
              <td>{project.budget_usd === null ? '' : dollars(project.budget_usd)}</td>
              <td>
                {share === undefined ? null : (
                  <div className="flex items-center gap-2">
                    <progress
                      className={`progress w-24 ${barColor(share)}`}
                      aria-label={`${project.project} spent`}
                      value={Math.min(PROGRESS_MAX, Math.round(share * PROGRESS_MAX))}
                      max={PROGRESS_MAX}
                    />
                    <span className="text-xs">{percent(share)}</span>
                  </div>
                )}
              </td>
            </tr>
          )
        })}
      </DataTable>
    </section>
  )
}

/**
 * Shows a window's usage.
 *
 * @param view - the usage
 * @param view.usage - the window's numbers
 * @returns the page's content
 */
function UsageView(view: { readonly usage: Usage }): ReactElement {
  const { usage } = view
  const projects = usage.projects.length === 0 ? null : <ProjectsUsage usage={usage} />
  if (usage.models.length === 0 && usage.rejected.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <p className="p-4 text-base-content/60">No requests in this window.</p>
        {projects}
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-6">
      <Totals usage={usage} />
      <Timeline timeline={usage.timeline} />
      <ModelsUsage usage={usage} />
      {projects}
      {[
        ...usage.failures.map((failure) => `${String(failure.count)} ${failure.class}`),
        ...usage.rejected.map(
          (rejected) => `${String(rejected.count)} rejected with ${String(rejected.status)}`
        )
      ].map((line) => (
        <div key={line} role="alert" className="alert alert-soft text-sm">
          {line}
        </div>
      ))}
    </div>
  )
}

/**
 * The Stats page, over the window the shell keeps (`t`, `w`, `a`).
 *
 * @param view - the window, how to pick another, and whether the operator may edit budgets
 * @returns the page
 */
export function StatsPage(view: PageView): ReactElement {
  const query = useQuery({
    queryKey: ['stats', view.statsWindow],
    queryFn: () => readApi(`/stats?window=${view.statsWindow}`, UsageSchema)
  })
  return (
    <div className="flex flex-col gap-4">
      <WindowPicker window={view.statsWindow} onPick={view.onPickWindow} />
      <Loaded query={query}>{(usage) => <UsageView usage={usage} />}</Loaded>
      {view.editor ? <BudgetEditor /> : null}
    </div>
  )
}
