/**
 * The admin UI's status strip (#367), as the console's first row: the name and version, that the
 * proxy serves, where and how, its models and cooldowns and uptime; on the right the last half
 * hour of chat requests as a sparkline with the current rate, and what today cost. Under it, the
 * alerts the console gives a row of their own.
 *
 * @packageDocumentation
 */

import type { Status } from '@proxy/admin/web/api'
import { compactDuration, dollars } from '@proxy/admin/web/format'
import type { ReactElement } from 'react'

/** The sparkline's height, in SVG units. */
const SPARK_HEIGHT = 20
/** Each minute's width in the sparkline, in SVG units, a gap included. */
const SPARK_STEP = 4
/** Each minute's bar width, in SVG units. */
const SPARK_BAR = 3
/** The shortest bar of a minute with requests, so one request still shows. */
const SPARK_LEAST_BAR = 2
/** How faint a minute without requests is drawn. */
const SPARK_IDLE_OPACITY = 0.3

/**
 * Draws the last half hour of chat requests, a bar per minute as tall as its share of the busiest.
 *
 * @param spark - the counts
 * @param spark.perMinute - chat requests finished per minute, oldest first
 * @returns the sparkline
 */
function Sparkline(spark: { readonly perMinute: readonly number[] }): ReactElement {
  const most = Math.max(1, ...spark.perMinute)
  return (
    <svg
      className="text-primary"
      width={spark.perMinute.length * SPARK_STEP}
      height={SPARK_HEIGHT}
      role="img"
      aria-label="Chat requests per minute over the last half hour"
    >
      {spark.perMinute.map((requests, minute) => {
        const height =
          requests === 0
            ? 1
            : Math.max(SPARK_LEAST_BAR, Math.round((requests / most) * SPARK_HEIGHT))
        return (
          <rect
            key={String(minute)}
            x={minute * SPARK_STEP}
            y={SPARK_HEIGHT - height}
            width={SPARK_BAR}
            height={height}
            fill="currentColor"
            opacity={requests === 0 ? SPARK_IDLE_OPACITY : 1}
          />
        )
      })}
    </svg>
  )
}

/**
 * Shows proxy auth: the token, or a warning that it is off (an error beyond this machine).
 *
 * @param auth - the status
 * @param auth.status - the proxy's status
 * @returns the badge
 */
function AuthBadge(auth: { readonly status: Status }): ReactElement {
  if (auth.status.proxyAuth === 'token') {
    return <span className="badge badge-ghost badge-sm">token</span>
  }
  const color = auth.status.beyondLoopback ? 'badge-error' : 'badge-warning'
  return <span className={`badge badge-sm ${color}`}>auth off</span>
}

/**
 * The status strip.
 *
 * @param strip - the status
 * @param strip.status - the proxy's status
 * @returns the strip
 */
export function StatusStrip(strip: { readonly status: Status }): ReactElement {
  const { status } = strip
  const rate = status.perMinute.at(-1) ?? 0
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <span className="font-semibold">pi-switchboard</span>
      <span className="text-base-content/60">{status.version}</span>
      <span className="badge badge-success badge-sm">● serving</span>
      <span className="font-mono">{status.address}</span>
      <AuthBadge status={status} />
      <span>
        {typeof status.exposed === 'number'
          ? `${String(status.exposed)}/${String(status.available)} models`
          : 'models: config invalid'}
      </span>
      {status.cooldowns > 0 ? (
        <span className="badge badge-warning badge-sm">{status.cooldowns} cooling</span>
      ) : null}
      <span className="text-base-content/60">up {compactDuration(status.uptimeMs)}</span>
      <span className="ml-auto flex items-center gap-2">
        <Sparkline perMinute={status.perMinute} />
        <span>
          {rate}
          {status.saturated ? '+' : ''}/min
        </span>
        {status.todayCostUsd === null ? null : (
          <span className="text-base-content/60">{dollars(status.todayCostUsd)} today</span>
        )}
      </span>
    </div>
  )
}

/**
 * The alerts the console gives a row of their own: proxy auth off beyond this machine, and a
 * config that can't be applied.
 *
 * @param alerts - the status
 * @param alerts.status - the proxy's status
 * @returns the alerts, or nothing
 */
export function StatusAlerts(alerts: { readonly status: Status }): ReactElement | null {
  const { status } = alerts
  const shown = [
    status.proxyAuth === 'off' && status.beyondLoopback
      ? {
          tone: 'alert-error',
          text: `Proxy auth is off on ${status.address}: anyone who can reach it can use your provider logins. Set a token (PI_SWITCHBOARD_AUTH_TOKEN, or the console's p).`
        }
      : undefined,
    typeof status.exposed === 'string'
      ? { tone: 'alert-error', text: `The model exposure config is invalid: ${status.exposed}` }
      : undefined,
    status.modelsJsonError === null
      ? undefined
      : { tone: 'alert-warning', text: `models.json: ${status.modelsJsonError}` }
  ].filter((alert) => alert !== undefined)
  if (shown.length === 0) return null
  return (
    <div className="flex flex-col gap-2">
      {shown.map((alert) => (
        <div key={alert.text} role="alert" className={`alert alert-soft ${alert.tone}`}>
          {alert.text}
        </div>
      ))}
    </div>
  )
}
