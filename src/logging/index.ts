/**
 * Logging for the proxy and its pi extension, on LogTape (https://logtape.org).
 *
 * Library-first: every module asks for a logger with `proxyLogger(...)` and logs; nothing is
 * written until an entry point configures LogTape. The proxy's CLI calls `configureLogging()`
 * (stderr); the extension calls `configureFileLogging()` only when
 * `PI_SWITCHBOARD_EXTENSION_LOG_FILE` names a file, because console output would corrupt pi's
 * terminal UI.
 *
 * CATEGORIES — every logger sits under `ROOT_CATEGORY`, so one `lowestLevel` governs them all:
 *   server             lifecycle: startup, shutdown
 *   server.http        one line per request and per response; client disconnects
 *   server.auth        proxy authentication decisions
 *   server.chat        the chat completions route: model resolution, dispatch, upstream errors
 *   server.health      failed /healthz detail checks (a passing check logs nothing above debug)
 *   config             config file, env var and CLI resolution
 *   openai.messages    message conversion          openai.tools       tool conversion
 *   openai.sse         streaming responses         openai.responses   non-streaming responses
 *   openai.exposure    model exposure and IDs      openai.validate    request validation
 *   openai.schema      JSON Schema → TypeBox       openai.images      remote image fetches
 *   pi.registry        pi's model runtime          pi.complete        upstream calls
 *   sync.zed           Zed settings sync
 *   stats              the stats store and recorder (src/stats/)
 *   extension          the pi extension's command handler (extensions/proxy/index.ts)
 *   extension.*        the pi extension's parts (process, settings, reports, zed-sync)
 *
 * LEVELS:
 *   trace    per streamed event or chunk
 *   debug    per-request internal decisions and counts
 *   info     lifecycle, and one line per request and response
 *   warning  recoverable problems: rejected input, upstream overload, fallbacks
 *   error    failures that end a request with a 5xx, or a feature that stops working
 *   fatal    the process cannot continue
 *
 * NEVER LOG message or prompt content, tool arguments, image data, or credentials (API keys, auth
 * tokens, Authorization headers). Log ids, counts, sizes and durations instead.
 * `REDACTED_FIELDS` is a backstop for a mistake, not permission to log a secret.
 *
 * @packageDocumentation
 */

import { AsyncLocalStorage } from 'node:async_hooks'

import { getFileSink } from '@logtape/file'
import {
  configureSync,
  getLogger,
  jsonLinesFormatter,
  type Logger,
  type LoggerConfig,
  type LogLevel,
  type Sink,
  type LogRecord,
  type TextFormatter
} from '@logtape/logtape'
import { getPrettyFormatter } from '@logtape/pretty'
import { redactByField } from '@logtape/redaction'
import * as z from 'zod'

/** The category every logger in this package sits under. */
export const ROOT_CATEGORY = 'pi-switchboard'

/**
 * Returns a logger in this package's category tree, e.g. `proxyLogger('server', 'http')`.
 *
 * @param subcategories - Category segments under {@link ROOT_CATEGORY}, outermost first.
 * @returns The LogTape logger for `pi-switchboard.<subcategories…>`.
 */
export function proxyLogger(...subcategories: readonly string[]): Logger {
  return getLogger([ROOT_CATEGORY, ...subcategories])
}

/**
 * Property names whose values are replaced with `[REDACTED]` before any sink sees them.
 *
 * @remarks
 * Exact, case-sensitive names, not LogTape's default patterns: those match `/token/i` and `/key/i`,
 * which would also redact token usage counts and cache keys this package logs on purpose.
 */
export const REDACTED_FIELDS: readonly string[] = [
  'apiKey',
  'upstreamApiKey',
  'authToken',
  'proxyAuth',
  'authorization',
  'accessToken',
  'refreshToken',
  'password',
  'secret'
]

/** `pretty` for a person at a terminal, `json` (JSON Lines) for anything that parses logs. */
const LogFormatSchema = z.enum(['pretty', 'json'])

/** A log output format: `pretty` or `json` (JSON Lines). */
export type LogFormat = z.infer<typeof LogFormatSchema>

/** Every {@link LogFormat}, in the order help and warning messages list them. */
export const LOG_FORMATS: readonly LogFormat[] = LogFormatSchema.options

/**
 * Checks whether a string names a log format.
 *
 * @param value - A format name from a flag or env var.
 * @returns Whether `value` is a {@link LogFormat}.
 */
export function isLogFormat(value: string): value is LogFormat {
  return LogFormatSchema.safeParse(value).success
}

/**
 * Returns the format to use when none is configured.
 *
 * @returns `pretty` when stderr is a terminal, `json` when it is piped or redirected.
 */
export function defaultLogFormat(): LogFormat {
  return process.stderr.isTTY ? 'pretty' : 'json'
}

/**
 * Resolves the format to log in: the `--log-format` flag, then `PI_SWITCHBOARD_LOG_FORMAT`, then
 * `fallback`.
 *
 * @remarks
 * A value that names no format is skipped; the caller reports it.
 *
 * @param flagFormat - The `--log-format` value, or `undefined` when the flag is absent.
 * @param envFormat - The `PI_SWITCHBOARD_LOG_FORMAT` value, or `undefined` when unset.
 * @param fallback - Called when neither names a format; defaults to {@link defaultLogFormat}.
 * @returns The first valid format.
 */
