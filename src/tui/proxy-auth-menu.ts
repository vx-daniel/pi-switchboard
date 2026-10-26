/**
 * Proxy auth from the console (`p`): turn it on with a generated or typed token, show or replace
 * the token, or turn it off, without restarting the proxy.
 *
 * @remarks
 * A change applies to the next request (the server's `ProxyAuthSwitch`) and is saved as `authToken`
 * in `proxy-config.json`, so the proxy starts with it next time. One exception: a token set by
 * `--auth-token` or `PI_SWITCHBOARD_AUTH_TOKEN` can be turned off for this session only. The file
 * is left alone, and the flag or env var sets the token again at the next start. Turning auth off
 * loosens what the operator set (constitution principle III), so it is logged as a warning, and a
 * proxy bound beyond this machine says who can reach it now.
 *
 * The token is shown only in the console's own dialog, and copied on request; it is never logged.
 *
 * @packageDocumentation
 */

import { randomBytes } from 'node:crypto'

import { copyToClipboard } from '@earendil-works/pi-coding-agent'
import type { TuiAltScreen } from '@earendil-works/pi-tui'
import type { OverrideSource, ServerConfig } from '@proxy/config/env'
import { getConfigPath, loadConfigFromFile, saveConfigToFile } from '@proxy/config/schema'
import { proxyLogger } from '@proxy/logging'
import type { ProxyAuthSwitch } from '@proxy/server/proxy-auth'
import { isLoopbackHost } from '@proxy/server/startup'
import { askLine, pickAlert, pickLabel } from '@proxy/tui/dialogs'
import { errorMessage } from '@proxy/utils/guards'

/** Logger for proxy auth decisions. */
const authLogger = proxyLogger('server', 'auth')

/** Random bytes in a generated token: 256 bits, as base64url. */
const TOKEN_BYTES = 32

/** The dialogs the menu runs on: pi's selector and input, and the clipboard. */
export interface AuthScreens {
  /**
   * Shows a choice.
   *
   * @param title - the question
   * @param options - the options' labels
   * @returns the chosen label, or `undefined` when cancelled
   */
  select(title: string, options: readonly string[]): Promise<string | undefined>
  /**
   * Shows a choice as a warning that must not be missed: the console's red alert panel.
   *
   * @param title - the warning and the question
   * @param options - the options' labels
   * @returns the chosen label, or `undefined` when cancelled
   */
  warn(title: string, options: readonly string[]): Promise<string | undefined>
  /**
   * Asks for a line of text.
   *
   * @param title - the question
   * @returns the text, or `undefined` when cancelled
   */
  input(title: string): Promise<string | undefined>
  /**
   * Copies text to the clipboard.
   *
   * @param text - the text
   */
  copy(text: string): Promise<void>
}

/** The proxy the menu changes. */
export interface AuthTarget {
  /** The server's proxy auth. */
  readonly proxyAuth: ProxyAuthSwitch
  /** The flag or env var that set the token at startup, if one did. */
  readonly override: OverrideSource | undefined
  /** The token the flag or env var set, to tell it from one set since. */
  readonly overrideToken: string | undefined
  /** The bind address, to warn when auth goes off beyond this machine. */
  readonly host: string
  /** `host:port`, for the menu's title. */
  readonly address: string
}

/**
 * Saves a token as the config file's `authToken`; '' turns auth off. The rest of the file stays
 * as it is.
 *
 * @param token - the token, or '' for off
 * @returns whether the file was written
 */
function saveAuthToken(token: string): boolean {
  return saveConfigToFile(
    { ...loadConfigFromFile(), authToken: token },
    {
      replaceInvalidAuthToken: true
    }
  )
}

/** The menu's actions, by label. */
const ACTIONS = {
  generate: 'Generate a token',
  generateNew: 'Generate a new token',
  enter: 'Enter a token',
  enterNew: 'Enter a new token',
  show: 'Show the token',
  off: 'Turn auth off',
  offForSession: 'Turn auth off until the proxy restarts',
  keepOff: 'Keep auth off for now'
} as const

/** Labels of the dialog that shows a token. */
const SHOW = { copy: 'Copy it', close: 'Close' } as const

/**
 * Names where the token applied now came from.
 *
 * @param target - the proxy
 * @param token - the token applied now
 * @returns the flag or env var that set it, or `undefined` for the config file or the console
 */
function overrideOf(target: AuthTarget, token: string): OverrideSource | undefined {
  return target.override !== undefined && token === target.overrideToken
    ? target.override
    : undefined
}

