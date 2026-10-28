# Upgrading

## From 0.5 to the next release (unreleased)

### API changes

- **An error's `param` names a nested field as OpenAI does (#342):** an array index in brackets, `messages[0].content[1].type`, where some errors said `messages.0.content.1.type`. On `POST /v1/chat/completions` that is every `400` or `422` from request validation at a path through an array, such as inside `messages` or `tools` (a field OpenAI doesn't define, an assistant field accepted only empty, a wrong type or value, a role the proxy doesn't take, a malformed `prompt_cache_breakpoint`); message conversion, tool schema and remote-image errors already used brackets. On `POST /v1/responses` it is the same validation errors inside `input` and `tools`, the named `422` for a non-function tool (`tools[0].type`) or another `include` (`include[0]`), and the `400` for a reasoning item (`input[1].encrypted_content`, `input[1]`). A validation message that quotes the path (`Invalid value for '…'`, `Unknown parameter(s): …`) uses the same form. Top-level fields (`param: n`) are unchanged. A client that matched the dotted form should match the bracketed one.

## From 0.4 to 0.5

Nothing to change in `proxy-config.json`: every 0.4 file works unchanged. These are the changes a client or an operator may notice.

### Upgrade every pi-switchboard that shares an agent directory

The stats file, `pi-switchboard-stats.sqlite`, is now schema version 2: it also counts the requests that sent a `prompt_cache_key` (a count, never the key), for `pi-switchboard doctor` (#299). The first 0.5 proxy to start migrates a version 1 file in place and keeps its rows. A 0.4 proxy can't open a version 2 file: it logs `Stats are off: could not open …` with `newer than this proxy's`, and runs without stats.

So when two installs share one agent directory, such as the pi package and a standalone binary both reading `~/.pi/agent`, upgrade both. Logins and `proxy-config.json` are not affected.

### API changes

- **A plan's usage limit is `insufficient_quota`, not `rate_limit` (#199).** A Codex or Claude subscription's 5-hour or weekly cap (the provider's "usage limit" wording, or a wait of 5 minutes or more) now answers `429` with OpenAI's `insufficient_quota` type and code and the header `x-should-retry: false`, and no `retry-after`. The OpenAI SDKs then stop retrying, and Codex CLI stops. A client that matched `rate_limit` for this case should match `insufficient_quota` as well. Routing is unchanged: fallback and cooldowns treat both as `rate_limit` ([API compatibility](api.md#api-compatibility)).
- **A rate limit says how long to wait.** A `429` `rate_limit` now carries `retry-after` (seconds) and `retry-after-ms` when the provider said when to retry.
- **`n: 1` and `store: false` are accepted on chat completions (#197).** Both ask for what the proxy does anyway (one choice; nothing stored), so `1` or `null` for `n` and `false` or `null` for `store` are accepted and never sent upstream. Any other `n` and `store: true` are still a `422` naming the field. pi's `openai-completions` adapter sends `store: false` to a host it doesn't know, so pi can now use the proxy as an OpenAI-compatible provider.
- **`GET /v1/switchboard/usage` splits the cache tokens (#297).** `cache_tokens` (reads and writes together) is gone; each model and alias has `cache_read_tokens` and `cache_write_tokens` instead. `input_tokens` is unchanged, the uncached input: the whole prompt is the three together ([Usage over HTTP](api.md#usage-over-http)).
- **An empty `X-Switchboard-Upstream-Api-Key` is a `400` (#207)** on `/v1/chat/completions` and `/v1/responses`, before any call. It used to be sent as the provider key and fail upstream with a `502`.
- **Built-in `-latest` aliases (#231).** `GET /v1/models` lists `opus-latest`, `sonnet-latest`, `sol-latest` and the like for every family your exposed models belong to, after your own aliases. An alias of yours with the same name replaces the built-in one ([Family aliases](routing.md#family-aliases-follow-the-newest-model)).
- **Tool and `json_schema` descriptions keep their whitespace (#255).** They are text the model reads, so they are no longer trimmed.
- **New fields, nothing removed:** `availability` per model and `disabled` per login on `GET /v1/switchboard/models` (#174, #233); `loginsRegistered` and `loginsError` on `/healthz/creds` (#252); `loginDiagnostics` on `/healthz/models` (#233).

### Logs and the console

- **Proxy auth off is a warning on loopback too (#188).** It used to be a warning only beyond loopback. It now says who can use the proxy without a token, web pages in your browser included; a token, or the opt-in [host/origin guard](configuration.md#running-without-a-token) for web pages, answers it.
- **The console opens with a red popup while proxy auth is off (#287),** offering to generate or enter a token. `Esc` keeps auth off.
- **Nothing saves over a `proxy-config.json` that can't be read or parsed (#288).** The console and the settings panel refuse, saying why; `/proxy reset` still replaces it.

### New in 0.5

- `pi-switchboard doctor` checks the config and the prompt cache and recommends changes; the console shows the same findings in its Doctor view (`6`) ([Checking the setup](configuration.md#checking-the-setup-pi-switchboard-doctor)).
- The console's Settings view (`5`) edits the settings and restarts the server in place ([The console](console.md#the-console-logs-logins-and-status-at-a-terminal)).
- `routing.logins.order` and `routing.logins.disabled` put a login first or keep one out of routing, also from the console's Accounts view ([Order and disabled logins](logins.md#order-and-disabled-logins)).
- The opt-in host/origin guard (`hostOriginGuard`) refuses requests a web page could send ([Running without a token](configuration.md#running-without-a-token)).
- A [prompt caching](caching.md) guide.

### Unchanged

- pi 1.4.0, as in 0.4.
- The legacy Codex login (`openai-codex`, "OpenAI Codex (legacy)" in pi 1.4) works as before, quota included. Its traffic is no longer recorded for the offline tests (#238); the ChatGPT plan's `openai` sign-in is ([Quota](routing.md#quota)).

## From pi-openai-proxy

Version 0.1.0 renamed everything that carried the old name, with no aliases:

| Before | Now |
|---|---|
| package `@vx-daniel/pi-openai-proxy`, command `pi-openai-proxy` | `@vx-daniel/pi-switchboard`, `pi-switchboard` |
| env vars `PI_PROXY_*` (e.g. `PI_PROXY_AUTH_TOKEN`, `PI_PROXY_PORT`) | `PI_SWITCHBOARD_*` (`PI_SWITCHBOARD_AUTH_TOKEN`, `PI_SWITCHBOARD_PORT`, same suffixes) |
| header `X-Pi-Upstream-Api-Key` | `X-Switchboard-Upstream-Api-Key` |
| log categories `pi-openai-proxy.*` | `pi-switchboard.*` |

- **A `PI_PROXY_*` variable that is still set is not read.** The proxy warns about it at startup and names the replacement.
- **An old `PI_PROXY_AUTH_TOKEN` stops the proxy from starting** unless `PI_SWITCHBOARD_AUTH_TOKEN` or `--auth-token` is set. This applies even when it is empty, and even with a token in the config file. Ignoring it would quietly drop the token you meant.
- **A request with the old header gets a 400** that names the new one. It's checked after proxy auth, and only on `/v1/chat/completions` and `/v1/responses`, the routes that read the key.
- **Unchanged:** `proxy-config.json` in pi's agent directory, the `/proxy` command and `x_pi`.