export function resolveLogFormat(
  flagFormat: string | undefined,
  envFormat: string | undefined,
  fallback: () => LogFormat = defaultLogFormat
): LogFormat {
  const chosen = [flagFormat, envFormat].find(
    (candidate): candidate is LogFormat => candidate !== undefined && isLogFormat(candidate)
  )
  return chosen ?? fallback()
}

/**
 * What a sink can format records in: a {@link LogFormat} the CLI's flags name, or `console`, the
 * console's narrow pretty layout, which no flag selects (its log view only).
 */
export type SinkFormat = LogFormat | 'console'

/**
 * The pretty format for the console's log view (#61): the time only, a narrower category without
 * the package's own root, so a line's message starts at column 42 and fits a narrow terminal.
 */
const consolePretty = getPrettyFormatter({
  timestamp: 'time',
  timeZone: null,
  categoryWidth: 16,
  categoryTruncate: 'middle',
  value: 'bare',
  wordWrap: false
})

/**
 * Formats a record for the console's log view: {@link consolePretty}, with the category under the
 * package's root (`server`, not `pi-switchboard·server`). A record on the root itself, or outside
 * the package, keeps its category.
 *
 * @param record - The record.
 * @returns The formatted line.
 */
function consoleFormatter(record: LogRecord): string {
  const under = record.category[0] === ROOT_CATEGORY && record.category.length > 1
  return consolePretty(under ? { ...record, category: record.category.slice(1) } : record)
}

/**
 * Returns the LogTape formatter for a format.
 *
 * @param format - The format to render records in.
 * @returns LogTape's JSON Lines formatter, the console's narrow layout, or a pretty formatter in
 *   local time.
 */
function formatterFor(format: SinkFormat): TextFormatter {
  // JSON keeps LogTape's UTC `@timestamp`: unambiguous for anything that parses or ships logs. It
  // also keeps LogTape's quoted string values in `message`, on purpose: some come from clients, and
  // the quotes keep a crafted one from passing for message text (PLAN "Observability", #159).
  if (format === 'json') return jsonLinesFormatter
  if (format === 'console') return consoleFormatter
  // A person reads local time: `timeZone: null` is the system zone (the `TZ` variable in a
  // container), with the offset shown so a line is never ambiguous. `bare` prints strings without
  // quotes: a reader wants `GET /v1/models`, not `'GET'`.
  return getPrettyFormatter({
    timestamp: 'date-time-tz',
    timeZone: null,
    categoryWidth: 32,
    value: 'bare',
    wordWrap: false
  })
}

/**
 * Wraps a sink so the {@link REDACTED_FIELDS} properties reach it as `[REDACTED]`.
 *
 * @param sink - The sink to protect.
 * @returns The redacting sink.
 */
function redacted(sink: Sink): Sink {
  return redactByField(sink, { fieldPatterns: [...REDACTED_FIELDS], action: () => '[REDACTED]' })
}

/**
 * Builds the logger configs: the package's root logger plus LogTape's own meta logger (warnings
 * and above), both on one sink.
 *
 * @param level - The lowest level the package's loggers write.
 * @param sink - The name of the sink, as registered in `configureSync`'s `sinks`.
 * @returns The configs for `configureSync`'s `loggers`.
 */
function loggerConfigs(level: LogLevel, sink: string): LoggerConfig<string, string>[] {
  return [
    { category: ROOT_CATEGORY, lowestLevel: level, sinks: [sink] },
    { category: ['logtape', 'meta'], lowestLevel: 'warning', sinks: [sink] }
  ]
}

/** Options for {@link configureLogging}. */
export interface LoggingOptions {
  readonly level: LogLevel
  readonly format: SinkFormat
  /**
   * Where formatted lines go. Default: `process.stderr.write`, which Node performs synchronously
   * for a terminal or a file and asynchronously for a pipe (POSIX): a piped reader that stops
   * reading makes the queued lines pile up in this process's memory.
   *
   * @param line - One formatted log line, including its trailing newline.
   */
  readonly write?: ((line: string) => void) | undefined
}

/**
 * Configures LogTape for the proxy process, writing to stderr (or `options.write`).
 *
 * @remarks
 * Replaces any earlier configuration. Request handlers run inside `withContext()`, which needs the
 * async-local storage set up here.
 *
 * @param options - The level, format and optional writer.
 */
export function configureLogging(options: LoggingOptions): void {
  const formatter = formatterFor(options.format)
  const write = options.write ?? ((line: string) => process.stderr.write(line))
  configureSync({
    reset: true,
    sinks: { stderr: redacted((record) => write(formatter(record))) },
    loggers: loggerConfigs(options.level, 'stderr'),
    contextLocalStorage: new AsyncLocalStorage()
  })
}

/**
 * Configures LogTape to append JSON Lines to a file: the pi extension's opt-in log.
 *
 * @remarks
 * The extension must never write to the terminal pi draws on. Replaces any earlier configuration.
 *
 * @param path - The log file to append to.
 * @param level - The lowest level written.
 */
export function configureFileLogging(path: string, level: LogLevel): void {
  configureSync({
    reset: true,
    sinks: { file: redacted(getFileSink(path, { formatter: jsonLinesFormatter })) },
    loggers: loggerConfigs(level, 'file'),
    contextLocalStorage: new AsyncLocalStorage()
  })
}
