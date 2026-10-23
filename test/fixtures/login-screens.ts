/**
 * Scripted screens for the console's login flow (`src/tui/login.ts`): pi's dialog and selector
 * replaced by canned answers, so a test drives pi's real `ModelRuntime.login` without a terminal.
 *
 * @packageDocumentation
 */

import type { LoginScreens } from '@proxy/tui/login'

/** The answers scripted screens give, and the signal their dialog cancels with. */
export interface LoginScript {
  /** The option ID every choice picks. */
  readonly choose: string
  /** What every prompt gets; `undefined` leaves prompts waiting. */
  readonly answer: string | undefined
  /** The dialog's cancel signal. */
  readonly signal: AbortSignal
}

/**
 * Builds scripted login screens: each choice picks the option with the given ID, each prompt gets
 * the given answer (or never answers), and every view shown is recorded.
 *
 * @param script - the answers, and the signal the dialog cancels with
 * @returns the screens, and the views they were asked to show
 */
export function scriptedScreens(script: LoginScript): { screens: LoginScreens; shown: string[] } {
  const shown: string[] = []
  const reply = async (): Promise<string> =>
    script.answer ?? (await new Promise<string>(() => undefined))
  const screens: LoginScreens = {
    dialog: {
      signal: script.signal,
      showAuth: (url) => shown.push(`auth ${url}`),
      showDeviceCode: (info) => shown.push(`device ${info.userCode}`),
      showWaiting: (message) => shown.push(`waiting ${message}`),
      showInfo: (message) => shown.push(`info ${message}`),
      showProgress: (message) => shown.push(`progress ${message}`),
      showPrompt: async (message) => {
        shown.push(`prompt ${message}`)
        return reply()
      },
      showManualInput: async (message) => {
        shown.push(`manual ${message}`)
        return reply()
      }
    },
    select: async (prompt) => {
      shown.push(`select ${prompt.message}`)
      return script.choose
    }
  }
  return { screens, shown }
}