/**
 * Checks a typed token.
 *
 * @param token - the token
 * @returns why it can't be used, or `undefined` when it can
 */
function tokenProblem(token: string): string | undefined {
  if (token === '') return 'The token is empty.'
  // A header value loses its surrounding spaces, so such a token could never match.
  if (token.trim() !== token) return 'The token starts or ends with a space.'
  return undefined
}

/**
 * Turns auth on with a token, or replaces the token, and saves it.
 *
 * @param target - the proxy
 * @param token - the token
 * @param save - writes the config file's token; returns whether it did
 */
function applyToken(target: AuthTarget, token: string, save: (token: string) => boolean): void {
  target.proxyAuth.set({ kind: 'token', token })
  const saved = save(token)
  if (saved) {
    authLogger.info('Proxy auth is on: clients must send the new token; saved to {path}', {
      path: getConfigPath()
    })
  } else {
    authLogger.warn(
      'Proxy auth is on, but the token could not be saved: it lasts until the proxy stops'
    )
  }
  if (target.override !== undefined) {
    authLogger.warn('{source} still sets the token when the proxy next starts', {
      source: target.override
    })
  }
}

/**
 * Turns auth off: for this session when a flag or env var set the token, else saved.
 *
 * @param target - the proxy
 * @param override - the flag or env var that set the token applied now, if one did
 * @param save - writes the config file's token; returns whether it did
 */
function turnOff(
  target: AuthTarget,
  override: OverrideSource | undefined,
  save: (token: string) => boolean
): void {
  target.proxyAuth.set({ kind: 'off' })
  if (override === undefined) {
    if (save('')) {
      authLogger.warn('Proxy auth is off; saved to {path}', { path: getConfigPath() })
    } else {
      authLogger.warn(
        'Proxy auth is off, but the change could not be saved: it lasts until the proxy stops'
      )
    }
    // A token from the console replaced the flag's; the flag or env var still wins at startup.
    if (target.override !== undefined) {
      authLogger.warn('{source} still sets the token when the proxy next starts', {
        source: target.override
      })
    }
  } else {
    authLogger.warn('Proxy auth is off until the proxy restarts; {source} turns it on again then', {
      source: override
    })
  }
  if (!isLoopbackHost(target.host)) {
    authLogger.warn(
      'The proxy listens on {host}: any client that can reach it can use your provider credentials',
      { host: target.host }
    )
  }
}

/**
 * Shows a token, with a choice to copy it.
 *
 * @param screens - the dialogs
 * @param token - the token
 */
async function showToken(screens: AuthScreens, token: string): Promise<void> {
  const choice = await screens.select(
    `Proxy token: ${token}\nClients send it as  Authorization: Bearer <token>`,
    [SHOW.copy, SHOW.close]
  )
  if (choice !== SHOW.copy) return
  try {
    await screens.copy(token)
  } catch (error) {
    authLogger.warn('Could not copy the token: {reason}', {
      reason: errorMessage(error)
    })
  }
}

/**
 * Asks for a token until it can be used or the dialog is cancelled.
 *
 * @param screens - the dialogs
 * @returns the token, or `undefined` when cancelled
 */
async function askToken(screens: AuthScreens): Promise<string | undefined> {
  let title = 'Enter the proxy token (clients send it as  Authorization: Bearer <token>)'
  for (;;) {
    const token = await screens.input(title)
    if (token === undefined) return undefined
    const problem = tokenProblem(token)
    if (problem === undefined) return token
    title = `${problem} Enter the proxy token`
  }
}

/**
 * Runs the proxy auth menu: shows what auth is now and offers the changes that apply.
 *
 * @param target - the proxy
 * @param screens - the dialogs
 * @param save - writes the config file's token; by default {@link saveAuthToken}
 */
export async function runAuthMenu(
  target: AuthTarget,
  screens: AuthScreens,
  save: (token: string) => boolean = saveAuthToken
): Promise<void> {
  const current = target.proxyAuth.current()
  if (current.kind === 'off') {
    const choice = await screens.select(
      `Proxy auth is off: any client that can reach ${target.address} can use the proxy.`,
      [ACTIONS.generate, ACTIONS.enter]
    )
    if (choice === ACTIONS.generate) await generate(target, screens, save)
    else if (choice === ACTIONS.enter) await enter(target, screens, save)
    return
  }
  const override = overrideOf(target, current.token)
  const source = override ?? 'proxy-config.json'
  const choice = await screens.select(
    `Proxy auth is on: clients must send the token (set by ${source}).`,
    [
      ACTIONS.show,
      ACTIONS.generateNew,
      ACTIONS.enterNew,
      override === undefined ? ACTIONS.off : ACTIONS.offForSession
    ]
  )
  if (choice === ACTIONS.show) await showToken(screens, current.token)
  else if (choice === ACTIONS.generateNew) await generate(target, screens, save)
  else if (choice === ACTIONS.enterNew) await enter(target, screens, save)
  else if (choice === ACTIONS.off || choice === ACTIONS.offForSession) {
    turnOff(target, override, save)
  }
}

