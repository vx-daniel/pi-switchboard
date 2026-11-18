/**
 * The Doctor page (#367): `pi-switchboard doctor`'s findings on the running proxy, over a stats
 * window. No login is verified from here; the CLI's `--verify` does that.
 *
 * @packageDocumentation
 */

import {
  type Doctor,
  DoctorSchema,
  type Finding,
  readApi,
  type StatsWindow
} from '@proxy/admin/web/api'
import { Loaded } from '@proxy/admin/web/loaded'
import { WindowPicker } from '@proxy/admin/web/pages/stats'
import { useQuery } from '@tanstack/react-query'
import { type ReactElement, useState } from 'react'

/** How each severity is shown, most serious first. */
const SEVERITIES = [
  { id: 'error', title: 'Errors', alert: 'alert-error' },
  { id: 'warning', title: 'Warnings', alert: 'alert-warning' },
  { id: 'advice', title: 'Advice', alert: 'alert-info' }
] as const

/**
 * Shows one finding.
 *
 * @param item - the finding and how to color it
 * @param item.finding - what the doctor found
 * @param item.alert - the alert's color class
 * @returns the alert
 */
function FindingAlert(item: { readonly finding: Finding; readonly alert: string }): ReactElement {
  const { finding } = item
  return (
    <div
      role="alert"
      className={`alert alert-soft alert-vertical items-start sm:alert-horizontal ${item.alert}`}
    >
      <div className="flex flex-col gap-1">
        <span className="font-semibold">
          {finding.subject === undefined ? finding.check : `${finding.check} · ${finding.subject}`}
        </span>
        <span>{finding.message}</span>
        <span className="text-sm opacity-80">{finding.recommendation}</span>
      </div>
    </div>
  )
}

/**
 * Shows the report.
 *
 * @param view - the report
 * @param view.doctor - the findings and the report's limits
 * @returns the page's content
 */
function DoctorView(view: { readonly doctor: Doctor }): ReactElement {
  const findings = [...view.doctor.general, ...view.doctor.cache]
  return (
    <div className="flex flex-col gap-6">
      {findings.length === 0 ? (
        <div role="alert" className="alert alert-success alert-soft">
          Nothing to report.
        </div>
      ) : null}
      {SEVERITIES.map((severity) => {
        const shown = findings.filter((finding) => finding.severity === severity.id)
        if (shown.length === 0) return null
        return (
          <section key={severity.id} className="flex flex-col gap-2">
            <h2 className="text-lg font-semibold">
              {severity.title} <span className="badge badge-ghost">{shown.length}</span>
            </h2>
            {shown.map((finding) => (
              <FindingAlert
                key={`${finding.check}-${finding.subject ?? ''}-${finding.message}`}
                finding={finding}
                alert={severity.alert}
              />
            ))}
          </section>
        )
      })}
      {view.doctor.limits.length === 0 ? null : (
        <ul className="list-inside list-disc text-sm text-base-content/60">
          {view.doctor.limits.map((limit) => (
            <li key={limit}>{limit}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * The Doctor page.
 *
 * @returns the page
 */
export function DoctorPage(): ReactElement {
  const [statsWindow, setStatsWindow] = useState<StatsWindow>('today')
  const query = useQuery({
    queryKey: ['doctor', statsWindow],
    queryFn: () => readApi(`/doctor?window=${statsWindow}`, DoctorSchema)
  })
  return (
    <div className="flex flex-col gap-4">
      <WindowPicker window={statsWindow} onPick={setStatsWindow} />
      <Loaded query={query}>{(doctor) => <DoctorView doctor={doctor} />}</Loaded>
    </div>
  )
}
