/**
 * Per-request proxy request IDs.
 *
 * @remarks
 * Format: `piproxy-<24 hex chars>`, easy to tell apart from upstream IDs.
 *
 * @packageDocumentation
 */

import { randomBytes } from 'node:crypto'

/** Random bytes in a request ID; hex-encoded, they give 24 characters. */
const REQUEST_ID_BYTES = 12

/**
 * Generates a new proxy request ID.
 *
 * @returns `piproxy-` followed by 24 random hex characters
 */
export function generateRequestId(): string {
  return `piproxy-${randomBytes(REQUEST_ID_BYTES).toString('hex')}`
}
