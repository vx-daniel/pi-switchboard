/**
 * The Stats page's timeline (#367): finished and failed requests per bucket, drawn by uPlot on a
 * canvas, in the daisyUI theme's colors.
 *
 * @packageDocumentation
 */

import type { Usage } from '@proxy/admin/web/api'
import { type ReactElement, useEffect, useRef } from 'react'
import type UPlot from 'uplot'

/** The chart's height, in pixels. */
const CHART_HEIGHT = 220
/** Milliseconds in a second: uPlot's time axis is in seconds. */
const MS_PER_SECOND = 1000

/**
 * Reads a theme color for the canvas, which cannot read CSS variables itself.
 *
 * @param name - the daisyUI color's variable, such as `--color-primary`
 * @returns its value
 */
function themeColor(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

/**
 * Lays the timeline out as uPlot's columns: the times, then each series.
 *
 * @param timeline - the buckets
 * @returns the columns
 */
function timelineColumns(timeline: Usage['timeline']): UPlot.AlignedData {
  return [
    timeline.map((bucket) => Date.parse(bucket.start) / MS_PER_SECOND),
    timeline.map((bucket) => bucket.requests),
    timeline.map((bucket) => bucket.failed + bucket.rejected)
  ]
}

/**
 * Draws the timeline into an element, loading uPlot first.
 *
 * @remarks
 * Imported dynamically on purpose, not for a runtime-chosen module: uPlot reads browser APIs
 * (`matchMedia`) as soon as it loads, and only this page needs it, so it comes in its own chunk and
 * loads only when the Stats page draws.
 *
 * @param element - the chart's container
 * @param timeline - the buckets
 * @returns the chart, to destroy when the page leaves
 */
async function drawTimeline(element: HTMLElement, timeline: Usage['timeline']): Promise<UPlot> {
  const { default: Chart } = await import('uplot')
  return new Chart(
    {
      width: element.clientWidth,
      height: CHART_HEIGHT,
      series: [
        {},
        { label: 'Requests', stroke: themeColor('--color-primary') },
        { label: 'Failed or rejected', stroke: themeColor('--color-error') }
      ],
      axes: [
        { stroke: themeColor('--color-base-content') },
        { stroke: themeColor('--color-base-content') }
      ]
    },
    timelineColumns(timeline),
    element
  )
}

/**
 * Shows the timeline.
 *
 * @param chart - the data
 * @param chart.timeline - the buckets
 * @returns the chart's container
 */
export function Timeline(chart: { readonly timeline: Usage['timeline'] }): ReactElement {
  const container = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = container.current
    if (element === null) return undefined
    const drawn = drawTimeline(element, chart.timeline)
    /** Removes the chart once it is drawn. */
    const remove = async (): Promise<void> => {
      ;(await drawn).destroy()
    }
    return () => {
      void remove()
    }
  }, [chart.timeline])
  return <div ref={container} aria-label="Requests over time" />
}
