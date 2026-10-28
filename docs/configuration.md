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

The file is also written for you. The pi extension's settings panel (`/proxy config`) saves the settings it shows there ([Settings panel](pi-extension.md#settings-panel)), `lifetime` and `zed` included. The console (`pi-switchboard tui`) saves the server, feature, auth, model exposure and routing settings from its Settings view (`5`), aliases from its Models view, and login labels, the login order and disabled logins from its Accounts view, and restarts its server to apply the ones read at startup ([The console](console.md#the-console-logs-logins-and-status-at-a-terminal)). `pi-switchboard --config` prints the file's path and its settings as the proxy reads them (repaired, every default filled in, the token masked); flags and variables are not applied to what it shows.

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
| [Host/origin guard](#running-without-a-token) | `--host-origin-guard` | `PI_SWITCHBOARD_HOST_ORIGIN_GUARD` | `hostOriginGuard` | `false` | `true`, `false` |
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
| [Login order](logins.md#order-and-disabled-logins) | — | — | `routing.logins.order` | `{}` | Provider → its logins to try first, in order; the others follow |
| [Disabled logins](logins.md#order-and-disabled-logins) | — | — | `routing.logins.disabled` | `[]` | Logins routing never calls; they stay logged in |
| [Login labels](logins.md#several-logins-per-provider) | — | — | `labels` | `{}` | Login → the label the console shows |
| [Lifetime](pi-extension.md#settings-panel) (pi package) | — | — | `lifetime` | `detached` | `detached` (outlives the pi session), `session` |
| [Zed sync](pi-extension.md#zed-sync) (pi package) | — | — | `zed.providerName`, `zed.autoSync` | `"Pi Proxy"`, `false` | A name; `true`, `false` |

Environment variables with no flag or file key:

| Variable | What it does |
|---|---|
| `PI_CODING_AGENT_DIR` | pi's agent directory, where every file above is ([Where the files are](#where-the-files-are)) |
| `PI_SWITCHBOARD_EXTENSION_LOG_FILE` | Where the pi extension writes its log, which it otherwise keeps quiet ([Logging](#logging)) |
| `NO_COLOR` | Any value but empty turns off the console's colors and the pretty log's |
| `PI_CACHE_RETENTION` | pi's own: `long` asks every provider that has one for its longer prompt cache. pi reads it from the proxy's environment; `pi-switchboard doctor` reads it from its own to judge whether that pays ([Retention](caching.md#retention)) |

## A complete `proxy-config.json`

Every key is optional; one left out takes its default. JSON has no comments, so the table above says what each key does. This file sets every key, most to their defaults, with an alias of each kind:

```json
{
  "host": "127.0.0.1",
  "port": 4141,
  "authToken": "",
  "hostOriginGuard": false,
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
    "sonnet-high": { "family": "anthropic/claude-sonnet", "reasoningEffort": "high" },
    "coding": {
      "targets": ["anthropic/claude-opus-5-5", "openai-codex/gpt-6-sol"],
      "fallbackOn": ["rate_limit", "unavailable", "timeout"]
    }
  },
  "routing": {
    "reserve": { "anthropic": 0.2 },
    "logins": {
      "fallbackOn": ["rate_limit"],
      "order": { "anthropic": ["anthropic-2", "anthropic"] },
      "disabled": []
    }
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
| Host/origin guard | `PI_SWITCHBOARD_HOST_ORIGIN_GUARD` | `false` | Refuse requests a web page could send: a `Host` a DNS-rebinding page would use, or an `Origin` other than the proxy's own, with `403` ([Running without a token](#running-without-a-token)) (`--host-origin-guard`, `hostOriginGuard`) |
| Remote images | `PI_SWITCHBOARD_REMOTE_IMAGES` | `false` | Fetch remote image URLs server-side and inline them as base64; off, they are rejected with `400`. The proxy then makes requests for its clients, so only public `http`/`https` hosts are allowed (see [Security defaults](security.md#security-defaults)) (`--remote-images`, `remoteImages`) |
| Responses API | `PI_SWITCHBOARD_RESPONSES_API` | `false` | Answer the experimental `POST /v1/responses` ([Responses API](api.md#responses-api-experimental)) (`--responses-api`, `responsesApi`) |
| Docs UI | `PI_SWITCHBOARD_DOCS_UI` | `false` | Serve Swagger UI at `/docs` ([API documentation](api.md#api-documentation)); it loads its scripts from a CDN (`--docs-ui`, `docsUi`) |
| Stats | `PI_SWITCHBOARD_STATS` | `true` | Keep per-minute traffic stats in `pi-switchboard-stats.sqlite` in pi's agent dir for the console's Stats view (#216) and `pi-switchboard doctor`: requests by model, outcome and status, their timings, how many sent a `prompt_cache_key` (a count, never the key), attempts, failures by class, fallbacks, tokens and cost. Never message content, the request's `user`, or a credential; a rejected request's model name, which the client chose, is cut to 128 characters, and past 20 names a minute the rest count as `(other)`. Rows older than 30 days are deleted. A write that can't get the file's lock within 250 ms is dropped, so stats never stall requests. A file that can't be opened (one from a newer pi-switchboard included) is a warning, and the proxy runs without stats; an older one is migrated in place, keeping its rows ([`doctor`](#checking-the-setup-pi-switchboard-doctor)) (`--stats` / `--no-stats`, `stats`) |
| Max body size | `PI_SWITCHBOARD_MAX_BODY_SIZE` | `52428800` (50 MB) | Maximum request body size in bytes, `1048576`–`524288000` (`--max-body-size` and `maxBodySizeMb` in the config file take MB, 1–500) |
| Upstream timeout | `PI_SWITCHBOARD_UPSTREAM_TIMEOUT_MS` | `120000` (120s) | How long the upstream provider may send nothing (no stream event of any kind: thinking, text and tool calls, but also chunks pi makes nothing of, such as OpenAI Responses lifecycle events; SSE comment lines and Anthropic `ping` events do not count) before the call is aborted, in milliseconds, `5000`–`600000` (`--upstream-timeout` in seconds and `upstreamTimeoutSec` in the config file, 5–600). The first wait starts with the call, so it includes pi's credential lookup (an OAuth refresh, say); after that it restarts with every event, so it never cuts off a long answer that keeps arriving. A request that hits it before the provider answered gets `504`, streamed or not; a stream that already started gets an error event. |
| Log level | `PI_SWITCHBOARD_LOG_LEVEL` | `info` | Lowest level logged: `trace`, `debug`, `info`, `warning`, `error`, `fatal` (also `--log-level`, and `logLevel` in the config file) |
| Log format | `PI_SWITCHBOARD_LOG_FORMAT` | pretty on a terminal, `json` otherwise | `pretty` or `json` (also `--log-format`; no config-file key) |

Model exposure and routing are set in the config file only, and read from it on every request, so a change applies from the next one:

| Setting | Default | Description |
|---|---|---|
| `publicModelIdMode` | `collision-prefixed` | Public ID format: `collision-prefixed`, `universal`, `always-prefixed` |
| `modelExposureMode` | `scoped` | Which models to expose: `all`, `scoped`, `custom` |
| `customModels` | `[]` | Canonical model IDs for `custom` mode. An empty list exposes no model |
| `providerPrefixes` | `{}` | Provider key -> custom prefix label overrides |
| `aliases` | `{}` | Alias -> a model, a fallback chain (`targets`, `fallbackOn`), a model at a `reasoningEffort`, or a `family` ([Aliases](routing.md#aliases)) |
| `routing.reserve` | `{}` | Login (`anthropic`, `anthropic-2`) -> the share of each quota window, 0–1, that fallback chains keep free ([Quota](routing.md#quota)) |
| `routing.logins.fallbackOn` | `["rate_limit"]` | The failures that move a request from one login of a model to the next ([Several logins per provider](logins.md#several-logins-per-provider)) |
| `routing.logins.order` | `{}` | Base provider -> its logins to try first, in order (`{ "anthropic": ["anthropic-2"] }`); logins left out follow in the usual order. Set from the console's Accounts view with **Use first** ([Order and disabled logins](logins.md#order-and-disabled-logins)) |
| `routing.logins.disabled` | `[]` | Logins routing never calls, though they stay logged in; a model whose every login is disabled leaves `/v1/models`. Set from the Accounts view with **Disable** and **Enable** ([Order and disabled logins](logins.md#order-and-disabled-logins)) |
| `labels` | `{}` | Login -> the label the console shows beside it, in your words, up to 40 characters ([Several logins per provider](logins.md#several-logins-per-provider)) |

A proxy the pi extension starts gets the file's server settings as `PI_SWITCHBOARD_*` variables when it starts, so a change there needs `/proxy restart`; it reads the settings above from the file on every request, as any proxy does.

A config file is never refused for its values: an invalid value is replaced and the proxy starts anyway. A number outside its range is clamped to the nearest bound, a list or map keeps its valid entries, and anything else takes its default. One exception: an `authToken` that is not a string is not replaced by the default (which would turn auth off); the proxy refuses to start instead (see [Proxy authentication](#proxy-authentication)). A file that exists but cannot be read or is not valid JSON refuses the same way unless a flag or `PI_SWITCHBOARD_AUTH_TOKEN` sets the token, since the file may hold one; a missing file starts with the defaults. `host` is trimmed; model IDs, prefix labels and `authToken` are used exactly as written, so a padded model ID matches no model rather than exposing one. One warning names the fields that were replaced, never their values, and it repeats only when that set of fields changes.

## Checking the setup: `pi-switchboard doctor`

```bash
pi-switchboard doctor                 # the config and the last week's prompt cache
pi-switchboard doctor --window all    # today, week (the default) or all: the 30 days the stats file keeps
pi-switchboard doctor --verify        # also resolve each login, as /healthz/creds?verify=true
pi-switchboard doctor --json          # the report as JSON, for scripts
```

`pi-switchboard doctor` reads the config (`proxy-config.json`, with the same flags and variables the proxy would apply: it takes the server flags, so `pi-switchboard doctor --host 0.0.0.0` judges that bind address), pi's models and logins, and the stats file, and prints findings in two sections, each with a recommendation. It reports and recommends only: it changes no setting and no file (it opens the stats file read-only and migrates nothing), and calls no provider unless `--verify` asks it to, which may refresh an OAuth token as `/healthz/creds?verify=true` does. Its output names providers, models, aliases and settings, never a credential or message content.

- **General**: what `/healthz/models` and `/healthz/creds` judge (no model exposed, an invalid exposure config, `enabledModels` patterns that match nothing, alias diagnostics, a `routing.logins` name that is no login or a provider whose every login is disabled, no login, a login that fails `--verify`), a config file that can't be read, proxy auth that is set but can't be applied (an error: the proxy would refuse to start), proxy auth off or the docs page on while bound to an address other machines reach, stats off, and an alias's or `routing.logins`'s `fallbackOn` naming `upstream_error` or `timeout` (an alias's with its fallbacks in the window; the stats can't tell a move between logins from one to another model, so `routing.logins`' has no count). Cooldowns are not findings.
- **Cache**: from the stats file, each model with at least 20 calls in the window: a hit rate under 50%, cache writes over 40% of its cost (at catalog prices), whether `PI_CACHE_RETENTION=long` pays against its break-even (Anthropic and Bedrock only), fallbacks over 5% of its calls, and over 10% of its requests without a `prompt_cache_key` on an API that caches by key. [Prompt caching](caching.md) explains each; the doctor reads `PI_CACHE_RETENTION` from its own environment, which may not be the proxy's. Stats that are off, absent or unreadable are said so, not shown as an empty section, and so is a window in which no model had 20 calls. The section ends with what the doctor cannot tell.

Each finding has a `check` (`exposure`, `alias`, `login-routing`, `credentials`, `proxy-auth`, `docs-ui`, `stats`, `fallback-on`, `config-file`, `models-json`, `enabled-models`, `logins`; `window` (no model had 20 calls), `hit-rate`, `cache-write-cost`, `retention`, `fallbacks`, `prompt-cache-key`), a `severity` (`error`, `warning` or `advice`), a `subject` when it is about one model, alias, provider, pattern or address, a `message` and a `recommendation`. `--json` prints:

```json
{
  "general": [{ "check": "exposure", "severity": "error", "message": "…", "recommendation": "…" }],
  "cache": [{ "check": "hit-rate", "severity": "warning", "subject": "anthropic/claude-opus-5-5", "message": "…", "recommendation": "…" }],
  "window": "week",
  "statsAvailable": true,
  "limits": ["…"]
}
```

The exit status is `1` when the general section has an error (what makes `/healthz/models` or `/healthz/creds` answer `503`, or the proxy refuse to start), `2` for a usage error (an unknown flag, an argument, a `--window` it doesn't know), and `0` otherwise: warnings and the cache section never fail it. Log lines go to stderr, errors only unless `--log-level` asks for more.

A stats file from before the doctor (schema version 1) can't be read by it until a proxy has started once and migrated the file. In a new agent dir, loading pi's runtime creates pi's empty `auth.json` and `models-store.json`, as any pi start does.

The console (`pi-switchboard tui`) shows the same findings, for the proxy it runs, in its Doctor view (tab `6`): [The console](console.md#the-console-logs-logins-and-status-at-a-terminal).

## Logging

The proxy logs with [LogTape](https://logtape.org) to stderr:
- **Pretty** ([@logtape/pretty](https://jsr.io/@logtape/pretty)): readable, colored lines stamped with the local date, time and UTC offset (in a container, set `TZ`, e.g. `TZ=America/Chicago`). The default on a terminal.
- **JSON** ([JSON Lines](https://jsonlines.org)): one object per record with `@timestamp` (UTC), `level`, `logger` (the category, e.g. `pi-switchboard.server.http`), `message` and `properties`. The default when stderr is piped or redirected, as in `docker logs`. `message` quotes the string values it contains (`Listening on http://"0.0.0.0":4141`, `"GET" "/v1/models" received`) on purpose. Some values come from clients, such as the requested model, a path or a client request ID, and the quotes stop a crafted one from reading as message text. `properties` holds each value unquoted; read or query those. The pretty format prints values bare.

`PI_SWITCHBOARD_LOG_FORMAT` (or `--log-format`) picks one regardless of the terminal, for example `pretty` for reading `docker compose logs` directly.

Passing `/healthz` checks are logged at `debug`; a failed one stays at `info`.

An invalid flag stops the proxy from starting and lists the valid values: `--log-level` and `--log-format` name their options, and `--port`, `--max-body-size` and `--upstream-timeout` name their range (the same bounds the config file applies). An invalid env var is ignored with a warning: `PI_SWITCHBOARD_LOG_LEVEL` or `PI_SWITCHBOARD_LOG_FORMAT` naming no level or format, or `PI_SWITCHBOARD_PORT`, `PI_SWITCHBOARD_MAX_BODY_SIZE` or `PI_SWITCHBOARD_UPSTREAM_TIMEOUT_MS` not an integer within its bounds (digits only: `80abc` is not 80). An invalid `logLevel` in the config file falls back to `info`, and a number outside its range is clamped, so a bad value in the environment or the file never keeps a background proxy from starting.

While proxy auth is off, the proxy logs a warning at startup wherever it listens, saying who can use your provider logins through it: on loopback, any program on this machine and any web page open in a browser on it (unless the [host/origin guard](#running-without-a-token) is on); beyond loopback, anyone who can reach the port as well.

Every line a request causes carries its `requestId` (and `clientRequestId` when the client sent `X-Client-Request-Id`). At `debug` and `trace` you see the internal decisions: model resolution, conversion, upstream calls and stream events.

Message content and credentials are never logged. Credential-named properties are redacted as a backstop.

The pi extension logs nothing by default, because output would corrupt pi's terminal UI. To capture its logs, set `PI_SWITCHBOARD_EXTENSION_LOG_FILE=/path/to/extension.log` before starting pi; the extension then appends JSON Lines there at the configured log level.

## Proxy authentication

Set `PI_SWITCHBOARD_AUTH_TOKEN` to require a bearer token for every request except `GET /healthz` (the liveness check), the OpenAPI document (`GET /v1/switchboard/openapi.json`) and the docs page (`GET /docs`):

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

A `proxy-config.json` that exists but cannot be read or is not valid JSON also refuses to start when neither the flag nor `PI_SWITCHBOARD_AUTH_TOKEN` sets a token: the file may hold one the proxy cannot see, and starting on the defaults would turn it into auth off. The log names the file and the problem (`cannot be read (EACCES)`, `is not valid JSON`), never the file's contents. Fix or remove the file, or set a token by flag or environment; `/proxy start` refuses with the same reason. A missing file holds nothing and starts with the defaults. For the same reason nothing saves over such a file (the console, the settings panel), since it would write the defaults it loads as over whatever it holds; only `/proxy reset` replaces it.

### Running without a token

With proxy auth off (the default outside Docker), the proxy serves anyone who can send it a request, with your provider logins:

- **Programs on this machine.** Anything running as any user here can call `127.0.0.1:4141`.
- **Web pages you open.** Bound to `127.0.0.1`, the proxy is still reachable from your browser. A page can send it a chat request it cannot read the answer to (a cross-origin form or `fetch` with `Content-Type: text/plain`, which the proxy parses as JSON), spending your quota. With DNS rebinding (the page's own domain resolving to `127.0.0.1`), it can also read every answer: list your models and logins, and run chats on your subscriptions.
- **Anyone on the network**, when the proxy listens beyond loopback (`--host 0.0.0.0`, a LAN address).

A token stops all three: a page can't know it, and nothing answers without it but `/healthz`, the OpenAPI document and the docs page, which name no model, login or credential. Set one with `--auth-token`, `PI_SWITCHBOARD_AUTH_TOKEN` or `p` in the console. The Docker image refuses to start without one.

If you keep auth off, the **host/origin guard** (`hostOriginGuard`, `--host-origin-guard`, `PI_SWITCHBOARD_HOST_ORIGIN_GUARD`; off by default) stops web pages. It refuses, with `403`, before proxy auth and on every path:

- a `Host` that isn't an IP address, a name with no dot (`localhost`, a Docker service name such as `proxy`) or `host.docker.internal`, with code `invalid_host`. A DNS-rebinding page's requests carry its own domain, which always has a dot;
- an `Origin` other than the proxy's own (`http://<Host>` or `https://<Host>`, which the `/docs` page sends), `null` included, with code `invalid_origin`. A browser sends `Origin` on every cross-origin request that can change something; curl, the OpenAI SDKs and docker-agent send none.

It lets through every client that names the proxy by an address or a plain name: `127.0.0.1`, `localhost`, a LAN address, a container reaching the host as `host.docker.internal`. It refuses a dotted name it can't vouch for, such as an mDNS name (`mybox.local`) or a reverse proxy's domain, so leave it off in those setups and set a token. It does not protect a proxy reachable on the network: a client there sends no `Origin` and can use an IP address. Only a token does. A change applies on restart.
