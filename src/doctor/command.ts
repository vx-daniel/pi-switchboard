/**
 * `pi-switchboard doctor` (#299): checks the configuration and the prompt cache, and prints
 * findings with a recommendation each, as text or, with `--json`, as {@link DoctorReport}.
 *
 * @remarks
 * It reports and recommends only: it changes no file and no setting, and calls no provider unless
 * `--verify` asks it to. It takes the server flags, so it judges the config `pi-switchboard` with
 * the same flags would run with.
 *
 * Exit status: 0 with no general error, 1 with one ({@link doctorExitCode}), 2 for a usage error
 * (an unknown flag, an argument, or a value a flag does not take). The proxy's own CLI answers an
 * unusable value with 1; the doctor keeps 1 for what it found, so a script can tell them apart.
 *
 * @packageDocumentation
 */

import { getLogLevels, isLogLevel } from '@logtape/logtape'
import { collectReport, type DoctorOptions } from '@proxy/doctor/collect'
import {
  type DoctorReport,
  doctorExitCode,
  type Finding,
  MIN_CALLS,
  type Severity
} from '@proxy/doctor/findings'
import { configureLogging } from '@proxy/logging'
import { buildCliOverrides, invalidFlag, SERVER_ARGS } from '@proxy/server/startup'
import { isStatsWindow, STATS_WINDOWS } from '@proxy/stats/windows'
import { defineCommand } from 'citty'

/** The exit status for a usage error. */
const USAGE_ERROR = 2
/** Indentation of the `--json` output. */
const JSON_INDENT = 2
/** The window the cache section reads when `--window` is not given. */
const DEFAULT_WINDOW = 'week'
/** Width of a finding's severity label, so the messages line up. */
const LABEL_WIDTH = 9
/** Indentation of a finding's lines. */
const INDENT = '  '

/** The doctor's flags: the server flags, and its own. */
const DOCTOR_ARGS = {
  ...SERVER_ARGS,
  'log-level': {
    type: 'string',
    description: `Lowest level of the log lines written to stderr: ${getLogLevels().join(', ')} (default: error)`
  },
  'json': {
    type: 'boolean',
    description: 'Print the report as JSON: { general, cache, window, statsAvailable, limits }'
  },
  'window': {
    type: 'string',
    description: `The stats window the cache section reads: ${STATS_WINDOWS.join(', ')} (default: ${DEFAULT_WINDOW})`
  },
  'verify': {
    type: 'boolean',
    description:
      'Resolve each login now, as /healthz/creds?verify=true does (may refresh an OAuth token over the network)'
  }
} as const

/** Each flag's name, with whether it takes a value. */
const FLAG_TAKES_VALUE: ReadonlyMap<string, boolean> = new Map(
  Object.entries(DOCTOR_ARGS).map(([name, definition]) => [name, definition.type === 'string'])
)

/**
 * Finds the first argument the doctor does not take: an unknown flag, or any positional argument.
 *
 * @remarks
 * citty passes unknown flags through without a word, which would let a typo (`--verfy`) change
 * what the doctor checks unnoticed. A boolean flag also takes its `--no-` form. Only a flag's name
 * is quoted, never a value, which could be a token.
 *
 * @param rawArgs - the arguments after `doctor`
 * @returns why the arguments are refused, or `undefined`
 */
function unknownArgument(rawArgs: readonly string[]): string | undefined {
  for (let argumentIndex = 0; argumentIndex < rawArgs.length; argumentIndex += 1) {
    const argument = rawArgs[argumentIndex] ?? ''
    if (!argument.startsWith('--')) return 'it takes no arguments, only flags'
    const [name = ''] = argument.slice('--'.length).split('=')
    const takesValue = FLAG_TAKES_VALUE.get(name)
    const negated =
      name.startsWith('no-') && FLAG_TAKES_VALUE.get(name.slice('no-'.length)) === false
    if (takesValue === undefined && !negated) return `unknown flag --${name}`
    // A flag that takes a value (`--window week`, not `--window=week`) skips that value.
    if (takesValue === true && !argument.includes('=')) argumentIndex += 1
  }
  return undefined
}

/** The doctor's flags as citty parses them. */
type DoctorArgs = Parameters<typeof invalidFlag>[0] & {
  readonly window?: string | undefined
}

/**
 * Checks the arguments, the window and the server flags' values.
 *
 * @param rawArgs - the arguments after `doctor`
 * @param args - the parsed flags
 * @returns why the arguments are refused, or `undefined`
 */
