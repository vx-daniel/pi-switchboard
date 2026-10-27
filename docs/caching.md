# Prompt caching

A provider's prompt cache keeps the start of a prompt it has seen recently, so the next request that starts the same way pays a fraction of the input price for that part. In an agent loop, where every turn resends the whole conversation, the cache is most of the input bill. The proxy doesn't cache anything itself: pi asks each provider to cache, the provider decides, and the proxy reports what happened.

## How each provider caches

| API | What pi does | What you can change |
|---|---|---|
| Anthropic (`anthropic-messages`), and Claude on Bedrock | Marks the system prompt, the last tool (Anthropic only) and the last user message as cache points (`cache_control`), on every request. Caching is by prefix: no key is needed | `PI_CACHE_RETENTION=long` ([below](#retention)) |
| OpenAI Responses and chat completions at `api.openai.com` | OpenAI caches long prompts by prefix on its own. pi sends the request's `prompt_cache_key` as the provider's key, which routes requests that share it to the same cache | Send `prompt_cache_key`; `prompt_cache_breakpoint` on a content part ([The HTTP API](api.md#supported-chat-completions-features)); `PI_CACHE_RETENTION=long` |
| Codex (`openai-codex-responses`) | Sends `prompt_cache_key` as Codex's session key, and keeps one WebSocket per key that sends only the new turns | Send `prompt_cache_key` |
| Mistral | Caches only with a key: no `prompt_cache_key`, no caching | Send `prompt_cache_key` |
| Other OpenAI-compatible servers | Whatever the server does; pi sends `cache_control` to those that take Anthropic's format | — |

A provider caches a prompt only above a minimum length it sets, so a short request (a title, a one-line classification) reads nothing from the cache whatever you do.

## Seeing what the cache did

- **Each response.** `usage.prompt_tokens` is the whole prompt; `usage.prompt_tokens_details.cached_tokens` is the part read from the cache and `cache_write_tokens` the part written to it (on the Responses API, `usage.input_tokens_details`). `x_pi` repeats them as `cache_read_tokens` and `cache_write_tokens`, with the call's `cost` in US dollars.
- **The request log.** Each request's result line has `cacheReadTokens` and `cacheWriteTokens`.
- **Totals.** The console's Stats view and sidebar, and `GET /v1/switchboard/usage`, add reads and writes into one `cache` number today, which can't tell a working cache from one rewritten every turn ([#297](https://github.com/vx-daniel/pi-switchboard/issues/297)). Until that changes, read the stats file. It is SQLite, in pi's agent dir (`~/.pi/agent` by default); open it read-only:

```bash
sqlite3 -readonly -header -column ~/.pi/agent/pi-switchboard-stats.sqlite "
  SELECT model, sum(attempts) AS calls,
    sum(input_tokens) AS uncached, sum(cache_read_tokens) AS cache_read,
    sum(cache_write_tokens) AS cache_write,
    round(100.0 * sum(cache_read_tokens)
      / nullif(sum(input_tokens) + sum(cache_read_tokens) + sum(cache_write_tokens), 0), 1) AS hit_pct,
    round(sum(cost_usd), 2) AS usd
  FROM attempt_minutes GROUP BY model ORDER BY calls DESC"
```

`input_tokens` there is the uncached input only, not the whole prompt. The file keeps 30 days; add `WHERE minute >= strftime('%s', 'now', '-1 day') / 60` for the last day.

## Reading the numbers

- **Hit rate** is `cache_read ÷ (uncached + cache_read + cache_write)`: the share of the prompt read from the cache. An agent loop on Claude normally sits above 90%. A conversation's first request can't read anything, and each turn writes its new messages once.
- **Writes are what to watch.** Reads are cheap and writes cost more than uncached input: `GET /v1/switchboard/models` lists each model's `cost.input`, `cost.cache_read` and `cost.cache_write` per million tokens. With a hit rate near 95% on Claude, writes can still be a third of the bill, because every new token in the conversation is written once at a premium.
- **Writes come from three places.** The turn's new messages (unavoidable); a prefix that changed (the client edited something earlier in the prompt); and a cache that expired between two turns. Only the last two can be fixed, and only the last by configuration.
- **On a subscription login**, the dollar figures are the tokens priced at pi's catalog, not what you pay. How a provider counts cache reads against a subscription's limits is the provider's business.

## Keeping the prefix stable

Most lost cache is a prompt whose start changes between turns. Everything after the first changed token is written again.

- **Nothing that changes in the system prompt.** A timestamp, a random ID, the current directory listing, or the tool list reordered from one request to the next invalidates the whole conversation each turn.
- **Don't rewrite earlier messages.** Editing or dropping old turns (compaction, trimming tool output) costs one full rewrite each time it happens; doing it rarely and in large steps costs less than a little every turn.
- **Send `prompt_cache_key`** on OpenAI, Codex and Mistral models, one per conversation, at most 64 characters. Zed sends one per thread when its model entry turns `prompt_cache_key` on, which `/proxy zed-sync` does ([Pi Integration](pi-extension.md)). Anthropic needs none.

## Routing and the cache

A cache belongs to one model under one account. Anything that moves a conversation to another model or another login starts it cold: the next request writes the whole prompt again.

- **Fallback chains.** A request that falls back to an alias's next target ([Fallback chains](routing.md#fallback-chains)) writes its whole prompt on that model. List in `fallbackOn` only the failures worth that cost.
- **Several logins.** Each login is its own account, so moving between logins loses the cache ([Several logins per provider](logins.md)). The default `routing.logins.fallbackOn: ["rate_limit"]` keeps a conversation on the first login until it hits a limit, which is the cache-friendly choice; adding classes there moves conversations more often.
- **Family aliases.** An alias that follows the newest model of a family ([Family aliases](routing.md#family-aliases-follow-the-newest-model)) moves to a new model the moment one is exposed; that conversation's next request starts cold. Pin the alias if a release mid-session matters.
- **Cooldowns and quota reserves** skip a candidate the same way a fallback does.

## Retention

pi asks for the provider's short cache by default: about 5 minutes on Anthropic, refreshed each time it is read. `PI_CACHE_RETENTION=long` asks for the long one. It is pi's variable, read from the proxy's environment, and applies to every provider at once:

| API | `PI_CACHE_RETENTION=long` |
|---|---|
| Anthropic, Claude on Bedrock | 1-hour cache points instead of 5 minutes |
| OpenAI Responses at `api.openai.com` | `prompt_cache_retention: "24h"`, except on a ChatGPT sign-in, which refuses it |
| OpenAI-compatible chat that supports it | `prompt_cache_retention: "24h"`, and `prompt_cache_key` sent even off `api.openai.com` |
| Codex | No change |

**On Anthropic it is a trade, not a free upgrade.** A 1-hour write costs 2× the input price instead of 1.25× (pi's cost accounting knows this), and every write pays it, including the turn's new messages that would never have expired. It pays only when more than about 40% of your writes are a cache expiring between turns. In units of the input price, for writes `W` of which a share `f` expired: short costs `1.25·W`; long costs `2·(1−f)·W` plus `f·W` read at the cache-read price. Long wins only when `f > 0.75 ÷ (2 − cache-read price ÷ input price)`.

- **An agent loop**, with turns seconds apart, rarely lets the 5-minute cache expire: leave retention short.
- **A chat you come back to** after 5–60 minutes rewrites its whole conversation each time: that is what `long` is for.
- **To find out**, look at the writes. A request that writes nearly the whole prompt and reads little, in a conversation that has been going a while, is an expired cache (or a changed prefix). The stats file's per-minute rows give a rough share:

```bash
sqlite3 -readonly -header -column ~/.pi/agent/pi-switchboard-stats.sqlite "
  SELECT model, sum(cache_write_tokens) AS writes,
    round(100.0 * sum(CASE WHEN cache_write_tokens > cache_read_tokens THEN cache_write_tokens ELSE 0 END)
      / nullif(sum(cache_write_tokens), 0), 1) AS cold_pct
  FROM attempt_minutes WHERE attempts > 0 GROUP BY model"
```

`cold_pct` is the share of writes made in minutes where a model wrote more than it read. It counts each conversation's first request as cold, and can miss a rewrite in a minute busy with other turns; if it is well under 40%, `long` most likely costs more than it saves. Treat it as a hint, then compare `cost_usd` over a day with and without `long` to be sure.
