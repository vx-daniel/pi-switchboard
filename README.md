# pi-switchboard

A local OpenAI-compatible HTTP API built on [pi](https://github.com/badlogic/pi-mono)'s SDK. Routes requests through pi's multi-provider model registry and credential management, exposing a single `http://localhost:4141/v1/...` endpoint that any OpenAI-compatible client can connect to. It started as [`pi-openai-proxy`](#attribution).

## Why

- **Single gateway** to 20+ LLM providers (Anthropic, OpenAI, Google, Bedrock, Mistral, xAI, Groq, OpenRouter, Vertex, etc.) via one OpenAI-compatible API
- **No duplicate config** — reuses pi's `~/.pi/agent/auth.json` and `models.json` for credentials and model definitions
- **Self-hosted** — runs locally, no third-party proxy services
- **Streaming** — full SSE streaming with token usage and cost tracking
- **Strict validation** — unsupported parameters are rejected clearly, not silently ignored, and every response is checked against OpenAI's published spec

Where it's going (see [`ROADMAP.md`](ROADMAP.md)): routing across your pi logins — aliases, fallback chains, cooldowns and quota awareness (#66–#70) — and more of OpenAI's API, starting with the Responses API (#140). It stays OpenAI-compatible on the client side; it doesn't run logins of its own, keep conversation state, or speak other vendors' client protocols.

## Prerequisites

1. [pi](https://github.com/badlogic/pi-mono) must be installed
2. At least one provider must be configured via `pi /login`
3. [Node.js](https://nodejs.org) >= 24 (the same runtime pi uses)

## Installation

The package is published to GitHub Packages, whose npm registry needs a GitHub token to install anything, public packages included. The Docker image needs none: see [Docker](#docker).

**Once, before the first install:**

1. Create a GitHub personal access token (classic) with the `read:packages` scope. GitHub Packages accepts only classic tokens.
2. Point the `@vx-daniel` scope at GitHub Packages in `~/.npmrc`. These two lines send only `@vx-daniel/*` packages there; everything else still comes from npmjs:

   ```ini
   @vx-daniel:registry=https://npm.pkg.github.com
   //npm.pkg.github.com/:_authToken=<your token>
   ```

**Then:**

```bash
# As a pi package: /proxy, the settings panel and the model selector inside pi
pi install npm:@vx-daniel/pi-switchboard

# Or the CLI on its own
pnpm add -g @vx-daniel/pi-switchboard
```

Install by the package name, as above. pi also accepts a tarball URL (`npm:https://…/x.tgz`), but pi 1.3.0 then reports the package as installed without loading its extension.

pi's own packages (`@earendil-works/pi-ai`, `pi-coding-agent`) are optional dependencies, so that pi, which provides them to its extensions, does not load a second copy (#165). Every installer adds optional dependencies by default. Installed with `--omit=optional` or `--no-optional`, the `pi-switchboard` CLI cannot start: it says which package is missing and exits with status `1`.

### Coming from pi-openai-proxy

Version 0.1.0 renamed everything that carried the old name, with no aliases:

| Before | Now |
|---|---|
| package `@vx-daniel/pi-openai-proxy`, command `pi-openai-proxy` | `@vx-daniel/pi-switchboard`, `pi-switchboard` |
| env vars `PI_PROXY_*` (e.g. `PI_PROXY_AUTH_TOKEN`, `PI_PROXY_PORT`) | `PI_SWITCHBOARD_*` (`PI_SWITCHBOARD_AUTH_TOKEN`, `PI_SWITCHBOARD_PORT`, same suffixes) |
| header `X-Pi-Upstream-Api-Key` | `X-Switchboard-Upstream-Api-Key` |
| log categories `pi-openai-proxy.*` | `pi-switchboard.*` |

- **A `PI_PROXY_*` variable that is still set is not read.** The proxy warns about it at startup and names the replacement.
- **An old `PI_PROXY_AUTH_TOKEN` stops the proxy from starting** unless `PI_SWITCHBOARD_AUTH_TOKEN` or `--auth-token` is set. This applies even when it is empty, and even with a token in the config file. Ignoring it would quietly drop the token you meant.
- **A chat completion request with the old header gets a 400** that names the new one. It's checked after proxy auth and only on `/v1/chat/completions`, the one route that reads the key.
- **Unchanged:** `proxy-config.json` in pi's agent directory, the `/proxy` command and `x_pi`.

## Quickstart

```bash
# Start the proxy (defaults to http://127.0.0.1:4141)
pi-switchboard

# Which version is installed
pi-switchboard --version
```

### The console: logs, logins and status at a terminal

```bash
pi-switchboard tui            # takes the same flags as pi-switchboard
```

`pi-switchboard tui` runs the proxy with a full-screen console. Quitting it (`q` or Ctrl+C) stops the proxy. It needs a terminal; from a script or a service, run `pi-switchboard` without `tui`.

- **Logs (`1`).** The live log, in the pretty format, redacted as on stderr. It follows new lines; `↑` `↓` `PgUp` `PgDn` scroll back, `End` follows again. The console keeps the last 5000 lines.
- **Accounts (`2`).** Each provider pi has a credential for: account or API key, where pi found it, and how many of its models are available. `v` verifies them, which may refresh an account's token.
- **Status line.** The address, whether proxy auth is on, how many models are exposed and available, active cooldowns, and a `models.json` error if there is one.
- **Log in (`n`) and log out (`x`) through pi.** `n` opens pi's own login list: every account and API key login pi offers. The login runs on pi's own screens and pi stores the credential in its `auth.json`, exactly as `pi /login` does, and the proxy serves the provider's models at once, without a restart. A browser sign-in waits for the browser, or takes the pasted redirect URL when the browser is on another machine; `Ctrl+X` copies the sign-in URL and `Esc` cancels. `x` removes a credential pi stored; one from an environment variable or `models.json` stays.

Logins are only ever offered in this local console, never over HTTP.

### List available models

```bash
curl http://localhost:4141/v1/models | jq '.data[].id'
```

### Chat completion (non-streaming)

```bash
curl http://localhost:4141/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "anthropic/claude-sonnet-4-20250514",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### Chat completion (streaming)

```bash
curl http://localhost:4141/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openai/gpt-4o",
    "messages": [{"role": "user", "content": "Tell me a joke"}],
    "stream": true
  }'
```

### Use with any OpenAI-compatible client

Point any client that supports `OPENAI_API_BASE` (or equivalent) at `http://localhost:4141/v1`:

```bash
# Example: Aider
OPENAI_API_BASE=http://localhost:4141/v1 aider --model anthropic/claude-sonnet-4-20250514

# Example: Continue (in settings.json)
# "apiBase": "http://localhost:4141/v1"

# Example: Open WebUI
# Set "OpenAI API Base URL" to http://localhost:4141/v1
```

### Model resolution

The proxy resolves model references in this order:

1. **Exact public ID match** — the ID from `GET /v1/models`
2. **Canonical ID fallback** — `provider/model-id` format (only for exposed models)
3. **Alias** — a name from `aliases` in the config file ([below](#aliases))

With the default `collision-prefixed` mode and no collisions, model IDs are exposed without prefixes:

```bash
curl http://localhost:4141/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-4o", "messages": [{"role": "user", "content": "Hi"}]}'
```

## Supported Endpoints

The stable routes are the first three rows. [`PLAN.md`](PLAN.md) "Stable surface" is the authoritative list, and says what a route must meet to join it.

| Endpoint | Description |
|---|---|
| `GET /v1/models` | List exposed models (filtered by exposure mode, only those with configured credentials) |
| `GET /v1/models/{model}` | Model details by public ID or canonical ID (supports URL-encoded IDs with `/`) |
| `POST /v1/chat/completions` | Chat completions (streaming and non-streaming) |
| `GET /v1/switchboard/models` | Not OpenAI's: each exposed model's pi capabilities, such as its supported `reasoning_effort` values ([below](#discovering-available-models)) |
| `GET /v1/switchboard/openapi.json` | Not OpenAI's: this API as an OpenAPI 3.1 document ([below](#api-documentation)) |
| `GET /docs` | Off by default: Swagger UI for the document, to read the API and try requests ([below](#api-documentation)) |

### API documentation

`GET /v1/switchboard/openapi.json` describes every route the proxy serves: each request and response schema, every error status, and the bearer token. It includes the health checks below and the OpenAI endpoints the proxy answers with 404 ("Not supported"). Point any OpenAPI tool at it, such as a client generator, Postman or an API diff. The same document is committed as [`openapi.json`](openapi.json), so a change to the API shows up in a pull request.

Turn on `docsUi` (`--docs-ui`, `PI_SWITCHBOARD_DOCS_UI=true`, or the settings panel) and open `http://localhost:4141/docs` in a browser to browse the API and send requests with "Try it out". With proxy auth on, click **Authorize** and enter the token first. The page loads Swagger UI 5.34.0 from the jsDelivr CDN, so it needs internet access; that is why it is off by default. While it is off, `/docs` answers 404.

Neither route needs the proxy token, even with proxy auth on: a browser cannot send one to open a page. Both name routes and schemas only, never a model, provider or credential, and every route they describe still needs the token.

### Health checks

Operational endpoints, outside the OpenAI-compatible `/v1` surface:

| Endpoint | Auth | Answers |
|---|---|---|
| `GET /healthz` | Never | `200 {"status":"ok"}` once the proxy listens and pi's model runtime is loaded. No upstream calls: use it for container healthchecks and liveness probes. |
| `GET /healthz/models` | Proxy token, if set | Available and exposed model counts, exposure modes, a `models.json` load error (a parse error says only where the file is not valid JSON, never what it says there), unresolved `enabledModels` patterns (`scopeDiagnostics`), aliases left out (`aliasDiagnostics`), and active cooldowns (`cooldowns`, [below](#cooldowns)). `503` when no model is exposed, the exposure config is invalid, or an alias is named like an exposed model; a cooldown does not fail it. |
| `GET /healthz/creds` | Proxy token, if set | Per provider with a credential: `type` (`oauth` or `api_key`), `source` (`stored`, `environment`, `models_json_key`, …), `availableModelCount`, and `quota`, the subscription's latest usage windows ([Quota](#quota)). `503` when no provider has one. Reads local state only; `?verify=true` also has pi resolve each credential now and adds `verified` and `error` per provider, `503` if any fails. |

None of them returns a credential. `/healthz` proves the process is up, not that a provider will accept a request: `GET /healthz/creds?verify=true` is the closest check to that without spending a completion.

- **`verify=true` costs what a real request's credential lookup costs.** pi refreshes an OAuth token only when it is about to expire and caches the output of a `models.json` key command, so polling it mostly stays local; the network call it can make is the refresh the next real request would have made. A failed verification reports pi's summary, the token URL and the upstream HTTP status; the upstream response body goes to the `debug` log only.
- **Without `PI_SWITCHBOARD_AUTH_TOKEN`, the detail endpoints are open**, like `/v1/*`. Bound to `127.0.0.1` (the default) that is local only; on `0.0.0.0` set a token, or anyone who can reach the port sees your provider names and model counts.

```bash
curl -fsS http://localhost:4141/healthz
curl -fsS http://localhost:4141/healthz/creds?verify=true -H "Authorization: Bearer $PI_SWITCHBOARD_AUTH_TOKEN"
```

## Supported Chat Completions Features

| Feature | Notes |
|---|---|
| `model` | Public ID, canonical (`provider/model-id`), or collision-prefixed shorthand |
| `messages` (text) | `system`, `developer`, `user`, `assistant`, `tool` roles. `system` and `developer` before the first turn form the system prompt; a later one stays in place on models that accept mid-conversation instructions (pi's `supportsMidConvoSystemMessages`; Anthropic: just before the next answer) and is merged into the system prompt on others |
| `messages` (base64 images) | Base64 data URI image content parts (`image/png`, `image/jpeg`, `image/gif`, `image/webp`) |
| Fields inside messages | Checked like the top level: a field OpenAI doesn't define, or one the proxy doesn't take, is rejected with `422` at its path (`messages.0.content.0.cache_control`). `name` on a message and `image_url.detail` are accepted and dropped (pi has no equivalent; logged at `debug`). An assistant reply an OpenAI SDK echoes back is accepted as it sends it: `refusal`, `audio`, `function_call` and `tool_calls` as `null`, and the response field `annotations` as `null` or `[]` |
| `messages` (remote images) | Only with the remote-images setting on (off by default): the proxy downloads each `http`/`https` image URL and sends it to the provider as base64. Public hosts only, at most 8 per request and 15 MiB in all, 10 seconds each, 3 redirects; see [Security defaults](#security-defaults). Off, a remote URL is rejected with `400` |
| `stream` | SSE with `text_delta` and `toolcall_delta` mapping |
| `temperature` | Passed through, with two exceptions, each logged (the first per model at `info`, later ones at `debug`): Codex models (`openai-codex-responses`), where the backend rejects it, so the proxy drops it; and Claude models pi marks as not accepting it (Claude 4.7 and later, which refuse a temperature below 1) or any Claude request with thinking on, where pi leaves it out itself |
| `max_completion_tokens` | Preferred; `max_tokens` accepted as deprecated fallback |
| `stop` | Via passthrough |
| `user` | Via passthrough |
| `stream_options.include_usage` | Final usage chunk in SSE stream |
| `tools` / `tool_choice` | Tool parameter schemas: JSON Schema subset with per-type constraints carried upstream; other keywords get `422` naming keyword and path (see [Tool schema policy](PLAN.md#tool-schema-policy)). `tool_choice` translated per-provider |
| `strict` on function tools | Applied where pi marks the model strict-capable, in each API's own shape (OpenAI, Responses, Anthropic, …). Strict rewrites the schema: every property becomes required and optional ones nullable, so the model may send `null` for a field it would otherwise omit. Elsewhere, or when the schema is outside the provider's strict subset, the tool is sent without strict, with no error (see [PLAN.md](PLAN.md#strict-on-function-tools--strict-where-supported-44)) |
| `tool_calls` in messages | Assistant tool call + tool result roundtrip |
| `parallel_tool_calls` | Forwarded to OpenAI/Codex; translated to `disable_parallel_tool_use` for Anthropic |
| `reasoning_effort` | Maps to pi's thinking level of the same name (`none` through `max`). `none` turns reasoning off (Anthropic `thinking: disabled`, OpenAI `effort: none`). An effort the model does not support is clamped with pi's `clampThinkingLevel`: the nearest supported level above it, else the nearest below. So `none` on a model whose reasoning cannot be turned off is its lowest level (not the provider's default), `xhigh` on a model with `max` but no `xhigh` is `max`, `max` on a model without it is its highest level, and any effort on a model without reasoning is off. A clamp is logged at `debug`; `GET /v1/switchboard/models` lists the efforts each model supports. For a custom `models.json` model with `reasoning: true`, `none` sends whatever its `thinkingLevelMap.off` says: nothing if unset, so set `off: "none"` (or `off: null` if reasoning cannot be turned off) when the endpoint reasons by default |
| `response_format` | `text`, `json_object`, and `json_schema` (OpenAI-compatible APIs only) |
| `top_p` | Supported by OpenAI, Anthropic (native), and Google (translated to `topP`) |
| `frequency_penalty` | OpenAI and Google only (translated to `frequencyPenalty`) |
| `presence_penalty` | OpenAI and Google only (translated to `presencePenalty`) |
| `seed` | OpenAI and Google only (translated to `seed` in Google's generation config) |
| `stop` | Translated per-provider (`stop_sequences` for Anthropic, `stopSequences` for Google) |
| `metadata` | OpenAI passthrough; arbitrary keys silently skipped for other providers |
| `prediction` | OpenAI passthrough only (speculative decoding) |
| `prompt_cache_key` | Becomes pi's session ID, which pi sends where the provider takes one: OpenAI Responses and Codex as `prompt_cache_key` (Codex also keeps a WebSocket per session and sends only the new messages), chat completions to `api.openai.com` as `prompt_cache_key`, and an affinity header for Anthropic-API gateways that ask for one (OpenRouter; never a direct Anthropic OAuth login, where caching needs no key). Elsewhere it changes nothing. Surrounding spaces are trimmed (so `" a "` and `"a"` are one key), then it must be 1–64 characters; `null` is the same as none. Send one stable key per conversation |
| `prompt_cache_breakpoint` on content parts | Accepted on text and image parts. Sent on to OpenAI's own API (chat completions and Responses at `api.openai.com`), where it marks the end of a reusable prompt prefix; dropped for every other provider (Codex sends the system prompt as a plain string, and other servers may refuse a field they don't know), and logged at `debug`. A model on `api.openai.com` that refuses it with a `400` (the ChatGPT-subscription models such as `gpt-6-luna`) gets the request once more without it, and from then on it is left out for that model until the proxy restarts, logged once at `info`. It only affects caching |

**Not supported:** `n` (any value), `logprobs`, `top_logprobs`, `logit_bias`, and the deprecated `functions` / `function_call`, each rejected with `422`; `prompt_cache_retention` (deprecated by OpenAI) and `prompt_cache_options` (no pi equivalent), rejected as unknown with `422`; a value in an assistant message's `refusal`, `audio`, deprecated `function_call` or `annotations`, rejected with `422`; `name` on a `tool` message (OpenAI defines none there; the call a result answers names the tool), rejected as unknown with `422`; remote image URLs while the remote-images setting is off, rejected with `400`.

### Provider-aware field translation

Fields are translated to each provider's native format, not blindly forwarded:

- **OpenAI / Mistral**: All fields passed directly (same wire format)
- **Codex (Responses API)**: Only `tool_choice` and `parallel_tool_calls` (other fields rejected by API); `temperature` is dropped, as the Codex backend rejects it
- **Anthropic**: `tool_choice` → `{ type }` format, `stop` → `stop_sequences`, `user` → `metadata.user_id`, `parallel_tool_calls: false` → `disable_parallel_tool_use`
- **Google**: Translated to camelCase names (`topP`, `stopSequences`, `seed`, `frequencyPenalty`, `presencePenalty`) in Google's generation config; `tool_choice` maps to `toolConfig.functionCallingConfig.mode`

Fields that have no equivalent in a target provider are skipped: the request succeeds and the provider's default applies. That, dropping `temperature` on Codex models, and dropping `prompt_cache_breakpoint` where the provider has no slot for it or the model refuses it are the only parameters the proxy ignores instead of rejecting; `CONSTITUTION.md` (principle I) lists them as deliberate exceptions, and PLAN.md's per-API tables list exactly what each API receives.

## Model Naming and Exposure

### Public model IDs

The proxy generates public model IDs based on a configurable ID mode:

| Mode | Behavior | Example |
|---|---|---|
| `collision-prefixed` (default) | Raw model IDs; prefix only providers that share a model name | `gpt-4o` or `openai/gpt-4o` if `codex` also has `gpt-4o` |
| `universal` | Raw model IDs only; rejects config if duplicates exist | `gpt-4o`, `claude-sonnet-4-20250514` |
| `always-prefixed` | Always `<prefix>/<model-id>` | `openai/gpt-4o`, `anthropic/claude-sonnet-4-20250514` |

The `collision-prefixed` mode prefixes **all** models from providers that form a connected conflict group (not just the colliding model names).

### Exposure modes

Control which models appear in the API:

| Mode | Behavior |
|---|---|
| `all` | Expose every model with configured credentials |
| `scoped` (default) | Expose the models pi's global `enabledModels` setting selects (`/scoped-models` in pi, or `settings.json`), resolved as pi resolves them: exact `provider/id`, bare IDs, globs such as `anthropic/*` or `*sonnet*`, and `:level` suffixes. As in pi, a bare word also matches by substring of a model's ID or name (`opus` selects an Opus model), and a pattern several providers match exposes all of them (listed as `ambiguous`): write `provider/id` to pick one. With no `enabledModels`, every model with credentials, as `all`. Patterns that match nothing are listed in `/healthz/models`. pi's `--models` flag is per session, so it does not apply |
| `custom` | Expose an explicit allowlist of canonical IDs (`customModels`), matched exactly |

pi lists every model a provider offers, including some the login's plan cannot run: with a ChatGPT login, Codex refuses `gpt-5.5` and `gpt-5.3-codex-spark`, for example. Such a model answers `404` `model_not_found` ("not available with the provider login the proxy uses"), and the proxy logs the refusal as an error. To stop exposing it, select the models you can use in pi's `enabledModels` (`scoped`), or list them in `customModels` (`custom`).

### Canonical model IDs

Internal canonical IDs use the `provider/model-id` format matching pi's registry:

```
anthropic/claude-sonnet-4-20250514
openai/gpt-4o
google/gemini-2.5-pro
xai/grok-3
openrouter/anthropic/claude-sonnet-4-20250514
```

Canonical IDs are accepted as backward-compatible fallback in requests, but only for models that are currently exposed. Hidden models cannot be reached by canonical ID.

## Configuration

### What comes from pi

The proxy reads two files from pi's configuration directory (`~/.pi/agent/`):

| File | Managed by | What the proxy uses |
|---|---|---|
| `auth.json` | `pi /login` | API keys for each provider (Anthropic, OpenAI, Google, etc.) |
| `models.json` | pi built-in + user edits | Model definitions, capabilities, and pricing |

From pi's `settings.json` the proxy reads only `enabledModels`, for `scoped` exposure. It does **not** read installed packages, enabled extensions, or session-level model filters (`--models` flag).

### What the proxy adds

Proxy-specific settings are configured via CLI flags, environment variables, the JSON config file (`~/.pi/agent/proxy-config.json`), or the `/proxy config` panel (when installed as a pi package). Priority: flag > env var > config file > default:

| Setting | Env variable | Default | Description |
|---|---|---|---|
| Bind address | `PI_SWITCHBOARD_HOST` | `127.0.0.1` | Network interface (`127.0.0.1` = local only, `0.0.0.0` = all) (`--host`, `host` in the config file) |
| Port | `PI_SWITCHBOARD_PORT` | `4141` | HTTP listen port (`--port`, `port`) |
| Auth token | `PI_SWITCHBOARD_AUTH_TOKEN` | (disabled) | Bearer token for proxy authentication (`--auth-token`, `authToken`) |
| Remote images | `PI_SWITCHBOARD_REMOTE_IMAGES` | `false` | Fetch remote image URLs server-side and inline them as base64; off, they are rejected with `400`. The proxy then makes requests for its clients, so only public `http`/`https` hosts are allowed (see [Security defaults](#security-defaults)) (`--remote-images`, `remoteImages`) |
| Docs UI | `PI_SWITCHBOARD_DOCS_UI` | `false` | Serve Swagger UI at `/docs` ([API documentation](#api-documentation)); it loads its scripts from a CDN (`--docs-ui`, `docsUi`) |
| Max body size | `PI_SWITCHBOARD_MAX_BODY_SIZE` | `52428800` (50 MB) | Maximum request body size in bytes (`--max-body-size` and `maxBodySizeMb` in the config file take MB, 1–500) |
| Upstream timeout | `PI_SWITCHBOARD_UPSTREAM_TIMEOUT_MS` | `120000` (120s) | How long the upstream provider may send nothing (no stream event of any kind: thinking, text and tool calls, but also chunks pi makes nothing of, such as OpenAI Responses lifecycle events; SSE comment lines and Anthropic `ping` events do not count) before the call is aborted, in milliseconds (`upstreamTimeoutSec` in the config file, 5–600). The first wait starts with the call, so it includes pi's credential lookup (an OAuth refresh, say); after that it restarts with every event, so it never cuts off a long answer that keeps arriving. A request that hits it before the provider answered gets `504`, streamed or not; a stream that already started gets an error event. |
| Log level | `PI_SWITCHBOARD_LOG_LEVEL` | `info` | Lowest level logged: `trace`, `debug`, `info`, `warning`, `error`, `fatal` (also `--log-level`, and `logLevel` in the config file) |
| Log format | `PI_SWITCHBOARD_LOG_FORMAT` | pretty on a terminal, `json` otherwise | `pretty` or `json` (also `--log-format`; no config-file key) |

### Logging

The proxy logs with [LogTape](https://logtape.org) to stderr:
- **Pretty** ([@logtape/pretty](https://jsr.io/@logtape/pretty)): readable, colored lines stamped with the local date, time and UTC offset (in a container, set `TZ`, e.g. `TZ=America/Chicago`). The default on a terminal.
- **JSON** ([JSON Lines](https://jsonlines.org)): one object per record with `@timestamp` (UTC), `level`, `logger` (the category, e.g. `pi-switchboard.server.http`), `message` and `properties`. The default when stderr is piped or redirected, as in `docker logs`. `message` quotes the string values it contains (`Listening on http://"0.0.0.0":4141`, `"GET" "/v1/models" received`) on purpose. Some values come from clients, such as the requested model, a path or a client request ID, and the quotes stop a crafted one from reading as message text. `properties` holds each value unquoted; read or query those. The pretty format prints values bare.

`PI_SWITCHBOARD_LOG_FORMAT` (or `--log-format`) picks one regardless of the terminal, for example `pretty` for reading `docker compose logs` directly.

Passing `/healthz` checks are logged at `debug`; a failed one stays at `info`.

An invalid `--log-level` or `--log-format` stops the proxy from starting and lists the valid values. An invalid `PI_SWITCHBOARD_LOG_LEVEL` or `PI_SWITCHBOARD_LOG_FORMAT` is ignored with a warning, and an invalid `logLevel` in the config file falls back to `info`, so a bad value in either never keeps a background proxy from starting.

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
| `aliases` | `{}` | Alias -> the canonical ID of an exposed model ([Aliases](#aliases)) |

When used as a pi package, all settings are persisted in `~/.pi/agent/proxy-config.json` and applied when the extension spawns the proxy.

A config file is never refused: an invalid value is replaced and the proxy starts anyway. A number outside its range is clamped to the nearest bound, a list or map keeps its valid entries, and anything else takes its default. One exception: an `authToken` that is not a string is not replaced by the default (which would turn auth off); the proxy refuses to start instead (see [Proxy authentication](#proxy-authentication)). `host` is trimmed; model IDs, prefix labels and `authToken` are used exactly as written, so a padded model ID matches no model rather than exposing one. One warning names the fields that were replaced, never their values, and it repeats only when that set of fields changes.

### Aliases

Most clients only let you pick a model name, so an alias is the routing control every client has. Define names in `proxy-config.json`, each pointing at an exposed model's canonical ID:

```json
{ "aliases": { "coding": "anthropic/claude-opus-5-5", "cheap": "anthropic/claude-haiku-5-5" } }
```

- **Request it like a model.** `"model": "coding"` is answered by `anthropic/claude-opus-5-5`. The response's `model` is the target's canonical ID, so you see which model answered, and `x_pi.alias` is `coding`, in a non-streamed response and in every stream chunk. The request log line names the alias too.
- **Listed beside the models.** `coding` appears in `GET /v1/models` (with the target's provider as `owned_by`), in `GET /v1/models/coding`, and in `GET /v1/switchboard/models` with the target's `reasoning_efforts`.
- **Only while its target is exposed.** An alias never reaches a model the exposure config hides: leave the target out of `enabledModels` (or `customModels`) and the alias disappears too. `/healthz/models` then lists it as `target-not-exposed`.
- **Never shadows a model.** An alias named like an exposed model's public or canonical ID is ignored, and the model keeps its name. `/healthz/models` answers `503` and lists it as `shadows-model`, and the proxy logs a warning. Rename the alias.
- **Used as written.** Names and targets are not trimmed or normalized; a mistyped target matches no model. An entry with an empty name or target is dropped with the config warning.
- **In pi,** `/proxy show` lists the aliases and any left out. Editing them in the settings panel can come later.

#### Fallback chains

An alias can name several models, tried in order, and the failures that move to the next one. `fallbackOn` is required: the proxy falls back only on what you list.

```json
{ "aliases": { "coding": {
  "targets": ["anthropic/claude-opus-5-5", "openai-codex/gpt-6-sol", "github-copilot/claude-sonnet-5-5"],
  "fallbackOn": ["rate_limit", "unavailable", "timeout"]
} } }
```

| Class | Failure before the response starts |
|---|---|
| `rate_limit` | 429, or a usage limit (a ChatGPT login's Codex limit) |
| `unavailable` | 503, 529 overloaded, or a provider saying it is out of capacity |
| `timeout` | 504, or the upstream idle timeout |
| `auth` | The credential fails (the provider's 401 or 403, or no credential pi can resolve) |
| `refused` | The login can't run the model (`404 model_not_found`) |
| `upstream_error` | Any other upstream failure, a network failure included |

- **Never on the request's own fault, or once the answer has started.** A `400`, the client leaving, and a failure after a stream sent its first byte are answered as they are without a chain. After the last target, the client gets that target's failure.
- **Visible.** The response's `model` is the model that answered. `x_pi.attempts` lists each model tried before it and why it failed (`[{ "model": "anthropic/claude-opus-5-5", "reason": "rate_limit" }]`), in a non-streamed response and in every stream chunk. Each hop is a warning in the log, naming the alias, the model, the class and the next model.
- **Exposed targets only.** A target the exposure config hides is skipped (and listed in `/healthz/models` as `target-not-exposed`). The alias is listed while one target is exposed, as the first exposed one.
- **Targets as written.** A target listed twice is tried twice, which is a retry of the same model. `targets` needs at least one entry.
- **Images go to a model that takes them.** An image request skips the chain's text-only models when another one accepts images.
- **No fallback with your own key.** A request with `X-Switchboard-Upstream-Api-Key` runs on the first target only: the key is one provider's.
- **No opt-out per request.** To avoid a chain, name the model directly (its canonical ID); for a shorter chain, define another alias.
- **Timeouts add up.** The upstream idle timeout applies to each attempt, so a three-model chain can wait up to three timeouts before failing.

#### Cooldowns

A provider that answers 429 is cooled down, so a chain stops calling it first on every request.

- **What cools.** A `429` cools the whole provider: pi has one login per provider, and a subscription's limit covers the account. A `503` or `529` cools only that model.
- **For how long.** As long as the failed response says: `retry-after-ms` or `retry-after`, a body field such as Codex's `resets_in_seconds` or `resets_at`, OpenAI's `x-ratelimit-reset-*` or Anthropic's `anthropic-ratelimit-*-reset` headers, or the message's own words ("try again in 20s"). There is no cap, so a weekly limit cools the provider until it resets. When the response gives no time, the cooldown grows: 60 s, then 180 s, then doubling (360 s, 720 s, …) for each failure in a row. A stated time or a success starts it over. Google's API doesn't let the proxy read the response, so Google models always use the growing default. The proxy calls Codex over SSE rather than pi's default WebSocket, so that it can read Codex's response; a Codex usage limit answers `429` `rate_limit` like any other provider's (#185).
- **Who skips.** Only a chain whose `fallbackOn` names the class (`rate_limit` for a 429, `unavailable` for a 503) skips a cooling model. A request that names the model, or a chain that names neither, still calls it. When every model left in the chain is cooling, the one whose cooldown ends first is called.
- **Visible.** A skipped model is listed in `x_pi.attempts` with `"skipped": true` and the reason; the log has a line for each cooldown that starts, ends or is skipped. `/healthz/models` lists the active ones (`scope`, `provider`, `model`, `reason`, `until`, `secondsLeft`, `source`), and `/v1/switchboard/models` gives each model's `cooldown` (`reason`, `scope`, `until` in Unix seconds), so a client can pick another model or wait.
- **Ended early by a success.** A call to the provider or model that succeeds clears its cooldown, if the call was sent after the cooldown started. Cooldowns live in memory: a restart forgets them. A request that sends its own key (`X-Switchboard-Upstream-Api-Key`) neither starts nor clears one, as it isn't using the proxy's login.
- **No hidden retries.** pi calls each provider once per attempt (the provider SDKs' own retries are off), so a 429 reaches the proxy at once and the chain moves on without waiting.

#### Quota

Subscriptions report on every response how much of each usage window the account has used. The proxy keeps the latest report per provider and shows it on `/healthz/creds` and, per model, on `/v1/switchboard/models`. A client can check whether a model has room before starting a long run, without making a call.

```json
"quota": { "observed_at": 1792622040, "status": "allowed", "plan": null, "windows": [
  { "name": "5h", "used": 0, "resets_at": 1792639800, "window_minutes": 300, "status": "allowed" },
  { "name": "7d", "used": 0.47, "resets_at": 1792893600, "window_minutes": 10080, "status": "allowed" }] }
```

- **Who reports.** Anthropic subscriptions (`5h` and `7d` windows) and Codex's ChatGPT plans (`primary`, 5 hours, and `secondary`, 7 days). Google and API-key logins report nothing, and show `null`.
- **`used`** is the share of the window used, from 0 to 1. A window that has reset since is left out, and a provider with nothing left to show is `null` until its next response.
- **Only the shared login.** A request that sends its own key records nothing. Only the window fields, status and plan are kept, never an account or organization ID.
- Routing on quota (skipping a provider that's nearly out) isn't built yet ([#69](https://github.com/vx-daniel/pi-switchboard/issues/69)).

### Discovering available models

List all models the proxy exposes (filtered by the active exposure mode):

```bash
curl http://localhost:4141/v1/models | jq '.data[].id'
```

Model objects follow the standard OpenAI shape (`id`, `object`, `created`, `owned_by`) with no proprietary extensions. `created` is the Unix time the proxy started, the same for every model, because pi's catalogue has no release dates and OpenAI requires the field. Don't read it as a model's age; choose models by what `GET /v1/switchboard/models` reports.

`GET /v1/switchboard/models` (not part of OpenAI's API; proxy token, if set) lists what pi knows about each exposed model beyond that: its pi catalogue entry, with any `models.json` values. An alias shows its target's entry.

| Field | Meaning |
|---|---|
| `provider` | pi's provider (`owned_by` on `/v1/models`) |
| `reasoning` | Whether the model reasons |
| `reasoning_efforts` | The `reasoning_effort` values the model runs at as asked, lowest first (`["none"]` for a model without reasoning). Any other value is accepted and clamped |
| `input` | What it accepts: `text`, `image` |
| `context_window`, `max_output_tokens` | In tokens |
| `cost` | USD per million tokens: `input` (uncached), `output`, `cache_read`, `cache_write`; `0` where pi has no price |
| `cooldown` | `null`, or the cooldown the model is under after a 429 or 503: `reason`, `scope` (`provider` or `model`), `until` (Unix seconds) ([Cooldowns](#cooldowns)) |
| `quota` | `null`, or its provider's latest usage windows ([Quota](#quota)) |

```json
{ "object": "list", "data": [{ "id": "claude-sonnet-4-5", "provider": "anthropic", "reasoning": true,
  "reasoning_efforts": ["none", "minimal", "low", "medium", "high"], "input": ["text", "image"],
  "context_window": 200000, "max_output_tokens": 64000,
  "cost": { "input": 3, "output": 15, "cache_read": 0.3, "cache_write": 3.75 }, "cooldown": null,
  "quota": null }] }
```

docker-agent prices a model reached through a custom `base_url` only from a `cost` table in `team.yaml`, so a team can take these prices; without one it records usage but no cost. The path was `GET /v1/pi/models` before 0.1.0; the old path is gone.

### Per-request API key override

The `X-Switchboard-Upstream-Api-Key` header overrides the registry-resolved API key for a single request. This keeps `Authorization` available for proxy authentication:

```bash
curl http://localhost:4141/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Switchboard-Upstream-Api-Key: sk-your-key-here" \
  -d '{"model": "openai/gpt-4o", "messages": [{"role": "user", "content": "Hi"}]}'
```

### Proxy authentication

Set `PI_SWITCHBOARD_AUTH_TOKEN` to require a bearer token for every request except the `GET /healthz` liveness check:

```bash
PI_SWITCHBOARD_AUTH_TOKEN=my-secret-token pi-switchboard

# Clients must include the token
curl http://localhost:4141/v1/models \
  -H "Authorization: Bearer my-secret-token"
```

The token can also live in the config file (`"authToken": "…"`); a flag or `PI_SWITCHBOARD_AUTH_TOKEN` wins over it, and `"authToken": ""` (the default) turns auth off. An `authToken` that is set but is not a string (`12345`, `true`, `null`, an object) does **not** turn auth off: the proxy refuses to start, logging why (naming the field, never its value) and exiting with status `1`, until the file is fixed or a token is set by flag or environment. `/proxy start` refuses too, with the reason. The settings panel and `/proxy show` say "invalid"; saving another setting from the panel keeps the file's value, and only a choice on the auth row (or `/proxy reset`) replaces it.

An empty override (`--auth-token ''` or `PI_SWITCHBOARD_AUTH_TOKEN=`) refuses to start the same way, naming the flag or variable. The config file's token is not used instead; unset the variable to use it. An empty `PI_SWITCHBOARD_AUTH_TOKEN` in pi's own environment reaches a proxy the extension starts, so `/proxy start` refuses then as well, unless a token is set in `/proxy config`.

### API compatibility

The proxy implements a subset of the [OpenAI Chat Completions API](https://platform.openai.com/docs/api-reference/chat/create). Request and response shapes match the OpenAI specification for supported fields. Unsupported fields are rejected with `422` and an OpenAI-style error body naming the offending parameter.

Coming from Anthropic's own OpenAI-compatible endpoint? [docs/reference/claude-openai-compatibility.md](docs/reference/claude-openai-compatibility.md) compares it with the proxy field by field. In short, the proxy goes through pi to Claude's native API, so prompt caching and `reasoning_effort` work, a system message later in the conversation stays where the client put it on models whose compat allows it, pi's OAuth logins work, and unsupported fields are rejected instead of ignored.

Upstream failures before a response starts get an HTTP status, streamed or not, as OpenAI answers them: `400` `context_length_exceeded` when the conversation is longer than the model's context window (agent clients compact on it), `400` `upstream_invalid_request` when the provider refused a field the request sent (its 400 or 422, such as `top_p` on Claude 4.7 and later; a 400 about the provider credential, such as Google's bad API key, is `502` `upstream_auth_error` instead), `429` `rate_limit`, `502`, `503`, `504` `timeout`, each with a fixed message that never quotes the provider. A stream that already started ends with an error event carrying the same body. See [Error mapping](PLAN.md#error-mapping).

So a streaming response sends nothing, headers included, until the provider has accepted the request: as with OpenAI itself, the first byte takes the provider's own response time. A client or reverse proxy in front of the proxy needs a header timeout longer than that; the proxy's upstream timeout (`PI_SWITCHBOARD_UPSTREAM_TIMEOUT_MS`, 120 s) caps the wait.

The proxy describes its own API as an OpenAPI document (see [API documentation](#api-documentation)). For what each field means, the [OpenAI API reference](https://platform.openai.com/docs/api-reference/chat/create) is the primary documentation, noting the supported subset listed in this README.

## Pi Integration

Install as a pi package to get the `/proxy` command family. It needs the GitHub Packages setup in [Installation](#installation) first:

```bash
pi install npm:@vx-daniel/pi-switchboard
```

### Command family

```
/proxy               Open the settings panel
/proxy start         Start the proxy server
/proxy stop          Stop the proxy started by /proxy (session or detached); one started elsewhere is left running
/proxy restart       Stop, then start the proxy
/proxy status        Show proxy status
/proxy verify        Check the exposure config against pi's models
/proxy models        List the exposed models
/proxy zed-sync      Sync exposed models to Zed's settings.json (--dry-run to preview)
/proxy config        Open the settings panel
/proxy show          Summarize current configuration (the auth token as a short preview)
/proxy token         Show the whole proxy auth token, to copy into a client
/proxy path          Show config file location
/proxy reset         Restore default settings
/proxy help          Show usage
```

`/proxy token` prints the whole secret into the pi session, where it stays in the scrollback; `/proxy show` and the settings panel only ever show a short preview.

### Settings panel

`/proxy` (or `/proxy config`) opens an interactive settings panel where you can configure proxy auth, lifetime (detached or session), bind address, port, remote images, body size limit, upstream timeout, log level, model ID format, exposure mode, the `custom` model selection, and Zed sync. Changes are saved to `~/.pi/agent/proxy-config.json` immediately. Restart the proxy to apply changes.

### Standalone (background) mode

For a proxy that outlives pi sessions, run the binary directly:

```bash
# Foreground
pi-switchboard

# Background
pi-switchboard &

# With custom port
PI_SWITCHBOARD_PORT=8080 pi-switchboard &
```

The extension detects externally running instances and shows their status via `/proxy status` without trying to manage them.

## Docker

The image runs the proxy headless, with its own pi login in a volume. Each release publishes it for `linux/amd64` and `linux/arm64` as [`vxdaniel/pi-switchboard:<version>`](https://hub.docker.com/r/vxdaniel/pi-switchboard) on Docker Hub. The same image is also published as `ghcr.io/vx-daniel/pi-switchboard:<version>` on GHCR, which is not subject to Docker Hub's pull limit of 100 anonymous pulls per 6 hours per IP address. A published tag is never overwritten, and there is no `latest`, so a version always means the same image. The `Dockerfile` builds it from this repository's source, with one lockfile for the proxy and pi.

From a checkout, with [`compose.yaml`](compose.yaml):

```bash
export PI_SWITCHBOARD_AUTH_TOKEN="$(openssl rand -hex 32)"
docker compose build      # or: export PI_SWITCHBOARD_VERSION=<version> && docker compose pull

# Log in through pi, in the container; enter /login inside pi, then exit pi.
docker compose run --rm --no-deps --entrypoint pi proxy --no-session --no-tools --no-extensions --offline

docker compose up --wait
curl -H "Authorization: Bearer $PI_SWITCHBOARD_AUTH_TOKEN" http://127.0.0.1:4141/v1/models
```

- **The token is required.** The image listens on every interface inside the container, so it refuses to start without `PI_SWITCHBOARD_AUTH_TOKEN` and exits with status `64`. It takes the token from the environment only, not from `proxy-config.json`. The token is a local secret that protects the proxy, not a provider key. Compose publishes the port on `127.0.0.1` only (`PI_SWITCHBOARD_PUBLISH_PORT` changes it, default `4141`). The one exception is `--version` or `--help` alone, which starts no server: `docker run --rm vxdaniel/pi-switchboard:<version> --version` needs no token (from the first release after 0.1.0).
- **Logging in.** In pi, `/login` lists the providers. The container publishes no OAuth callback port, so when the browser redirects to a `localhost` URL that does not load, paste that whole URL, or the code, into pi. `fd` and `ripgrep` warnings are expected: pi is there to log in, not to run tools. Stop the proxy before logging in again.
- **The volume holds the login.** pi's login and its token refreshes live in the `pi-agent` volume at `/home/node/.pi/agent`, and survive `docker compose down` and `up` (`down -v` deletes them). Never seed the volume by copying a host `auth.json`: refreshing a login rotates its refresh token, and the other copy stops working.
- **Settings.** `proxy-config.json` in the volume works as on the host. Compose passes `PI_SWITCHBOARD_LOG_LEVEL`, `PI_SWITCHBOARD_LOG_FORMAT`, `PI_SWITCHBOARD_UPSTREAM_TIMEOUT_MS` and `TZ` to the container only when they are set, so the file's values apply otherwise.
- **Hardening, in `compose.yaml`:** the proxy runs as UID 1000, with a read-only root filesystem, `/tmp` as tmpfs, all capabilities dropped and `no-new-privileges`. The volume is the only place it writes.
- **Health.** The image's healthcheck asks `GET /healthz`, which needs no token, so the container is healthy before you log in. `GET /v1/models` with the token lists what the login can use.
- **A number-5 login volume** (`j5-pi-openai-proxy_pi-auth`) works unchanged: same UID, same mount path. To keep it, declare it in `compose.yaml` as an `external` volume under that name.

## Standalone binary

From the first release after this lands, each GitHub release carries the proxy as one executable for Linux and macOS (x64 and arm64): `pi-switchboard-linux-x64`, `pi-switchboard-linux-arm64`, `pi-switchboard-darwin-x64`, `pi-switchboard-darwin-arm64`, and a `SHA256SUMS` file. It needs no Node and no pi install: pi is compiled in. Windows is not built yet.

```bash
version=<version>   # e.g. 0.2.0
base="https://github.com/vx-daniel/pi-switchboard/releases/download/pi-switchboard-v$version"
curl -LO "$base/pi-switchboard-linux-x64" -LO "$base/SHA256SUMS"
sha256sum --check --ignore-missing SHA256SUMS   # macOS: shasum -a 256 --check --ignore-missing SHA256SUMS
gh attestation verify pi-switchboard-linux-x64 --repo vx-daniel/pi-switchboard   # optional: built by this repo's release workflow
chmod +x pi-switchboard-linux-x64
./pi-switchboard-linux-x64 --port 4141
```

Every binary is run (`--version`) on its own platform, Linux and macOS on x64 and arm64, before the release workflow uploads it, and each asset has a [build provenance attestation](https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations) that `gh attestation verify` checks.

- **macOS.** The binaries are not signed, so Gatekeeper blocks the first run. After checking the checksum, remove the quarantine flag: `xattr -d com.apple.quarantine pi-switchboard-darwin-arm64`.
- **Logins come from pi's `auth.json`.** The binary reads the same `~/.pi/agent` (or `PI_CODING_AGENT_DIR`) as the npm package, so log in with pi first. Logging in from the binary itself comes with its terminal console ([#61](https://github.com/vx-daniel/pi-switchboard/issues/61)).
- **Same options.** Flags, `PI_SWITCHBOARD_*` variables and `proxy-config.json` work as in [Configuration](#configuration). The binary never reads a `.env` or `bunfig.toml` from the directory it starts in.

## Architecture

```text
┌─────────────────────────────┐         ┌──────────────────────────────────┐
│       HTTP Client           │         │        pi-switchboard            │
│  (curl, Aider, Continue,    │         │                                  │
│   LiteLLM, Open WebUI, etc.)│         │  ┌────────────────────────────┐  │
└─────────────┬───────────────┘         │  │     Hono HTTP Server       │  │
              │                         │  │  ├─ Request parser         │  │
              │  POST /v1/chat/         │  │  ├─ Message converter      │  │
              │  completions            │  │  ├─ Model resolver         │  │
              ├────────────────────────►│  │  ├─ Tool converter         │  │
              │                         │  │  └─ SSE encoder            │  │
              │  GET /v1/models         │  └────────────────────────────┘  │
              ├────────────────────────►│                                  │
              │                         │  ┌────────────────────────────┐  │
              │                         │  │        Pi SDK              │  │
              │  SSE / JSON             │  │  ├─ ModelRuntime           │  │
              │◄────────────────────────┤  │  ├─ SettingsManager        │  │
              │                         │  │  └─ streamSimple()         │  │
                                        │  └────────────────────────────┘  │
                                        └──────────────────────────────────┘
```

### Pi SDK layers used

- **`@earendil-works/pi-ai`** — the types `Model`, `Usage`, `AssistantMessageEvent`, `JsonObject`
- **`@earendil-works/pi-coding-agent`** — `ModelRuntime` (credentials, catalog and request auth; completions run through its `streamSimple()`, non-streaming ones read the stream's final message) and `SettingsManager`

Requires Pi 1.x (`^1.3.0`). Pi 1.0 is the first release whose Anthropic client identifies as Claude Code 2.1.280, which Anthropic requires for Opus 5.5 and Fable 5.1; Pi 0.x identified as 2.1.75 and those models were refused.

## Security defaults

- Binds to `127.0.0.1` (localhost only) by default
- Remote image URLs rejected unless the remote-images setting is on. When it is on, each fetch:
  - uses `http` or `https` only;
  - refuses a host when any address it resolves to is loopback, private, link-local (including the cloud metadata address `169.254.169.254`), carrier-grade NAT, unspecified, multicast or reserved, IPv4-mapped IPv6 forms included, and connects only to the address it checked (no DNS rebinding);
  - follows at most 3 redirects, checking each target the same way;
  - gives up after 5 seconds connecting or 10 seconds in all;
  - stops reading past 15 MiB (the base64 data URI limit);
  - accepts only an `image/png`, `image/jpeg`, `image/gif` or `image/webp` response;
  - sends a plain GET: no client header, cookie or credential;
  - and a request may carry at most 8 remote images, of 15 MiB in all.

  Images are fetched only after the provider credential is checked, so a request that would get `401` fetches nothing.

  A refused image fails the request with `400` at that part's `param`, with a fixed message that never quotes the remote server.
- Request body size limited to 50 MB by default
- Upstream calls aborted after 120 seconds without any data from the provider
- Secrets are never included in error responses
- Client disconnects abort upstream work immediately

## Dev Workflow

The toolchain is [Vite+](https://viteplus.dev) (`vp`); all config lives in `vite.config.ts`.

```bash
vp install            # Install dependencies (pnpm); also installs the Git hooks
vp run dev            # Rebuild on change and restart the proxy on port 4142 (PI_SWITCHBOARD_DEV_PORT to change)
pnpm run check:all    # The gate: format, lint + type check, tests with coverage, fallow, build
vp check --fix        # Format and apply lint fixes
vp test               # Offline tests (unit + integration): no real login, no network beyond 127.0.0.1
pnpm run test:live    # Live conformance tests against real providers: uses your pi login and quota
pnpm run test:live:record  # Re-record the Anthropic replay fixtures (needs a login made for recording)
pnpm run openai-spec:update <commit>  # Re-pin OpenAI's OpenAPI spec subset to a full commit SHA
vp pack               # Build for npm (ESM + .d.ts)
pnpm run build:binary # Standalone binary for this machine (dist-bin/pi-switchboard); needs Bun
pnpm run test:binary  # Build it, then run it against the fixtures (test/binary); needs Bun, not in the gate
```

`check:all` (`scripts/gate.ts`) is the one definition of "green": the pre-commit hook, CI, and the release workflow all run it.

Offline tests run with pi pointed at an empty agent directory and credential env vars removed (`test/setup/offline.ts`). Tests that need models or an upstream build them with `test/fixtures/agent-dir.ts` and the local mock provider in `test/fixtures/mock-provider.ts`, which serves scripted replies or replays real provider traffic recorded by `test:live:record` (`test/fixtures/recording.ts`, `test/fixtures/recordings/`). Recording forwards pi's real requests to the provider through a local recorder and saves the responses without credentials; it refuses to save one that contains a credential. Set `PI_SWITCHBOARD_RECORD_AGENT_DIR` to a pi agent directory with a login made for recording: never a copy of a login another pi or proxy uses, because refreshing an expired token rotates it under every copy. Recordings go to `test/fixtures/recordings/` unless `PI_SWITCHBOARD_RECORD_OUT_DIR` names another directory (a relative path is taken from the working directory).

`test/integration/openai-spec.test.ts` checks the stable surface against OpenAI's published OpenAPI spec, pinned to one commit of [`openai/openai-openapi`](https://github.com/openai/openai-openapi) in `test/fixtures/openai-spec/openapi-subset.json`. Every response body, stream chunk and error body has to validate against OpenAI's schema for it. Every request field and enum value the proxy accepts has to exist in OpenAI's request, and every one OpenAI has that the proxy doesn't accept is listed in the test with the reason. To move the pin, run `openai-spec:update` with the new commit. If OpenAI added a field or value, the test fails until you accept it or list it.

### Tooling

- **Vite+** — one toolchain: Oxfmt (format), Oxlint with tsgolint (type-aware lint and type check), Vitest (tests, with v8 coverage in the gate), tsdown (`vp pack`), and Git hooks (`.vite-hooks/`)
- **fallow** — dead code, duplication and complexity from the module graph (`.fallowrc.jsonc`); the gate fails on any finding
- **pnpm** — package manager, driven by `vp`
- **Node.js** — runtime (`@hono/node-server`)
- **commitlint** — conventional commits (`commit-msg` hook)
- **GitHub Actions** — `ci.yml` (the gate on pull requests into `dev`/`main` and pushes to `dev`, plus the `binary` job, which builds and tests the standalone binary with Bun), `secret-scan.yml` (gitleaks on every pushed commit), `claude-pr-review.yml` (manual Claude review), `publish.yml` (release on `main`, then the image, package and binaries)
- **Bun** — build-only: compiles the standalone binary (`scripts/build-binary.ts`, `src/standalone/main.ts`); nothing else runs on it
- **semantic-release** — automated versioning, GitHub releases and the changelog (npm publishing comes with [#59](https://github.com/vx-daniel/pi-switchboard/issues/59))

## Attribution

pi-switchboard started as [`pi-openai-proxy`](https://github.com/victor-software-house/pi-openai-proxy) by **Victor Araújo** (Victor Software House), published on npm as `@victor-software-house/pi-openai-proxy` (last release 4.9.5). This project forked it at `2fec663` (v4.9.6, 2026-06-08). The 110 commits up to that point are his and stay in this repository's history.

Model exposure, public IDs and strict request validation come from the original. Since the fork, the project has:
- moved to pi 1.x and its `ModelRuntime`;
- added health checks, opt-in remote images and checks against OpenAI's published spec;
- added the OpenAPI document and docs page;
- moved to the Vite+ toolchain.

Next is the multi-login routing it is now named for (#66–#70).

Versions restart at 0.1.0 under the new name. The original's `v4.x` tags remain in the history.

## License

MIT. The original copyright, Victor Araújo's, is kept in [`LICENSE`](LICENSE), alongside this project's.
