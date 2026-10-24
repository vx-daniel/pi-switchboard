/**
 * The proxy auth a running server applies, which the console can change without a restart.
 *
 * @remarks
 * Each app has its own switch, made from the resolved config's `proxyAuth` unless the caller passes
 * one, so tests that build apps with different auth in one process do not share it. The middleware
 * reads it on every request; a change applies to the next request.
 *
 * @packageDocumentation
 */

import type { ProxyAuth } from '@proxy/config/env'

/** The proxy auth a server applies now. */
export interface ProxyAuthSwitch {
  /**
   * Reads the auth applied now.
   *
   * @returns the auth
   */
  current(): ProxyAuth
  /**
   * Applies other auth from the next request on.
   *
   * @param next - the auth to apply
   */
  set(next: ProxyAuth): void
}

/**
 * Creates a server's proxy auth switch.
 *
 * @param initial - the auth to start with, the resolved config's
 * @returns the switch
 */
export function createProxyAuthSwitch(initial: ProxyAuth): ProxyAuthSwitch {
  let applied = initial
  return {
    current: () => applied,
    set: (next) => {
      applied = next
    }
  }
}
