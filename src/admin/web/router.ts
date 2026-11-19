/**
 * The admin pages' router (#367): the page is the URL's hash (`#/accounts`), so `/admin/` is the
 * only address the server answers and a page can be bookmarked or reloaded.
 *
 * @packageDocumentation
 */

import type { StatsWindow } from '@proxy/admin/web/api'
import { useSyncExternalStore } from 'react'

/** The pages, in the console's order (its `1`–`6`), then Logins, which the console has no tab for. */
export const PAGES = [
  { id: 'requests', title: 'Requests' },
  { id: 'accounts', title: 'Accounts' },
  { id: 'stats', title: 'Stats' },
  { id: 'models', title: 'Models' },
  { id: 'settings', title: 'Settings' },
  { id: 'doctor', title: 'Doctor' },
  { id: 'logins', title: 'Logins' }
] as const

/** A page's ID. */
export type PageId = (typeof PAGES)[number]['id']

/** What every page is given: the window Stats and Doctor share, and whether the operator edits. */
export interface PageView {
  readonly statsWindow: StatsWindow
  readonly onPickWindow: (statsWindow: StatsWindow) => void
  /** Whether the operator may change settings (the editor role). */
  readonly editor: boolean
}

/**
 * Reads the page a hash names: the first page for any other hash.
 *
 * @param hash - `location.hash`, such as `#/accounts`
 * @returns the page
 */
function pageOf(hash: string): PageId {
  return PAGES.find((page) => `#/${page.id}` === hash)?.id ?? 'requests'
}

/**
 * Subscribes to the hash changing.
 *
 * @param onChange - called when it does
 * @returns a function that unsubscribes
 */
function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange)
  return () => {
    window.removeEventListener('hashchange', onChange)
  }
}

/**
 * Reads the current hash.
 *
 * @returns `location.hash`
 */
function currentHash(): string {
  return window.location.hash
}

/**
 * Follows the page the URL names.
 *
 * @returns the current page, again whenever the hash changes
 */
export function useCurrentPage(): PageId {
  return pageOf(useSyncExternalStore(subscribe, currentHash))
}
