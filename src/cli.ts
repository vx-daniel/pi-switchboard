/**
 * The citty CLI (args, help, version) that configures logging, loads the config and starts the
 * HTTP server. `src/index.ts` loads it, and answers a missing pi package with a clear error.
 *
 * @remarks
 * Config priority: CLI args > env vars > JSON config file > defaults. Evaluating this module runs
 * the CLI on `process.argv`: `pi-switchboard tui` runs the console (#61), `pi-switchboard doctor`
 * checks the config and the prompt cache (#299), anything else runs the headless proxy.
 *
 * @packageDocumentation
 */

import { configFileAuthTokenInvalid, getConfigPath, loadConfigFromFile } from '@proxy/config/schema'
import { LOG_FORMATS, proxyLogger, resolveLogFormat } from '@proxy/logging'
import { initRegistry } from '@proxy/pi/registry'
import {
  invalidFlag,
  listen,
  loadConfigWithLogging,
  logEffectiveConfig,
  SERVER_ARGS
} from '@proxy/server/startup'
import { errorMessage } from '@proxy/utils/guards'
import { defineCommand, runMain } from 'citty'

import packageJson from '../package.json' with { type: 'json' }

/** Logger for process lifecycle (`server` category). */
const lifecycleLogger = proxyLogger('server')

/** Indentation of the `--config` JSON output. */
const JSON_INDENT = 2
/** What `--config` shows for a non-empty `authToken`. */
const MASKED_TOKEN = '***'
/** What `--config` shows for an `authToken` in the file that is not a string (#82). */
const INVALID_TOKEN_SHOWN = '<invalid: not a string>'

/**
 * Returns the auth token as `--config` shows it.
 *
 * @param fileToken - The config file's normalized `authToken`.
 * @returns `<invalid: not a string>` when the file's `authToken` is not a string, `***` for a
 *   non-empty token, '' when auth is off.
 */
function shownAuthToken(fileToken: string): string {
  if (configFileAuthTokenInvalid()) return INVALID_TOKEN_SHOWN
  return fileToken.length > 0 ? MASKED_TOKEN : ''
}

/** The `pi-switchboard` command: its flags, and `run`, which starts the server. */
const main = defineCommand({
  meta: {
    name: 'pi-switchboard',
    version: packageJson.version,
    description:
      "OpenAI-compatible HTTP API over pi's models, logins and providers. `pi-switchboard tui --help` for the interactive console, `pi-switchboard doctor --help` to check the config and the prompt cache"
  },
  args: {
    ...SERVER_ARGS,
    'log-format': {
      type: 'string',
      description: `Log output: ${LOG_FORMATS.join(', ')} (default: pretty on a terminal, json otherwise)`
    },
    'config': {
      type: 'boolean',
      description:
        "Show the config file's contents and exit (not the effective config: flags and env vars are not applied)"
    }
  },
  run: async ({ args }) => {
    // An unusable flag refuses every path, `--config` included, with the valid values (#95).
    const refusal = invalidFlag(args)
    if (refusal !== undefined) {
      process.stderr.write(`${refusal}\n`)
      process.exitCode = 1
      return
    }

    // --config: show the config file's values (not CLI or env overrides) and exit. Command
    // output, not a log line, so it goes to stdout, where it is easily piped or captured: the
    // token is masked.
    if (args.config === true) {
      const file = loadConfigFromFile()
      const shown = { ...file, authToken: shownAuthToken(file.authToken) }
      process.stdout.write(`Config file: ${getConfigPath()}\n`)
      process.stdout.write(`${JSON.stringify(shown, null, JSON_INDENT)}\n`)
      return
    }

    const config = loadConfigWithLogging(args, {
      format: resolveLogFormat(args['log-format'], process.env.PI_SWITCHBOARD_LOG_FORMAT)
    })
    // Proxy auth set but unusable: logged, and the proxy does not start.
    if (config === undefined) {
      process.exitCode = 1
      return
    }
    logEffectiveConfig(config)

    // Initialize pi integration; initRegistry logs a models.json load failure itself.
    await initRegistry()
    const server = await listen(config).catch((error: unknown): undefined => {
      lifecycleLogger.fatal('Cannot listen on {host}:{port}: {error}', {
        host: config.host,
        port: config.port,
        error: errorMessage(error)
      })
      process.exitCode = 1
      return undefined
    })
    if (server === undefined) return
    const listening = server

    // --- Graceful shutdown ---
    let shutdownInitiated = false

    /**
     * Closes the server on the first shutdown signal, and forces exit after a 10 s timeout.
     *
     * @param signal - The signal's name, for the log line.
     */
    function handleShutdown(signal: string): void {
      if (shutdownInitiated) return
      shutdownInitiated = true

      lifecycleLogger.info('Received {signal}, shutting down', { signal })

      const SHUTDOWN_TIMEOUT_MS = 10_000

      listening.close()

      setTimeout(() => {
        lifecycleLogger.warn('Shutdown timed out after {timeoutMs} ms; forcing exit', {
          timeoutMs: SHUTDOWN_TIMEOUT_MS
        })
        process.exit(1)
      }, SHUTDOWN_TIMEOUT_MS).unref()
    }

    process.on('SIGTERM', () => handleShutdown('SIGTERM'))
    process.on('SIGINT', () => handleShutdown('SIGINT'))
  }
})

/** Flags that take a value: the argument after one is its value, never a subcommand. */
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  ...Object.entries(SERVER_ARGS)
    .filter(([, definition]) => definition.type === 'string')
    .map(([name]) => `--${name}`),
  '--log-format'
])

/** The subcommands, each loaded only when it runs. */
type Subcommand = 'tui' | 'doctor'

/**
 * Finds the subcommand among the arguments: the first one that is neither a flag nor a flag's
 * value, so `pi-switchboard --port 4000 tui` runs the console as `pi-switchboard tui --port 4000`
 * does.
 *
 * @param args - the arguments after the program name
 * @returns the subcommand and the arguments without it, or `undefined` for the headless proxy
 */
function subcommandOf(
  args: readonly string[]
): { readonly name: Subcommand; readonly rest: string[] } | undefined {
  let index = 0
  while (args[index]?.startsWith('-') === true) {
    const flag = args[index] ?? ''
    index += 1
    // A flag that takes a value (`--port 4000`, not `--port=4000`) skips that value too.
    if (!flag.includes('=') && VALUE_FLAGS.has(flag)) index += 1
  }
  const name = args[index]
  return name === 'tui' || name === 'doctor' ? { name, rest: args.toSpliced(index, 1) } : undefined
}

/** Where the arguments start in `process.argv`, after node and the script. */
const FIRST_ARGUMENT = 2
/** The subcommand, when the command is `pi-switchboard tui` or `pi-switchboard doctor`. */
const subcommand = subcommandOf(process.argv.slice(FIRST_ARGUMENT))
// Each subcommand is loaded dynamically, on purpose: the console brings pi's interactive UI
// (pi-tui and pi's login screens), which the headless proxy never loads, and the doctor is not
// needed to serve. citty's subCommands would also run `main` after them.
if (subcommand === undefined) {
  await runMain(main)
} else if (subcommand.name === 'tui') {
  const { tuiCommand } = await import('@proxy/tui/command')
  await runMain(tuiCommand, { rawArgs: subcommand.rest })
} else {
  const { doctorCommand } = await import('@proxy/doctor/command')
  await runMain(doctorCommand, { rawArgs: subcommand.rest })
}