/**
 * Generates a token, applies and saves it, then shows it.
 *
 * @param target - the proxy
 * @param screens - the dialogs
 * @param save - writes the config file's token
 */
async function generate(
  target: AuthTarget,
  screens: AuthScreens,
  save: (token: string) => boolean
): Promise<void> {
  const token = randomBytes(TOKEN_BYTES).toString('base64url')
  applyToken(target, token, save)
  await showToken(screens, token)
}

/**
 * Asks for a token, then applies and saves it.
 *
 * @param target - the proxy
 * @param screens - the dialogs
 * @param save - writes the config file's token
 */
async function enter(
  target: AuthTarget,
  screens: AuthScreens,
  save: (token: string) => boolean
): Promise<void> {
  const token = await askToken(screens)
  if (token !== undefined) applyToken(target, token, save)
}

/**
 * Asks, while proxy auth is off, whether to set a token now (#287): the popup the console opens
 * when it starts with auth off. It says who can use the proxy, and offers the menu's own ways to
 * set a token, or to keep auth off; cancelling keeps it off too. With auth on it shows nothing.
 *
 * @param target - the proxy
 * @param screens - the dialogs
 * @param save - writes the config file's token; by default {@link saveAuthToken}
 */
export async function runAuthOffPrompt(
  target: AuthTarget,
  screens: AuthScreens,
  save: (token: string) => boolean = saveAuthToken
): Promise<void> {
  if (target.proxyAuth.current().kind !== 'off') return
  const who = isLoopbackHost(target.host)
    ? 'any program on this machine, and a web page you open, can use your provider logins through it'
    : 'anyone who can reach it can use your provider logins'
  const choice = await screens.warn(
    `⚠ Proxy auth is off on ${target.address}: ${who}. Set a token now?`,
    [ACTIONS.generate, ACTIONS.enter, ACTIONS.keepOff]
  )
  if (choice === ACTIONS.generate) await generate(target, screens, save)
  else if (choice === ACTIONS.enter) await enter(target, screens, save)
}

/**
 * Builds the menu's proxy and pi's dialogs for the console.
 *
 * @param tui - the screen
 * @param config - the server config: where the startup token came from, and the address
 * @param proxyAuth - the server's proxy auth
 * @returns the proxy and the dialogs
 */
function consoleAuth(
  tui: TuiAltScreen,
  config: ServerConfig,
  proxyAuth: ProxyAuthSwitch
): { target: AuthTarget; screens: AuthScreens } {
  return {
    target: {
      proxyAuth,
      override: config.proxyAuthOverride,
      overrideToken: config.proxyAuth.kind === 'token' ? config.proxyAuth.token : undefined,
      host: config.host,
      address: `${config.host}:${String(config.port)}`
    },
    screens: {
      select: (title, labels) => pickLabel(tui, title, labels),
      warn: (title, labels) => pickAlert(tui, title, labels),
      input: (title) => askLine(tui, title),
      copy: copyToClipboard
    }
  }
}

/**
 * Opens the auth-off popup ({@link runAuthOffPrompt}) on pi's dialogs.
 *
 * @param tui - the screen
 * @param config - the server config
 * @param proxyAuth - the server's proxy auth
 */
export async function openAuthOffPrompt(
  tui: TuiAltScreen,
  config: ServerConfig,
  proxyAuth: ProxyAuthSwitch
): Promise<void> {
  const { target, screens } = consoleAuth(tui, config, proxyAuth)
  await runAuthOffPrompt(target, screens)
}

/**
 * Opens the proxy auth menu (`p`) on pi's dialogs.
 *
 * @param tui - the screen
 * @param config - the server config: where the startup token came from, and the address
 * @param proxyAuth - the server's proxy auth
 */
export async function openAuthMenu(
  tui: TuiAltScreen,
  config: ServerConfig,
  proxyAuth: ProxyAuthSwitch
): Promise<void> {
  const { target, screens } = consoleAuth(tui, config, proxyAuth)
  await runAuthMenu(target, screens)
}
