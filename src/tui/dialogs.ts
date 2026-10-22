/**
 * The console's dialogs: pi's own selector and input, shown in the middle of the screen.
 *
 * @packageDocumentation
 */

import {
  ExtensionInputComponent,
  ExtensionSelectorComponent
} from '@earendil-works/pi-coding-agent'
import type { Component, OverlayHandle, TuiAltScreen } from '@earendil-works/pi-tui'

/**
 * Shows a component in the middle of the screen, with keyboard focus.
 *
 * @param tui - the screen
 * @param component - the component, one of pi's selectors, its input or its login dialog
 * @returns the overlay's handle
 */
export function showDialog(tui: TuiAltScreen, component: Component): OverlayHandle {
  return tui.showOverlay(component, { width: '80%', maxHeight: '80%', anchor: 'center' })
}

// The project's TypeScript lib predates `Promise.withResolvers`, so the dialogs below use the
// executor form.

/**
 * Shows pi's selector and waits for a choice.
 *
 * @param tui - the screen
 * @param title - the question
 * @param labels - the options
 * @returns the chosen label, or `undefined` when cancelled
 */
export function pickLabel(
  tui: TuiAltScreen,
  title: string,
  labels: readonly string[]
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const selector = new ExtensionSelectorComponent(
      title,
      [...labels],
      (label) => {
        handle.hide()
        resolve(label)
      },
      () => {
        handle.hide()
        resolve(undefined)
      }
    )
    const handle = showDialog(tui, selector)
  })
}

/**
 * Shows pi's input and waits for a line of text.
 *
 * @param tui - the screen
 * @param title - the question
 * @returns the text, or `undefined` when cancelled
 */
export function askLine(tui: TuiAltScreen, title: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const input = new ExtensionInputComponent(
      title,
      undefined,
      (value) => {
        handle.hide()
        resolve(value)
      },
      () => {
        handle.hide()
        resolve(undefined)
      }
    )
    const handle = showDialog(tui, input)
  })
}
