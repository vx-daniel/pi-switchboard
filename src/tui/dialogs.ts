/**
 * The console's dialogs: pi's own selector and input, and pi-tui's settings list as a tick list,
 * shown in the middle of the screen.
 *
 * @packageDocumentation
 */

import {
  ExtensionInputComponent,
  ExtensionSelectorComponent,
  getSettingsListTheme
} from '@earendil-works/pi-coding-agent'
import {
  type Component,
  Container,
  type OverlayHandle,
  type SettingItem,
  SettingsList,
  Text,
  type TuiAltScreen
} from '@earendil-works/pi-tui'
import { ALERT_FRAME_COLUMNS, alertPanel, paint, strong } from '@proxy/tui/theme'

/** Rows the tick list shows before it scrolls. */
const TICK_LIST_ROWS = 15
/** A ticked option's value in the tick list. */
const TICKED = '[x]'
/** An option left out, in the tick list. */
const UNTICKED = '[ ]'

/** The dialogs an editor asks through: pi's selector and input in the console, scripted in tests. */
export interface DialogScreens {
  /**
   * Asks the operator to pick one of `labels`.
   *
   * @param title - the question
   * @param labels - the options
   * @returns the label picked, or `undefined` when cancelled
   */
  select(title: string, labels: readonly string[]): Promise<string | undefined>
  /**
   * Asks the operator for a line of text.
   *
   * @param title - the question
   * @returns the text, or `undefined` when cancelled
   */
  input(title: string): Promise<string | undefined>
}

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
  return pick(tui, title, labels, (selector) => selector)
}

/**
 * Shows pi's selector in a red alert panel ({@link alertPanel}) and waits for a choice: for a
 * warning that must not be missed, such as proxy auth off (#287).
 *
 * @param tui - the screen
 * @param title - the warning and the question
 * @param labels - the options
 * @returns the chosen label, or `undefined` when cancelled
 */
export function pickAlert(
  tui: TuiAltScreen,
  title: string,
  labels: readonly string[]
): Promise<string | undefined> {
  return pick(tui, title, labels, (selector) => ({
    render: (width) => alertPanel(selector.render(Math.max(1, width - ALERT_FRAME_COLUMNS)), width),
    invalidate: () => selector.invalidate(),
    handleInput: (data) => selector.handleInput(data)
  }))
}

/**
 * Shows pi's selector, as `frame` draws it, and waits for a choice.
 *
 * @param tui - the screen
 * @param title - the question
 * @param labels - the options
 * @param frame - wraps the selector in the component shown
 * @returns the chosen label, or `undefined` when cancelled
 */
function pick(
  tui: TuiAltScreen,
  title: string,
  labels: readonly string[],
  frame: (selector: ExtensionSelectorComponent) => Component
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
    const handle = showDialog(tui, frame(selector))
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

/**
 * Shows a list to tick any number of options from, with search, and waits until it is closed.
 *
 * @remarks
 * pi's selector starts at its first row every time it opens, so a long list ticked one option per
 * opening would send the operator back to the top after each. pi-tui's settings list keeps its
 * place: Enter or Space ticks the selected option, typing searches, Esc closes it.
 *
 * @param tui - the screen
 * @param title - what the options are for
 * @param options - the options, in list order
 * @param ticked - the options ticked when it opens
 * @returns the options ticked when it closed, in list order
 */
export function pickMany(
  tui: TuiAltScreen,
  title: string,
  options: readonly string[],
  ticked: readonly string[]
): Promise<string[]> {
  const chosen = new Set(ticked)
  return new Promise((resolve) => {
    const items: SettingItem[] = options.map((option) => ({
      id: option,
      label: option,
      currentValue: chosen.has(option) ? TICKED : UNTICKED,
      values: [UNTICKED, TICKED]
    }))
    const list = new SettingsList(
      items,
      TICK_LIST_ROWS,
      getSettingsListTheme(),
      (option, value) => {
        if (value === TICKED) chosen.add(option)
        else chosen.delete(option)
      },
      () => {
        handle.hide()
        resolve(options.filter((option) => chosen.has(option)))
      },
      { enableSearch: true }
    )
    const dialog = new Container()
    dialog.addChild(new Text(strong(title), 1, 0))
    dialog.addChild(list)
    dialog.addChild(
      new Text(paint('dim', 'Enter or Space ticks · type to search · Esc saves'), 1, 0)
    )
    const component: Component = {
      render: (width) => dialog.render(width),
      invalidate: () => dialog.invalidate(),
      handleInput: (data) => {
        list.handleInput(data)
        tui.requestRender()
      }
    }
    const handle = showDialog(tui, component)
  })
}

/** The option that closes a {@link tickList}, keeping what is ticked. */
const DONE = 'Done'

/**
 * Asks for any number of a few options, as a list of checkboxes: each pick ticks or unticks one,
 * `Done` keeps them. For a short list; {@link pickMany} keeps its place in a long one.
 *
 * @typeParam Option - the options' type
 * @param screens - the dialogs
 * @param title - what the options are for
 * @param options - the options, in list order
 * @param ticked - the options ticked at first
 * @returns the options ticked, in list order, or `undefined` when cancelled
 */
export async function tickList<Option extends string>(
  screens: DialogScreens,
  title: string,
  options: readonly Option[],
  ticked: readonly Option[]
): Promise<Option[] | undefined> {
  const chosen = new Set<Option>(ticked)
  for (;;) {
    const rows = options.map((option) => `[${chosen.has(option) ? 'x' : ' '}] ${option}`)
    const choice = await screens.select(title, [...rows, DONE])
    if (choice === undefined) return undefined
    if (choice === DONE) return options.filter((option) => chosen.has(option))
    const option = options[rows.indexOf(choice)]
    if (option !== undefined && !chosen.delete(option)) chosen.add(option)
  }
}
