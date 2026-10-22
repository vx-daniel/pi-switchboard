/**
 * `pi-switchboard tui`: the proxy with its console (#61). It takes the server flags the headless
 * CLI takes; logs go to the console's log view, always in the pretty format.
 *
 * @packageDocumentation
 */

import {
  type CliArgs,
  invalidLoggingFlag,
  loadConfigWithLogging,
  logEffectiveConfig,
  SERVER_ARGS
} from '@proxy/server/startup'
import { runConsole } from '@proxy/tui/console'
import { createLogBuffer } from '@proxy/tui/log-buffer'
import { defineCommand } from 'citty'

/** The most log lines the console keeps for its log view. */
const LOG_LINES_KEPT = 5000
/** The log lines printed with a failure, for its context. */
const RECENT_LINES = 20

/** Why the console cannot run without a terminal to draw on and read keys from. */
const NOT_INTERACTIVE =
  'pi-switchboard tui needs an interactive terminal; run pi-switchboard without tui for the headless proxy'

/**
 * Says why the console cannot start: no terminal, or an unusable logging flag.
 *
 * @param args - the parsed flags
 * @returns the reason, or `undefined` when it can start
 */
function startRefusal(args: CliArgs): string | undefined {
  const interactive = process.stdin.isTTY && process.stdout.isTTY
  return interactive ? invalidLoggingFlag(args) : NOT_INTERACTIVE
}

/** The `pi-switchboard tui` command. */
export const tuiCommand = defineCommand({
  meta: {
    name: 'pi-switchboard tui',
    description:
      "Run the proxy with an interactive console: live logs, pi's logins, and logging in through pi. Quitting the console stops the proxy"
  },
  args: SERVER_ARGS,
  run: async ({ args }) => {
    const refusal = startRefusal(args)
    if (refusal !== undefined) {
      process.stderr.write(`${refusal}\n`)
      process.exitCode = 1
      return
    }

    const logs = createLogBuffer(LOG_LINES_KEPT)
    const config = loadConfigWithLogging(args, {
      format: 'pretty',
      write: (line) => logs.append(line)
    })
    // Proxy auth set but unusable: the reason was logged to the buffer, which nothing shows yet.
    if (config === undefined) {
      process.stderr.write(`${logs.lines().join('\n')}\n`)
      process.exitCode = 1
      return
    }
    logEffectiveConfig(config)
    // The console has restored the terminal and closed the server by the time it settles or
    // throws; open keep-alive connections and pi's timers would keep the process up, so it exits.
    const failure = await runConsole(config, logs).then(
      () => undefined,
      (error: unknown) =>
        error instanceof Error ? error : new Error('The console failed', { cause: error })
    )
    if (failure === undefined) process.exit(0)
    const recent = logs.lines().slice(-RECENT_LINES).join('\n')
    process.stderr.write(`${recent}\npi-switchboard tui stopped: ${failure.message}\n`)
    process.exit(1)
  }
})