function usageError(rawArgs: readonly string[], args: DoctorArgs): string | undefined {
  const window = args.window
  if (window !== undefined && !isStatsWindow(window)) {
    return `--window must be one of: ${STATS_WINDOWS.join(', ')}`
  }
  return unknownArgument(rawArgs) ?? invalidFlag(args)
}

/** A severity's label in the text output. */
const SEVERITY_LABEL: Readonly<Record<Severity, string>> = {
  error: 'ERROR',
  warning: 'WARNING',
  advice: 'ADVICE'
}

/**
 * Formats one finding: its severity, check and subject, the message, and the recommendation.
 *
 * @param found - the finding
 * @returns its lines
 */
function findingLines(found: Finding): string[] {
  const subject = found.subject === undefined ? '' : ` [${found.subject}]`
  const continuation = `${INDENT}${' '.repeat(LABEL_WIDTH)}`
  return [
    `${INDENT}${SEVERITY_LABEL[found.severity].padEnd(LABEL_WIDTH)}${found.check}${subject}: ${found.message}`,
    `${continuation}→ ${found.recommendation}`
  ]
}

/**
 * Formats a section: its title, then its findings or "No findings."
 *
 * @param title - the section's title
 * @param findings - its findings
 * @returns its lines
 */
function sectionLines(title: string, findings: readonly Finding[]): string[] {
  const body = findings.length === 0 ? [`${INDENT}No findings.`] : findings.flatMap(findingLines)
  return [title, ...body]
}

/**
 * Counts findings of one severity, as `1 error` or `2 warnings`.
 *
 * @param findings - every finding
 * @param severity - the severity
 * @param plural - the plural word
 * @returns the count with its word
 */
function counted(findings: readonly Finding[], severity: Severity, plural: string): string {
  const count = findings.filter((found) => found.severity === severity).length
  return `${String(count)} ${count === 1 ? severity : plural}`
}

/**
 * Formats the report for a terminal: the general section, the cache section with the limits at
 * its end, and a count of the findings with the exit status.
 *
 * @param report - the report
 * @returns the text, ending with a newline
 */
function formatReport(report: DoctorReport): string {
  const all = [...report.general, ...report.cache]
  const lines = [
    `pi-switchboard doctor (stats window: ${report.window}; a model is judged from ${String(MIN_CALLS)} calls)`,
    '',
    ...sectionLines('General', report.general),
    '',
    ...sectionLines('Cache', report.cache),
    '',
    `${INDENT}Limits:`,
    ...report.limits.map((limit) => `${INDENT}- ${limit}`),
    '',
    `${counted(all, 'error', 'errors')}, ${counted(all, 'warning', 'warnings')}, ${counted(all, 'advice', 'advice')}. Exit status ${String(doctorExitCode(report))}.`
  ]
  return `${lines.join('\n')}\n`
}

/**
 * Runs the doctor and prints its report.
 *
 * @param options - what to check
 * @param output - whether to print JSON, and where the report goes
 * @returns the exit status: 1 with a general error, else 0
 */
export async function runDoctor(
  options: DoctorOptions,
  output: { readonly json: boolean; readonly write: (text: string) => void }
): Promise<0 | 1> {
  const report = await collectReport(options)
  output.write(
    output.json ? `${JSON.stringify(report, null, JSON_INDENT)}\n` : formatReport(report)
  )
  return doctorExitCode(report)
}

/** The `pi-switchboard doctor` command. */
export const doctorCommand = defineCommand({
  meta: {
    name: 'pi-switchboard doctor',
    description:
      'Check the configuration and the prompt cache, and recommend changes. Reads proxy-config.json, ' +
      "pi's logins and the stats file; changes nothing. Exit status: 1 when the general section has " +
      'an error (as /healthz/models or /healthz/creds would answer 503), 2 for a usage error, else 0'
  },
  args: DOCTOR_ARGS,
  run: async ({ args, rawArgs }) => {
    const refusal = usageError(rawArgs, args)
    if (refusal !== undefined) {
      process.stderr.write(
        `pi-switchboard doctor: ${refusal}. Run pi-switchboard doctor --help for usage.\n`
      )
      process.exitCode = USAGE_ERROR
      return
    }
    // The report goes to stdout; logs to stderr, errors only unless --log-level asks for more.
    const level = args['log-level']
    configureLogging({
      level: level !== undefined && isLogLevel(level) ? level : 'error',
      format: 'pretty'
    })
    const window =
      args.window !== undefined && isStatsWindow(args.window) ? args.window : DEFAULT_WINDOW
    process.exitCode = await runDoctor(
      { overrides: buildCliOverrides(args), window, verify: args.verify === true, now: Date.now() },
      { json: args.json === true, write: (text) => process.stdout.write(text) }
    )
  }
})
