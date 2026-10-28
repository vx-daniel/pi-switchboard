# The HTTP API

## Examples

### List available models

```bash
curl http://localhost:4141/v1/models | jq '.data[].id'
```

### Chat completion (non-streaming)

```bash
curl http://localhost:4141/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "anthropic/claude-sonnet-5-5",
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
OPENAI_API_BASE=http://localhost:4141/v1 aider --model anthropic/claude-sonnet-5-5

# Example: Continue (in settings.json)
# "apiBase": "http://localhost:4141/v1"

# Example: Open WebUI
# Set "OpenAI API Base URL" to http://localhost:4141/v1
```

## Supported Endpoints

The stable routes are the first three rows. [`PLAN.md`](../PLAN.md) "Stable surface" is the authoritative list, and says what a route must meet to join it.

| Endpoint | Description |
|---|---|
| `GET /v1/models` | List exposed models (filtered by exposure mode, only those with configured credentials) |
| `GET /v1/models/{model}` | Model details by public ID or canonical ID (supports URL-encoded IDs with `/`) |
| `POST /v1/chat/completions` | Chat completions (streaming and non-streaming) |
| `POST /v1/responses` | Off by default, experimental: OpenAI's Responses API, stateless ([below](#responses-api-experimental)) |
| `GET /v1/switchboard/models` | Not OpenAI's: each exposed model's pi capabilities, such as its supported `reasoning_effort` values ([below](#discovering-available-models)) |
| `GET /v1/switchboard/usage` | Not OpenAI's: usage over today, the last week or 30 days, per model and per alias, from the stats file ([below](#usage-over-http)) |
| `DELETE /v1/switchboard/cooldowns` | Not OpenAI's: ends cooldowns early, all of them or one login's or model's ([Cooldowns](routing.md#cooldowns)) |
| `GET /v1/switchboard/openapi.json` | Not OpenAI's: this API as an OpenAPI 3.1 document ([below](#api-documentation)) |
| `GET /docs` | Off by default: Swagger UI for the document, to read the API and try requests ([below](#api-documentation)) |

### API documentation

`GET /v1/switchboard/openapi.json` describes every route the proxy serves as an OpenAPI 3.1 document, committed as [`openapi.json`](../openapi.json). Turn on `docsUi` (`--docs-ui`, `PI_SWITCHBOARD_DOCS_UI=true`) and `http://localhost:4141/docs` serves it as a Swagger UI page where you can send requests. Neither route needs the proxy token. What the document holds, using it in other tools, and the docs page in full: [API reference](api-reference.md).

### Usage over HTTP

`GET /v1/switchboard/usage` (not part of OpenAI's API; proxy token, if set) answers what the console's Stats view shows, for a proxy run without the console, such as the Docker image. It reads the [stats file](configuration.md#configuration), so it covers every proxy that writes to the same agent dir and survives restarts. Like the file, which the proxy writes every 5 seconds, an answer can be up to 5 seconds old: one window's answer is reused that long, so polling it costs one read.

```bash
curl -s "http://localhost:4141/v1/switchboard/usage?window=week" -H "Authorization: Bearer $PI_SWITCHBOARD_AUTH_TOKEN" | jq '.aliases'
```

- **`window`:** `today` (from midnight, the proxy's local time; the default), `week` (the last 7 days) or `all` (the 30 days the file keeps). Anything else is a `400`.
- **`models` and `aliases`:** per served model and per alias, busiest first: `requests`, `failed`, `left` (the client went away), `average_ms`, `slowest_ms`, `average_first_event_ms`, `attempts`, `fallbacks`, `input_tokens` (the uncached input only), `output_tokens`, `cache_read_tokens` and `cache_write_tokens` (the prompt is `input_tokens` plus both; the cache hit rate is `cache_read_tokens` over that sum, see [Prompt caching](caching.md#reading-the-numbers)) and `cost_usd`. An alias counts every model its fallback chain tried; `alias: null` is the requests that named a model directly. Before #297 the reads and writes came added together as `cache_tokens`, which is gone.
- **`failures` and `rejected`:** failed attempts by failure class, and rejected requests by HTTP status.
- **`timeline`:** requests per hour (`today`), per 6 hours (`week`) or per day (`all`), with failed and rejected ones; `bucket_minutes` says which.
- **Stats off** (`--no-stats`), or a file that can't be read, answers `503` with code `stats_unavailable`, not empty numbers.

Routes, counts, timings, tokens and cost only: never message content, a request's `user`, or a credential.

### Health checks

Operational endpoints, outside the OpenAI-compatible `/v1` surface:

| Endpoint | Auth | Answers |
|---|---|---|
| `GET /healthz` | Never | `200 {"status":"ok"}` once the proxy listens and pi's model runtime is loaded. No upstream calls: use it for container healthchecks and liveness probes. |
| `GET /healthz/models` | Proxy token, if set | Available and exposed model counts, exposure modes, why the exposure config is invalid (`exposureError`), a `models.json` load error (`modelsJsonError`; a parse error says only where the file is not valid JSON, never what it says there; the standalone binary's parser gives no location, so there it says why, e.g. `Expected '}'`, when the parser's reason quotes nothing from the file), unresolved `enabledModels` patterns (`scopeDiagnostics`), aliases left out (`aliasDiagnostics`), what each family alias resolves to (`familyAliases`, [Family aliases](routing.md#family-aliases-follow-the-newest-model)), `routing.logins` names that are no login and providers whose every login is disabled (`loginDiagnostics`, [Order and disabled logins](logins.md#order-and-disabled-logins)), and active cooldowns (`cooldowns`, [Cooldowns](routing.md#cooldowns)). `503` when no model is exposed, the exposure config is invalid, or an alias is misconfigured: named like an exposed model (`shadows-model`), set to an effort its model doesn't support (`effort-unsupported`), following a family no rule knows (`family-unknown`), or pinned outside its family (`pin-outside-family`). A cooldown, a login diagnostic, `target-not-exposed` or `family-unparsed` does not fail it. |
| `GET /healthz/creds` | Proxy token, if set | Per provider with a credential: `type` (`oauth` or `api_key`), `source` (`stored`, `environment`, `models_json_key`, …), `availableModelCount`, and `quota`, the subscription's latest usage windows ([Quota](routing.md#quota); here in camelCase, `observedAt`, `resetsAt` and `windowMinutes`, with ISO 8601 times). `503` when no provider has one. `loginsRegistered` is `false`, with `loginsError` (an error code or name, never a message), when pi's credential store could not be listed at startup: the `{provider}-N` [logins](logins.md) were then not registered, and stay unregistered until the proxy restarts. It does not change `status`. Reads local state only; `?verify=true` also has pi resolve each credential now and adds `verified` and `error` per provider, `503` if any fails. |

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
| `messages` (remote images) | Only with the remote-images setting on (off by default): the proxy downloads each `http`/`https` image URL and sends it to the provider as base64. Public hosts only, at most 8 per request and 15 MiB in all, 10 seconds each, 3 redirects; see [Security defaults](security.md#security-defaults). Off, a remote URL is rejected with `400` |
| `stream` | SSE with `text_delta` and `toolcall_delta` mapping |
| `temperature` | Passed through, with two exceptions, each logged (the first per model at `info`, later ones at `debug`): Codex models (`openai-codex-responses`), where the backend rejects it, so the proxy drops it; and Claude models pi marks as not accepting it (Claude 4.7 and later, which refuse a temperature below 1) or any Claude request with thinking on, where pi leaves it out itself |
| `max_completion_tokens` | Preferred; `max_tokens` accepted as deprecated fallback |
| `stop` | Via passthrough |
| `user` | Via passthrough |
| `stream_options.include_usage` | Final usage chunk in SSE stream |
| `tools` / `tool_choice` | Tool parameter schemas: JSON Schema subset with per-type constraints carried upstream; other keywords get `422` naming keyword and path (see [Tool schema policy](../PLAN.md#tool-schema-policy)). `tool_choice` translated per-provider |
| `strict` on function tools | Applied where pi marks the model strict-capable, in each API's own shape (OpenAI, Responses, Anthropic, …). Strict rewrites the schema: every property becomes required and optional ones nullable, so the model may send `null` for a field it would otherwise omit. Elsewhere, or when the schema is outside the provider's strict subset, the tool is sent without strict, with no error (see [PLAN.md](../PLAN.md#strict-on-function-tools--strict-where-supported-44)) |
| `tool_calls` in messages | Assistant tool call + tool result roundtrip |
| `parallel_tool_calls` | Forwarded to OpenAI/Codex; translated to `disable_parallel_tool_use` for Anthropic |
| `reasoning_effort` | Maps to pi's thinking level of the same name (`none` through `max`). `none` turns reasoning off (Anthropic `thinking: disabled`, OpenAI `effort: none`). An effort the model does not support is clamped with pi's `clampThinkingLevel`: the nearest supported level above it, else the nearest below. So `none` on a model whose reasoning cannot be turned off is its lowest level (not the provider's default), `xhigh` on a model with `max` but no `xhigh` is `max`, `max` on a model without it is its highest level, and any effort on a model without reasoning is off. The response reports it as `x_pi.reasoning_effort: { "requested": "max", "applied": "xhigh" }`, in the body and in every stream chunk, whenever the request set `reasoning_effort` (the two are equal when nothing was clamped; after an alias's fallback, `applied` is for the model that answered). `applied` is the level the proxy asks pi for; pi's adapter may still translate it for the provider. The first clamp per model is logged at `info`, later ones at `debug`. `GET /v1/switchboard/models` lists the efforts each model supports. For a custom `models.json` model with `reasoning: true`, `none` sends whatever its `thinkingLevelMap.off` says: nothing if unset, so set `off: "none"` (or `off: null` if reasoning cannot be turned off) when the endpoint reasons by default |
| `response_format` | `text`, `json_object`, and `json_schema` (OpenAI-compatible APIs only) |
| `top_p` | Supported by OpenAI, Anthropic (native), and Google (translated to `topP`) |
| `frequency_penalty` | OpenAI and Google only (translated to `frequencyPenalty`) |
| `presence_penalty` | OpenAI and Google only (translated to `presencePenalty`) |
| `seed` | OpenAI and Google only (translated to `seed` in Google's generation config) |
| `stop` | Translated per-provider (`stop_sequences` for Anthropic, `stopSequences` for Google) |
| `metadata` | OpenAI passthrough; arbitrary keys silently skipped for other providers |
| `prediction` | OpenAI passthrough only (speculative decoding) |
| `prompt_cache_key` | Becomes pi's session ID, which pi sends where the provider takes one: OpenAI Responses and Codex as `prompt_cache_key`, chat completions to `api.openai.com` as `prompt_cache_key`, Mistral as its `prompt_cache_key` and an `x-affinity` header, and an affinity header for Anthropic-API gateways that ask for one (OpenRouter; never a direct Anthropic OAuth login, where caching needs no key). Elsewhere it changes nothing. Surrounding spaces are trimmed (so `" a "` and `"a"` are one key), then it must be 1–64 characters; `null` is the same as none. Send one stable key per conversation |
| `prompt_cache_breakpoint` on content parts | Accepted on text and image parts. Sent on to OpenAI's own API (chat completions and Responses at `api.openai.com`), where it marks the end of a reusable prompt prefix; dropped for every other provider (Codex sends the system prompt as a plain string, and other servers may refuse a field they don't know), and logged at `debug`. A model on `api.openai.com` that refuses it with a `400` (the ChatGPT-subscription models such as `gpt-6-luna`) gets the request once more without it, and from then on it is left out for that model until the proxy restarts, logged once at `info`. It only affects caching |
| `store` | `false` or `null` only: the proxy stores no completion, so "don't store" is answered as asked, and the field is never sent upstream. `store: true` is refused with `422`. pi's own OpenAI chat adapter sends `store: false` to the proxy on every request; proxies before 0.5.0 refuse it, and there pi needs `"compat": { "supportsStore": false }` on the provider in its `models.json` |
| `n` | `1` or `null` only: the proxy returns one choice, so OpenAI's default is answered as asked, and the field is never sent upstream. Any other value is refused with `422` (`param: n`). Some clients send `n: 1` on every request (Elixir's LangChain, for one); proxies before 0.5.0 refuse it |

**Not supported:** `logprobs`, `top_logprobs`, `logit_bias`, and the deprecated `functions` / `function_call`, each rejected with `422`; `prompt_cache_retention` (deprecated by OpenAI) and `prompt_cache_options` (no pi equivalent), rejected as unknown with `422`; a value in an assistant message's `refusal`, `audio`, deprecated `function_call` or `annotations`, rejected with `422`; `name` on a `tool` message (OpenAI defines none there; the call a result answers names the tool), rejected as unknown with `422`; remote image URLs while the remote-images setting is off, rejected with `400`.

### Responses API (experimental)

`POST /v1/responses` answers OpenAI's Responses API, which newer clients use (the Agents SDK, `client.responses.create()`), for any exposed model. It is off until you turn on `responsesApi` (`--responses-api`, `PI_SWITCHBOARD_RESPONSES_API=true`); while off it answers 404 and says how. It is experimental: outside the [stable surface](../PLAN.md#stable-surface) until it has had real use.

It is **stateless**: nothing is stored, so a conversation is sent whole each time, as with chat completions. The request is translated into a chat request and runs exactly as one does: model resolution and aliases, fallback, logins, `X-Switchboard-Upstream-Api-Key`, the timeout, disconnects and errors are the same. Only the answer differs, a `response` object or `response.*` events.

- **Input:** a string, or items: `message` (`user` with `input_text` and `input_image` parts, `system`, `developer`, and `assistant` with the `output_text` of an earlier response), `function_call`, `function_call_output` and `reasoning`. `instructions` becomes the system message.
- **Settings:** function `tools`, `tool_choice`, `parallel_tool_calls`, `temperature`, `top_p`, `max_output_tokens`, `reasoning.effort` (clamped and reported in `x_pi.reasoning_effort` as on chat), `reasoning.summary` as `auto`, `text.format` (`text`, `json_object`, `json_schema`), `metadata`, `user`, `prompt_cache_key`, `stream`.
- **Output:** `message`, `function_call` (its `call_id` is what you send back in `function_call_output`) and `reasoning` items in the order the model produced them, with `usage` and `x_pi` as on chat. A length stop is `status: "incomplete"`. Streamed: `response.created`, `response.in_progress`, each item's `added`, deltas and `done` events, then `response.completed`, `response.incomplete` or `response.failed`. A redacted thinking block (Claude's `redacted_thinking`, Bedrock's encrypted reasoning) is a `reasoning` item with an empty `summary`, streamed and not: the stream sends no summary deltas for it and an empty summary text.
- **Reasoning across turns:** with `include: ["reasoning.encrypted_content"]`, each `reasoning` item carries a token; send the items back in `input` and the model gets its reasoning back, the stateless loop Codex CLI runs. The token is base64url JSON, not encrypted by the proxy: anyone holding it can read the thinking text in it, in the clear, so treat it as you treat the response text, not as an opaque or safe-to-log blob. For OpenAI and Codex models it also carries OpenAI's own encrypted reasoning; for others (Claude) it carries pi's thinking block and its signature. A token is replayed only to the model that produced it, and one the proxy didn't write is refused with a 400. A `reasoning` item without a token is refused with a 400 that says to ask for `include`, as OpenAI refuses an echoed reasoning item it hasn't stored; so is reasoning that no message or function call follows.
- **Refused by name (422):** state the proxy doesn't keep (`previous_response_id`, `conversation`, `background`, `prompt`, `store: true`; `store: false` is accepted), tools other than functions (web search, file search, code interpreter, …), any `include` but reasoning, and `top_logprobs`, `service_tier`, `truncation`, `max_tool_calls`, `context_management`, `moderation`, `access_programs`, `safety_identifier`, `prompt_cache_retention`, `prompt_cache_options`; `text.verbosity`, `reasoning.summary` other than `auto`, and `stream_options.include_obfuscation: true` are refused as unknown or invalid values. `detail` on an `input_image` is accepted and dropped, as `image_url.detail` is on chat.
- **The other Responses operations** (`GET`/`DELETE /v1/responses/{id}`, `cancel`, `input_items`, `input_tokens`, `compact`) need stored responses, and answer 404 "not supported".

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
| `universal` | Raw model IDs only; rejects config if duplicates exist | `gpt-4o`, `claude-sonnet-5-5` |
| `always-prefixed` | Always `<prefix>/<model-id>` | `openai/gpt-4o`, `anthropic/claude-sonnet-5-5` |

The `collision-prefixed` mode prefixes **all** models from providers that form a connected conflict group (not just the colliding model names).

### Exposure modes

Control which models appear in the API:

| Mode | Behavior |
|---|---|
| `all` | Expose every model with configured credentials |
| `scoped` (default) | Expose the models pi's global `enabledModels` setting selects (`/scoped-models` in pi, or `settings.json`), resolved as pi resolves them: exact `provider/id`, bare IDs, globs such as `anthropic/*` or `*sonnet*`, and `:level` suffixes. As in pi, a bare word also matches by substring of a model's ID or name (`opus` selects an Opus model), and a pattern several providers match exposes all of them (listed as `ambiguous`): write `provider/id` to pick one. With no `enabledModels`, every model with credentials, as `all`. Patterns that match nothing are listed in `/healthz/models`. pi's `--models` flag is per session, so it does not apply |
| `custom` | Expose an explicit allowlist of canonical IDs (`customModels`), matched exactly |

pi can list a model the login's plan cannot run: with a ChatGPT login, Codex refused `gpt-5.5` and `gpt-5.3-codex-spark`, which pi 1.4.0 dropped from its catalog for that reason. Such a model answers `404` `model_not_found` ("not available with the provider login the proxy uses"), and the proxy logs the refusal as an error. To stop exposing it, select the models you can use in pi's `enabledModels` (`scoped`), or list them in `customModels` (`custom`).

### Canonical model IDs

Internal canonical IDs use the `provider/model-id` format matching pi's registry:

```
anthropic/claude-sonnet-5-5
openai/gpt-4o
google/gemini-2.5-pro
xai/grok-4.7
openrouter/anthropic/claude-sonnet-5.5
```

Canonical IDs are accepted as backward-compatible fallback in requests, but only for models that are currently exposed. Hidden models cannot be reached by canonical ID.

### Model resolution

The proxy resolves model references in this order:

1. **Exact public ID match** — the ID from `GET /v1/models`
2. **Canonical ID fallback** — `provider/model-id` format (only for exposed models)
3. **Alias** — a name from `aliases` in the config file ([Aliases](routing.md#aliases)), or a built-in `-latest` alias such as `opus-latest` ([Family aliases](routing.md#family-aliases-follow-the-newest-model))

With the default `collision-prefixed` mode and no collisions, model IDs are exposed without prefixes:

```bash
curl http://localhost:4141/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-4o", "messages": [{"role": "user", "content": "Hi"}]}'
```

### Discovering available models

List all models the proxy exposes (filtered by the active exposure mode):

```bash
curl http://localhost:4141/v1/models | jq '.data[].id'
```

Model objects follow the standard OpenAI shape (`id`, `object`, `created`, `owned_by`) with no proprietary extensions. `created` is the Unix time the proxy started, the same for every model, because pi's catalogue has no release dates and OpenAI requires the field. Don't read it as a model's age; choose models by what `GET /v1/switchboard/models` reports.

`GET /v1/switchboard/models` (not part of OpenAI's API; proxy token, if set) lists what pi knows about each exposed model and alias beyond that: its pi catalogue entry, with any `models.json` values. An alias shows its target's entry.

| Field | Meaning |
|---|---|
| `provider` | pi's provider (`owned_by` on `/v1/models`) |
| `reasoning` | Whether the model reasons |
| `reasoning_efforts` | The `reasoning_effort` values the model runs at as asked, lowest first (`["none"]` for a model without reasoning). Any other value is accepted and clamped |
| `reasoning_effort_fixed` | `true` for an alias whose first target sets its effort ([Reasoning effort per alias](routing.md#reasoning-effort-per-alias)): `reasoning_efforts` is then just that effort, and a request's `reasoning_effort` is replaced by it. `false` otherwise |
| `input` | What it accepts: `text`, `image` |
| `context_window`, `max_output_tokens` | In tokens |
| `cost` | USD per million tokens: `input` (uncached), `output`, `cache_read`, `cache_write`; `0` where pi has no price |
| `cooldown` | `null`, or the cooldown its first login is under after a 429, 503 or 529: `reason`, `scope` (`provider` or `model`), `until` (Unix seconds) ([Cooldowns](routing.md#cooldowns)) |
| `quota` | `null`, or its first login's latest usage windows ([Quota](routing.md#quota)) |
| `availability` | `refused` after the proxy's login refused the model (answered as `404 model_not_found`), `verified` after a whole answer, `unknown` before either. Kept in memory since the proxy started; the latest result wins, and a request with its own upstream key does not count. The first refusal of a model is logged at `info` |
| `logins` | The logins that may serve it ([Several logins per provider](logins.md#several-logins-per-provider)), in the order routing tries them, then the disabled ones, which it never calls: each with its `id` (`anthropic`, `anthropic-2`), `disabled`, and its own `cooldown` and `quota` |

```json
{ "object": "list", "data": [{ "id": "claude-sonnet-4-5", "provider": "anthropic", "reasoning": true,
  "reasoning_efforts": ["none", "minimal", "low", "medium", "high"], "reasoning_effort_fixed": false,
  "input": ["text", "image"], "context_window": 200000, "max_output_tokens": 64000,
  "cost": { "input": 3, "output": 15, "cache_read": 0.3, "cache_write": 3.75 }, "cooldown": null,
  "quota": null, "availability": "unknown",
  "logins": [{ "id": "anthropic", "disabled": false, "cooldown": null, "quota": null }] }] }
```

docker-agent prices a model reached through a custom `base_url` only from a `cost` table in `team.yaml`, so a team can take these prices; without one it records usage but no cost. The path was `GET /v1/pi/models` before 0.1.0; the old path is gone.

## Per-request API key override

The `X-Switchboard-Upstream-Api-Key` header overrides the registry-resolved API key for a single request. This keeps `Authorization` available for proxy authentication:

```bash
curl http://localhost:4141/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Switchboard-Upstream-Api-Key: sk-your-key-here" \
  -d '{"model": "openai/gpt-4o", "messages": [{"role": "user", "content": "Hi"}]}'
```

If the provider rejects that key, the proxy answers `401` `authentication_error` with code `upstream_api_key_invalid` and a fixed message naming the header: the key is yours to fix. A rejected stored pi login stays `502` `upstream_auth_error`, as the client did nothing wrong.

An empty header (`X-Switchboard-Upstream-Api-Key:` with no value, or only spaces) is refused with `400` before anything is called: leave the header out to use pi's stored login.

## API compatibility

The proxy implements a subset of the [OpenAI Chat Completions API](https://platform.openai.com/docs/api-reference/chat/create). Request and response shapes match the OpenAI specification for supported fields. Unsupported fields are rejected with `422` and an OpenAI-style error body naming the offending parameter.

Coming from Anthropic's own OpenAI-compatible endpoint? [docs/reference/claude-openai-compatibility.md](reference/claude-openai-compatibility.md) compares it with the proxy field by field. In short, the proxy goes through pi to Claude's native API, so prompt caching and `reasoning_effort` work, a system message later in the conversation stays where the client put it on models whose compat allows it, pi's OAuth logins work, and unsupported fields are rejected instead of ignored.

Upstream failures before a response starts get an HTTP status, streamed or not, as OpenAI answers them: `400` `context_length_exceeded` when the conversation is longer than the model's context window (agent clients compact on it), `400` `upstream_invalid_request` when the provider refused a field the request sent (its 400 or 422, such as `top_p` on Claude 4.7 and later; a 400 about the provider credential, such as Google's bad API key, is `502` `upstream_auth_error` instead), `404` `model_not_found` when the login can't run the model ([Exposure modes](#exposure-modes)), `429` `rate_limit` or `insufficient_quota` (below), `502` (`upstream_error` for any other failure), `503` (`provider_unavailable`, or `provider_overloaded` for a 529), `504` `timeout`, each with a fixed message that never quotes the provider. A stream that already started ends with an error event carrying the same body. See [Error mapping](../PLAN.md#error-mapping).

A `429` says whether retrying soon helps (#199). A short rate limit is `rate_limit`, with `retry-after` (seconds) and `retry-after-ms` when the provider said how long to wait, so a client waits that long rather than guessing. A plan's usage limit (a Codex or Claude subscription's 5-hour or weekly cap: the provider's "usage limit" wording, or a wait of 5 minutes or more) is OpenAI's `insufficient_quota` type and code, with `x-should-retry: false`: the OpenAI SDKs then don't retry, and Codex CLI stops. It carries no `retry-after`, so a client that honors one doesn't sit out a weekly window. Either way the proxy's own [fallback and cooldowns](routing.md#cooldowns) treat it as `rate_limit`. In a stream that already started, the error event carries the code but no headers, and only the "usage limit" wording makes it `insufficient_quota`: the wait comes from the response that refused the call. Clients that matched `rate_limit` for a Codex usage limit see `insufficient_quota` from 0.5.0 on.

So a streaming response sends nothing, headers included, until the provider has accepted the request: as with OpenAI itself, the first byte takes the provider's own response time. A client or reverse proxy in front of the proxy needs a header timeout longer than that; the proxy's upstream timeout (`PI_SWITCHBOARD_UPSTREAM_TIMEOUT_MS`, 120 s) caps the wait.

Credential answers (#128):

| Situation | Answer |
|---|---|
| The proxy token is missing or wrong | `401` `authentication_error`, no code |
| The provider rejected the key sent in `X-Switchboard-Upstream-Api-Key` | `401` `authentication_error`, code `upstream_api_key_invalid` |
| The provider rejected pi's stored login | `502` `server_error`, code `upstream_auth_error` |
| pi has no usable credential for the model's provider, and no key was sent | `502` `server_error`, code `upstream_credentials_missing`: log in with pi on the proxy's host |

So a client that asks its user for a new key on `401` only does so when the key was its own. The last row is answered before any call, and an alias whose `fallbackOn` names `auth` moves past it.

The proxy describes its own API as an OpenAPI document (see [API documentation](#api-documentation)). For what each field means, the [OpenAI API reference](https://platform.openai.com/docs/api-reference/chat/create) is the primary documentation, noting the supported subset listed on this page.
