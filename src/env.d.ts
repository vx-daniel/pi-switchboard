/**
 * Typed environment variables read by the proxy, its pi extension, its scripts and its test config.
 *
 * @remarks
 * Declaring them allows dot-notation access under `noPropertyAccessFromIndexSignature`.
 *
 * @packageDocumentation
 */

declare namespace NodeJS {
  interface ProcessEnv {
    HOME?: string | undefined
    XDG_CONFIG_HOME?: string | undefined
    CUSTOM_DATA_DIR?: string | undefined
    /** https://no-color.org: any non-empty value turns the console's colors off. */
    NO_COLOR?: string | undefined
    PI_CODING_AGENT_DIR?: string | undefined
    /** pi's prompt cache retention: `long` asks for the provider's long cache; read by the doctor. */
    PI_CACHE_RETENTION?: string | undefined
    PI_SWITCHBOARD_HOST?: string | undefined
    PI_SWITCHBOARD_PORT?: string | undefined
    PI_SWITCHBOARD_AUTH_TOKEN?: string | undefined
    PI_SWITCHBOARD_AGENTIC?: string | undefined
    PI_SWITCHBOARD_HOST_ORIGIN_GUARD?: string | undefined
    PI_SWITCHBOARD_REMOTE_IMAGES?: string | undefined
    PI_SWITCHBOARD_DOCS_UI?: string | undefined
    PI_SWITCHBOARD_RESPONSES_API?: string | undefined
    PI_SWITCHBOARD_STATS?: string | undefined
    PI_SWITCHBOARD_MAX_BODY_SIZE?: string | undefined
    PI_SWITCHBOARD_UPSTREAM_TIMEOUT_MS?: string | undefined
    PI_SWITCHBOARD_LOG_LEVEL?: string | undefined
    PI_SWITCHBOARD_LOG_FORMAT?: string | undefined
    /** Opt-in: a file path the pi extension writes its logs to. Unset or empty: no log. */
    PI_SWITCHBOARD_EXTENSION_LOG_FILE?: string | undefined
    /** `1` turns on the `live` test project (test/conformance); set by `pnpm run test:live`. */
    PI_SWITCHBOARD_LIVE_TESTS?: string | undefined
    /** `1` turns on the `binary` test project (test/binary); set by `pnpm run test:binary`. */
    PI_SWITCHBOARD_BINARY_TESTS?: string | undefined
    /** scripts/record-fixtures.ts: the pi agent dir holding the login used for recording. */
    PI_SWITCHBOARD_RECORD_AGENT_DIR?: string | undefined
    /** scripts/record-fixtures.ts: where recordings are saved (default test/fixtures/recordings). */
    PI_SWITCHBOARD_RECORD_OUT_DIR?: string | undefined
    /** scripts/record-fixtures.ts: where the recorder forwards to (default api.anthropic.com). */
    PI_SWITCHBOARD_RECORD_UPSTREAM?: string | undefined
    /** Set by the package manager running a script; read by `scripts/gate.ts`. */
    npm_config_user_agent?: string | undefined
  }
}
