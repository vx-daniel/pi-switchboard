/**
 * Setup for the admin UI's page tests (#367): each test starts with nothing mounted and no stubbed
 * global (`fetch`, `EventSource`) left from the one before.
 *
 * @packageDocumentation
 */

import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vite-plus/test'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.location.hash = ''
})
