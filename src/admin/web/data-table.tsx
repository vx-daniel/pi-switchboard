/**
 * The admin pages' tables (#367): a daisyUI `table` with its headings, scrolling sideways on a
 * narrow screen.
 *
 * @packageDocumentation
 */

import type { ReactElement, ReactNode } from 'react'

/**
 * Shows a table.
 *
 * @param table - its headings and rows
 * @param table.headings - the column headings, `''` for a column without one
 * @param table.children - the rows (`<tr>`)
 * @returns the table
 */
export function DataTable(table: {
  readonly headings: readonly string[]
  readonly children: ReactNode
}): ReactElement {
  return (
    <div className="overflow-x-auto">
      <table className="table table-sm">
        <thead>
          <tr>
            {table.headings.map((heading, column) => (
              <th key={`${String(column)}-${heading}`}>{heading}</th>
            ))}
          </tr>
        </thead>
        <tbody>{table.children}</tbody>
      </table>
    </div>
  )
}
