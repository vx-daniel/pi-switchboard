# Configuration

This page starts with the reference: where settings come from, where the files are, and every setting in one table. The sections after it explain the settings in detail.

## Where settings come from

A setting can come from four places. The first one that sets it wins: **flag > environment variable > `proxy-config.json` > default**.

| Source | An invalid value |
|---|---|
| **Flag** (`--port 8080`) | Stops the proxy from starting, naming the valid values or range |
| **Environment variable** (`PI_SWITCHBOARD_PORT=8080`) | A number or a log level it doesn't take is ignored with a warning, and the next source applies. A switch (`PI_SWITCHBOARD_STATS` and the others) takes `true` or `false`: anything else is a warning, and counts as `false` |
| **`proxy-config.json`** | Repaired, never refused: a number is clamped to its range, a list or map keeps its valid entries, anything else takes its default, and one warning names the fields. Two exceptions stop the proxy from starting, both about the auth token: an `authToken` that is not a string, and a file that can't be read or parsed while no flag or variable sets the token ([Proxy authentication](#proxy-authentication)) |
| **Default** | The value in the table below |

The file is also written for you: the pi extension's settings panel (`/proxy config`) saves every setting there, and the console (`pi-switchboard tui`) saves every setting but `lifetime` and `zed` from its Settings view (`5`), aliases from its Models view and login labels from its Accounts view, and restarts its server to apply the ones read at startup ([The console](console.md#the-console-logs-logins-and-status-at-a-terminal)). `pi-switchboard --config` prints the file's contents; flags and variables are not applied to what it shows.

## Where the files are

Everything lives in pi's agent directory: `~/.pi/agent` (on Windows, `%USERPROFILE%\.pi\agent`), or the directory `PI_CODING_AGENT_DIR` names. The proxy reads the same directory as pi, so a login made with pi is the proxy's too.

| Install | Agent directory |
|---|---|
| npm CLI, pi package, standalone binary | `~/.pi/agent`, or `PI_CODING_AGENT_DIR` |
| Docker | `/home/node/.pi/agent`, in the `pi-agent` volume ([Docker](docker.md)) |

| File | Whose | What it holds |
|---|---|---|
| `auth.json` | pi | Logins: API keys and subscription tokens (`pi /login`, or `n` and `x` in the console) |
| `models.json` | pi | Providers and models of your own, and overrides of pi's |
| `settings.json` | pi | pi's settings; the proxy reads only `enabledModels`, for `scoped` exposure |
| `proxy-config.json` | pi-switchboard | The settings below. A missing file means every default |
| `pi-switchboard-stats.sqlite` | pi-switchboard | Per-minute traffic stats for the console and the usage route, kept 30 days (`stats`) |

## Every setting

| Setting | Flag | Environment variable | `proxy-config.json` | Default | Takes |
|---|---|---|---|---|---|
| Bind address | `--host` | `PI_SWITCHBOARD_HOST` | `host` | `127.0.0.1` | An address; `0.0.0.0` for every interface |
| Port | `--port` | `PI_SWITCHBOARD_PORT` | `port` | `4141` | 1–65535 |
| [Proxy auth token](#proxy-authentication) | `--auth-token` | `PI_SWITCHBOARD_AUTH_TOKEN` | `authToken` | `""`, off | Any string, matched exactly |
| [Remote images](security.md#security-defaults) | `--remote-images` | `PI_SWITCHBOARD_REMOTE_IMAGES` | `remoteImages` | `false` | `true`, `false` |
| [Responses API](api.md#responses-api-experimental) | `--responses-api` | `PI_SWITCHBOARD_RESPONSES_API` | `responsesApi` | `false` | `true`, `false` |
| [Docs page](api.md#api-documentation) | `--docs-ui` | `PI_SWITCHBOARD_DOCS_UI` | `docsUi` | `false` | `true`, `false` |
| [Stats](#what-the-proxy-adds) | `--stats`, `--no-stats` | `PI_SWITCHBOARD_STATS` | `stats` | `true` | `true`, `false` |
| Max request body | `--max-body-size` (MB) | `PI_SWITCHBOARD_MAX_BODY_SIZE` (bytes) | `maxBodySizeMb` (MB) | 50 MB | 1–500 MB |
| [Upstream idle timeout](#what-the-proxy-adds) | `--upstream-timeout` (s) | `PI_SWITCHBOARD_UPSTREAM_TIMEOUT_MS` (ms) | `upstreamTimeoutSec` (s) | 120 s | 5–600 s |
| [Log level](#logging) | `--log-level` | `PI_SWITCHBOARD_LOG_LEVEL` | `logLevel` | `info` | `trace`, `debug`, `info`, `warning`, `error`, `fatal` |
| [Log format](#logging) | `--log-format` | `PI_SWITCHBOARD_LOG_FORMAT` | — | `pretty` on a terminal, `json` otherwise | `pretty`, `json` |
| [Public model IDs](api.md#public-model-ids) | — | — | `publicModelIdMode` | `collision-prefixed` | `collision-prefixed`, `universal`, `always-prefixed` |
| [Exposed models](api.md#exposure-modes) | — | — | `modelExposureMode` | `scoped` | `all`, `scoped`, `custom` |
| [Custom model list](api.md#exposure-modes) | — | — | `customModels` | `[]` | Canonical IDs (`provider/model-id`), for `custom` |
| [Provider prefixes](api.md#public-model-ids) | — | — | `providerPrefixes` | `{}` | Provider → the prefix its public IDs take |
| [Aliases](routing.md#aliases) | — | — | `aliases` | `{}` | Name → a model, a chain (`targets`, `fallbackOn`), a target with its `reasoningEffort`, or a `family` |
| [Quota reserve](routing.md#quota) | — | — | `routing.reserve` | `{}` | Login → the share of each quota window to keep free, 0–1 |
| [Moving between logins](logins.md#several-logins-per-provider) | — | — | `routing.logins.fallbackOn` | `["rate_limit"]` | Failure classes: `rate_limit`, `unavailable`, `timeout`, `auth`, `refused`, `upstream_error` |
| [Login labels](logins.md#several-logins-per-provider) | — | — | `labels` | `{}` | Login → the label the console shows |
| [Lifetime](pi-extension.md#settings-panel) (pi package) | — | — | `lifetime` | `detached` | `detached` (outlives the pi session), `session` |
| [Zed sync](pi-extension.md#command-family) (pi package) | — | — | `zed.providerName`, `zed.autoSync` | `"Pi Proxy"`, `false` | A name; `true`, `false` |

Environment variables with no flag or file key:

| Variable | What it does |
|---|---|
| `PI_CODING_AGENT_DIR` | pi's agent directory, where every file above is ([Where the files are](#where-the-files-are)) |
| `PI_SWITCHBOARD_EXTENSION_LOG_FILE` | Where the pi extension writes its log, which it otherwise keeps quiet ([Logging](#logging)) |
| `NO_COLOR` | `NO_COLOR=1` turns off the console's colors |

## A complete `proxy-config.json`

Every key is optional; one left out takes its default. JSON has no comments, so the table above says what each key does. This file sets every key, most to their defaults, with an alias of each kind:

```json
{
  "host": "127.0.0.1",
  "port": 4141,
  "authToken": "",
  "remoteImages": false,
  "responsesApi": false,
  "docsUi": false,
  "stats": true,
  "maxBodySizeMb": 50,
  "upstreamTimeoutSec": 120,
  "logLevel": "info",
  "publicModelIdMode": "collision-prefixed",
  "modelExposureMode": "scoped",
  "customModels": [],
  "providerPrefixes": {},
  "aliases": {
    "quick": "anthropic/claude-haiku-5-5",
    "reviewer": { "model": "anthropic/claude-opus-5-5", "reasoningEffort": "high" },
    "opus-latest": { "family": "anthropic/claude-opus" },
    "coding": {
      "targets": ["anthropic/claude-opus-5-5", "openai-codex/gpt-6-sol"],
      "fallbackOn": ["rate_limit", "unavailable", "timeout"]
    }
  },
  "routing": {
    "reserve": { "anthropic": 0.2 },
    "logins": { "fallbackOn": ["rate_limit"] }
  },
  "labels": { "anthropic": "work", "anthropic-2": "personal" },
  "lifetime": "detached",
  "zed": { "providerName": "Pi Proxy", "autoSync": false }
}
```

- **`lifetime` and `zed` matter only to the pi package**, which starts the proxy from pi and syncs Zed. A standalone proxy (the binary, Docker or the npm CLI) ignores them; leave them out there.
- **The model IDs are from pi 1.4.0's catalogue.** Catalogues change: use the IDs `GET /v1/models` lists for your logins ([Discovering available models](api.md#discovering-available-models)).

## What comes from pi

The proxy reads two files from pi's configuration directory (`~/.pi/agent/`):

| File | Managed by | What the proxy uses |
|---|---|---|
| `auth.json` | `pi /login` | API keys for each provider (Anthropic, OpenAI, Google, etc.) |
| `models.json` | pi built-in + user edits | Model definitions, capabilities, and pricing |

From pi's `settings.json` the proxy reads only `enabledModels`, for `scoped` exposure. It does **not** read installed packages, enabled extensions, or session-level model filters (`--models` flag).

## What the proxy adds

Proxy-specific settings are configured via CLI flags, environment variables, the JSON config file (`~/.pi/agent/proxy-config.json`), the console's Settings view (`pi-switchboard tui`, `5`), or the `/proxy config` panel (when installed as a pi package). Priority: flag > env var > config file > default:

| Setting | Env variable | Default | Description |
|---|---|---|---|
| Bind address | `PI_SWITCHBOARD_HOST` | `127.0.0.1` | Network interface (`127.0.0.1` = local only, `0.0.0.0` = all) (`--host`, `host` in the config file) |
| Port | `PI_SWITCHBOARD_PORT` | `4141` | HTTP listen port, 1–65535 (`--port`, `port`) |
| Auth token | `PI_SWITCHBOARD_AUTH_TOKEN` | (disabled) | Bearer token for proxy authentication (`--auth-token`, `authToken`) |
| Remote images | `PI_SWITCHBOARD_REMOTE_IMAGES` | `false` | Fetch remote image URLs server-side and inline them as base64; off, they are rejected with `400`. The proxy then makes requests for its clients, so only public `http`/`https` hosts are allowed (see [Security defaults](security.md#security-defaults)) (`--remote-images`, `remoteImages`) |
| Responses API | `PI_SWITCHBOARD_RESPONSES_API` | `false` | Answer the experimental `POST /v1/responses` ([Responses API](api.md#responses-api-experimental)) (`--responses-api`, `responsesApi`) |
| Docs UI | `PI_SWITCHBOARD_DOCS_UI` | `false` | Serve Swagger UI at `/docs` ([API documentation](api.md#api-documentation)); it loads its scripts from a CDN (`--docs-ui`, `docsUi`) |
| Stats | `PI_SWITCHBOARD_STATS` | `true` | Keep per-minute traffic stats in `pi-switchboard-stats.sqlite` in pi's agent dir for the console's Stats view (#216): requests by model, outcome and status, their timings, attempts, failures by class, fallbacks, tokens and cost. Never message content, the request's `user`, or a credential; a rejected request's model name, which the client chose, is cut to 128 characters, and past 20 names a minute the rest count as `(other)`. Rows older than 30 days are deleted. A write that can't get the file's lock within 250 ms is dropped, so stats never stall requests. A file that can't be opened is a warning, and the proxy runs without stats (`--stats` / `--no-stats`, `stats`) |
| Max body size | `PI_SWITCHBOARD_MAX_BODY_SIZE` | `52428800` (50 MB) | Maximum request body size in bytes, `1048576`–`524288000` (`--max-body-size` and `maxBodySizeMb` in the config file take MB, 1–500) |
| Upstream timeout | `PI_SWITCHBOARD_UPSTREAM_TIMEOUT_MS` | `120000` (120s) | How long the upstream provider may send nothing (no stream event of any kind: thinking, text and tool calls, but also chunks pi makes nothing of, such as OpenAI Responses lifecycle events; SSE comment lines and Anthropic `ping` events do not count) before the call is aborted, in milliseconds, `5000`–`600000` (`--upstream-timeout` in seconds and `upstreamTimeoutSec` in the config file, 5–600). The first wait starts with the call, so it includes pi's credential lookup (an OAuth refresh, say); after that it restarts with every event, so it never cuts off a long answer that keeps arriving. A request that hits it before the provider answered gets `504`, streamed or not; a stream that already started gets an error event. |
| Log level | `PI_SWITCHBOARD_LOG_LEVEL` | `info` | Lowest level logged: `trace`, `debug`, `info`, `warning`, `error`, `fatal` (also `--log-level`, and `logLevel` in the config file) |
| Log format | `PI_SWITCHBOARD_LOG_FORMAT` | pretty on a terminal, `json` otherwise | `pretty` or `json` (also `--log-format`; no config-file key) |

## Logging

The proxy logs with [LogTape](https://logtape.org) to stderr:
- **Pretty** ([@logtape/pretty](https://jsr.io/@logtape/pretty)): readable, colored lines stamped with the local date, time and UTC offset (in a container, set `TZ`, e.g. `TZ=America/Chicago`). The default on a terminal.
- **JSON** ([JSON Lines](https://jsonlines.org)): one object per record with `@timestamp` (UTC), `level`, `logger` (the category, e.g. `pi-switchboard.server.http`), `message` and `properties`. The default when stderr is piped or redirected, as in `docker logs`. `message` quotes the string values it contains (`Listening on http://"0.0.0.0":4141`, `"GET" "/v1/models" received`) on purpose. Some values come from clients, such as the requested model, a path or a client request ID, and the quotes stop a crafted one from reading as message text. `properties` holds each value unquoted; read or query those. The pretty format prints values bare.

`PI_SWITCHBOARD_LOG_FORMAT` (or `--log-format`) picks one regardless of the terminal, for example `pretty` for reading `docker compose logs` directly.

Passing `/healthz` checks are logged at `debug`; a failed one stays at `info`.

An invalid flag stops the proxy from starting and lists the valid values: `--log-level` and `--log-format` name their options, and `--port`, `--max-body-size` and `--upstream-timeout` name their range (the same bounds the config file applies). An invalid env var is ignored with a warning: `PI_SWITCHBOARD_LOG_LEVEL` or `PI_SWITCHBOARD_LOG_FORMAT` naming no level or format, or `PI_SWITCHBOARD_PORT`, `PI_SWITCHBOARD_MAX_BODY_SIZE` or `PI_SWITCHBOARD_UPSTREAM_TIMEOUT_MS` not an integer within its bounds (digits only: `80abc` is not 80). An invalid `logLevel` in the config file falls back to `info`, and a number outside its range is clamped, so a bad value in the environment or the file never keeps a background proxy from starting.

If proxy auth is off and the proxy binds to anything other than a loopback address, it logs a warning at startup: any client that can reach the port can use your provider credentials.

Every line a request causes carries its `requestId` (and `clientRequestId` when the client sent `X-Client-Request-Id`). At `debug` and `trace` you see the internal decisions: model resolution, conversion, upstream calls and stream events.

Message content and credentials are never logged. Credential-named properties are redacted as a backstop.

The pi extension logs nothing by default, because output would corrupt pi's terminal UI. To capture its logs, set `PI_SWITCHBOARD_EXTENSION_LOG_FILE=/path/to/extension.log` before starting pi; the extension then appends JSON Lines there at the configured log level.

Model exposure settings are configured via the JSON config file (`~/.pi/agent/proxy-config.json`):

| Setting | Default | Description |
|---|---|---|
| `publicModelIdMode` | `collision-prefixed` | Public ID format: `collision-prefixed`, `universal`, `always-prefixed` |
| `modelExposureMode` | `scoped` | Which models to expose: `all`, `scoped`, `custom` |
| `customModels` | `[]` | Canonical model IDs for `custom` mode. An empty list exposes no model |
| `providerPrefixes` | `{}` | Provider key -> custom prefix label overrides |
| `aliases` | `{}` | Alias -> the canonical ID of an exposed model ([Aliases](routing.md#aliases)) |
| `routing.reserve` | `{}` | Provider -> the share of each quota window, 0–1, that fallback chains keep free ([Quota](routing.md#quota)) |
| `routing.logins.fallbackOn` | `["rate_limit"]` | The failures that move a request from one login of a model to the next ([Several logins per provider](logins.md#several-logins-per-provider)) |
| `labels` | `{}` | Provider -> the label the console shows beside the login, in your words ([Several logins per provider](logins.md#several-logins-per-provider)) |

When used as a pi package, all settings are persisted in `~/.pi/agent/proxy-config.json` and applied when the extension spawns the proxy.

A config file is never refused for its values: an invalid value is replaced and the proxy starts anyway. A number outside its range is clamped to the nearest bound, a list or map keeps its valid entries, and anything else takes its default. One exception: an `authToken` that is not a string is not replaced by the default (which would turn auth off); the proxy refuses to start instead (see [Proxy authentication](#proxy-authentication)). A file that exists but cannot be read or is not valid JSON refuses the same way unless a flag or `PI_SWITCHBOARD_AUTH_TOKEN` sets the token, since the file may hold one; a missing file starts with the defaults. `host` is trimmed; model IDs, prefix labels and `authToken` are used exactly as written, so a padded model ID matches no model rather than exposing one. One warning names the fields that were replaced, never their values, and it repeats only when that set of fields changes.

## Proxy authentication

Set `PI_SWITCHBOARD_AUTH_TOKEN` to require a bearer token for every request except the `GET /healthz` liveness check:

```bash
PI_SWITCHBOARD_AUTH_TOKEN=my-secret-token pi-switchboard

# Clients must include the token
curl http://localhost:4141/v1/models \
  -H "Authorization: Bearer my-secret-token"
```

The scheme is matched in any case (`Bearer`, `bearer`), with one or more spaces before the token, as [RFC 7235](https://www.rfc-editor.org/rfc/rfc7235#section-2.1) allows; the token itself must match exactly. It is compared in constant time, so how long a refusal takes says nothing about how much of a guessed token was right.

The token can also live in the config file (`"authToken": "…"`); a flag or `PI_SWITCHBOARD_AUTH_TOKEN` wins over it, and `"authToken": ""` (the default) turns auth off. An `authToken` that is set but is not a string (`12345`, `true`, `null`, an object) does **not** turn auth off: the proxy refuses to start, logging why (naming the field, never its value) and exiting with status `1`, until the file is fixed or a token is set by flag or environment. `/proxy start` refuses too, with the reason. The settings panel and `/proxy show` say "invalid"; saving another setting from the panel keeps the file's value, and only a choice on the auth row (or `/proxy reset`) replaces it.

In the console (`pi-switchboard tui`), `p` turns auth on with a generated or typed token, shows or replaces the token, or turns it off, without a restart ([The console](console.md#the-console-logs-logins-and-status-at-a-terminal)).

An empty override (`--auth-token ''` or `PI_SWITCHBOARD_AUTH_TOKEN=`) refuses to start the same way, naming the flag or variable. The config file's token is not used instead; unset the variable to use it. An empty `PI_SWITCHBOARD_AUTH_TOKEN` in pi's own environment reaches a proxy the extension starts, so `/proxy start` refuses then as well, unless a token is set in `/proxy config`.

A `proxy-config.json` that exists but cannot be read or is not valid JSON also refuses to start when neither the flag nor `PI_SWITCHBOARD_AUTH_TOKEN` sets a token: the file may hold one the proxy cannot see, and starting on the defaults would turn it into auth off. The log names the file and the problem (`cannot be read (EACCES)`, `is not valid JSON`), never the file's contents. Fix or remove the file, or set a token by flag or environment; `/proxy start` refuses with the same reason. A missing file holds nothing and starts with the defaults.
