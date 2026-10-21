# Claude's OpenAI compatibility layer vs pi-switchboard

Anthropic serves an OpenAI-compatible endpoint of its own
([OpenAI SDK compatibility](https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk),
read 2026-10-20). pi-switchboard does the same job, OpenAI clients talking to Claude, in a
different way. Anthropic's layer translates at Anthropic's endpoint and needs a Claude API key.
The proxy takes the OpenAI request, and pi sends it to Claude's native Messages API with pi's
login, OAuth included. This page compares the two field by field, for a Claude model
(`anthropic-messages`), as of pi-switchboard on `dev` after #144 with pi-ai 1.3.0 (#143).

How each proxy-side claim is backed:
- **test:** an offline test asserts it;
- **code:** read from the source named;
- **probe:** observed on 2026-10-20 with a throwaway test against the mock provider; the rows it
  backed are now covered by tests (#145, #146) and tagged **test**;
- **live:** observed on 2026-10-20 through the proxy with the maintainer's OAuth login, each
  request capped at one output token. These rows are a snapshot: which Claude models refuse a
  field, and which ones pi treats specially, change with Anthropic's models and pi's catalog.
  Re-check them when either moves.

## The differences that matter

| | Anthropic's layer | pi-switchboard |
|---|---|---|
| Unsupported fields | most are silently ignored | rejected with a named 422 or 400, at the top level and inside messages, except the drops constitution principle I lists (test) |
| Thinking | `reasoning_effort` ignored; a non-OpenAI `thinking` body field turns it on; the thinking is never returned | `reasoning_effort` becomes pi's thinking level, clamped to the model's levels (#43, test); the thinking is not returned either |
| System and developer messages | all moved into `system`, joined with `\n`, wherever they appear | before the first turn they form the system prompt; later ones stay in place where the model's compat allows (#45, test) |
| Prompt caching | not supported | pi marks the system prompt, the last user message and the last tool with `cache_control` on every request (code: pi-ai `anthropic-messages.js`); cache reads come back as `prompt_tokens_details.cached_tokens` |
| Auth | Claude API key, plus `anthropic-workspace-id` for keys with access to several workspaces | pi's stored login (API key or OAuth, refreshed by pi), or a per-request key in `X-Switchboard-Upstream-Api-Key` |
| Errors | OpenAI's format with Claude's messages | OpenAI's format with fixed messages that never quote the provider; a provider 400 that isn't a context overflow is `400` `upstream_invalid_request` (#147, test) |

## Request fields

| Field | Anthropic's layer | pi-switchboard, Claude model |
|---|---|---|
| `model` | Claude model names | the proxy's public model ID or canonical `provider/model-id`; only exposed models (test) |
| `max_tokens`, `max_completion_tokens` | supported | supported; `max_completion_tokens` wins (test) |
| `stream`, `stream_options` | supported | supported; `include_usage` adds the final usage chunk (test) |
| `temperature` | 0–1, above 1 capped at 1; below 1 is a 400 on Claude 4.7+ and Mythos Preview | 0–2 accepted. **pi leaves it out** for models whose pi catalog entry says `compat.supportsTemperature: false` (Opus 4.7, Opus 5.5, Sonnet 5.5, Haiku 5.5 in `models-store.json`), and whenever thinking is on (pi-ai's `buildParams` in `api/anthropic-messages.js`). So `temperature: 0.5` on Haiku 5.5 and Opus 4.7 answered 200 (live). Older models get it as sent: Opus 4.6 answered 200 with 0.5 (live). The proxy logs pi's drop, the first per model at `info` (constitution 3.2.0, #147, test) |
| `top_p` | passed through; anything but `0.99` is a 400 on Claude 4.7+, as is sending it with `temperature` | sent as `top_p` (test: `payload-passthrough-providers.test.ts`). Claude's 400 answers **400** `upstream_invalid_request`: `top_p: 0.5` on Haiku 5.5, and `temperature` 0.5 with `top_p` 0.9 on Haiku 4.5 (live). `top_p: 0.99` on Haiku 5.5 answered 200 (live) (#147) |
| `stop` | non-whitespace sequences work | sent as `stop_sequences`, exactly as sent: `"\n\nHuman:"` stays `"\n\nHuman:"` (#145, test), and `"\n2"` stopped Haiku 4.5 after `1` (live). A sequence that is only whitespace, such as `"\n"`, is Claude's 400 `each stop sequence must contain non-whitespace`, answered **400** `upstream_invalid_request` (live; #147). Before #145 it was trimmed to `""`, which Claude refuses as well |
| `n` | must be 1 | any `n` is rejected with 422 (test) |
| `parallel_tool_calls` | supported | `false` becomes `disable_parallel_tool_use: true` on `tool_choice` (PLAN, Anthropic table) |
| `tool_choice` | supported; forced (`required` or named) is an error on Opus 5.5, Sonnet 5.5, Fable 5.1 and Mythos 5.1 | translated: `auto`/`none` → `{type}`, `required` → `{type: "any"}`, named → `{type: "tool", name}` (PLAN). On Opus 5.5 `required` and a named function answer **400** `upstream_invalid_request`, and `auto` answers 200; on Haiku 4.5 `required` answers 200 (live) (#147) |
| `reasoning_effort` | ignored | pi's thinking level, clamped (#43, test) |
| `response_format` | ignored | accepted; skipped for Anthropic (PLAN, listed drop) |
| `metadata` | ignored | accepted; skipped for Anthropic, which takes only `user_id` (PLAN, listed drop) |
| `user` | ignored | sent as `metadata.user_id` (#48, test) |
| `seed`, `presence_penalty`, `frequency_penalty`, `prediction` | ignored | accepted; skipped for Anthropic (PLAN, listed drops) |
| `logprobs`, `top_logprobs`, `logit_bias` | ignored | rejected with 422 (test) |
| `store`, `service_tier`, `audio`, `modalities` | ignored | unknown parameters, 422 (spec check) |
| `prompt_cache_key` | not listed | accepted; pi's session ID, which a direct Anthropic OAuth login does not use (#39, test) |

### Tools

| Field | Anthropic's layer | pi-switchboard |
|---|---|---|
| `tools[].function.name`, `description`, `parameters` | supported | supported; `parameters` limited to a JSON Schema subset, other keywords get a 422 naming them (PLAN, "Tool schema policy"; test) |
| `tools[].function.strict` | ignored | strict sampling where pi marks the model strict-capable and the schema fits Anthropic's strict subset; otherwise sent without strict, silently (PLAN, "`strict` on function tools", a known gap by decision; test) |
| `functions` (deprecated) | supported | rejected with 422 (test) |

### Messages

| Field | Anthropic's layer | pi-switchboard |
|---|---|---|
| `system` / `developer` `content` | supported, moved to the top | string only; leading turns become the system prompt, later ones stay in place where compat allows (#45) |
| `system` / `developer` / `user` / `assistant` `name` | ignored | accepted and dropped, a drop principle I lists, logged at debug by count (#146, test) |
| `user` `content` string, `text` parts | supported | supported, whitespace kept (#145, test). One that is only whitespace is dropped by pi, as the trimmed `""` was: a blank user turn before a real one answered 200 (live) |
| `user` `image_url` `url` | supported | base64 data URIs; remote URLs only with the remote-images setting on (test) |
| `user` `image_url` `detail` | ignored | accepted and dropped, a drop principle I lists, logged at debug by count (#146, test) |
| `prompt_cache_breakpoint` on a part | not listed | accepted; Claude's API has no such field, so it is dropped and logged at debug (constitution 3.1.0; code: `src/pi/cache-breakpoints.ts`). pi marks Claude's cache points with `cache_control` itself (code: pi-ai `anthropic-messages.js`) |
| `user` `input_audio`, `file` parts | ignored and stripped | rejected with 400 (test) |
| `assistant` `content` string | supported | supported, whitespace kept (#145) |
| `assistant` `content` array (`text`, `refusal`) | text supported, refusal ignored | string or `null` only; an array is rejected with 400 (code: `schemas.ts`) |
| `assistant` `tool_calls` | supported | supported (test) |
| `assistant` `function_call`, `audio`, `refusal`, `annotations` | `function_call` supported, the others ignored | accepted empty, as an OpenAI SDK echoes a reply back: `null`, and `annotations` also `[]`; refused with a named 422 when set. `tool_calls: null` is no calls (#146, test) |
| `tool` `content` string | supported | supported, whitespace kept (#145, test). A whitespace-only result is sent as is, and Claude accepts it, as it did `""` (live) |
| `tool` `content` array of `text` | supported | rejected with 400: string only (code: `schemas.ts`) |
| `tool` `tool_call_id` | supported | supported (test) |
| `function` role (deprecated) | supported | rejected with 400 (code: not in the message union) |

## Response fields

| Field | Anthropic's layer | pi-switchboard |
|---|---|---|
| `id`, `object`, `created`, `model` | supported | supported; `id` is the proxy's request ID, `model` the public ID (test) |
| `choices` | always one | always one (test) |
| `finish_reason`, `message.role`, `content`, `tool_calls` | supported | supported, checked against OpenAI's spec (#132, test) |
| `usage.prompt_tokens`, `completion_tokens`, `total_tokens` | supported | supported; `prompt_tokens` includes cache reads and writes (test) |
| `usage.prompt_tokens_details` | always empty | `cached_tokens` (cache reads) and `cache_write_tokens` (test) |
| `usage.completion_tokens_details` | always empty | not sent |
| `logprobs` | always empty | `null` (#132, test) |
| `message.refusal`, `message.audio`, `service_tier` | always empty | not sent |
| `system_fingerprint` | always empty | not sent (#132) |
| non-OpenAI data | none | `x_pi`: cost and cache token counts (test) |

## Headers

| Header | Anthropic's layer | pi-switchboard |
|---|---|---|
| `x-ratelimit-*`, `retry-after` | passed back | not passed back: the client sees a `429 rate_limit` without them (code: no handler sets them). Quota awareness is #69 |
| `request-id` | Anthropic's | `x-request-id`, the proxy's own request ID; `x-client-request-id` echoed when sent (code: `middleware.ts`) |
| `openai-version`, `openai-processing-ms` | fixed or empty | not sent |
| `authorization` | the Claude API key | the proxy's own token when proxy auth is on; the provider key comes from pi or `X-Switchboard-Upstream-Api-Key` |

## Follow-ups from this comparison

- #145 (fixed): request text was trimmed, so stop sequences and message whitespace changed. Text
  is now kept as sent; a blank system or developer message is skipped.
- #146 (fixed): fields inside messages were dropped silently. Message and part schemas are now
  strict; `name` and `image_url.detail` are listed drops, logged; the fields an SDK echoes back
  empty are accepted empty and refused when set.
- #147 (fixed): a provider 400 caused by the client's own field answered 502. It is now `400`
  `upstream_invalid_request`: `top_p` on Claude 4.7+, `temperature` with `top_p`, forced
  `tool_choice` on the Claude 5.x models listed above, and a whitespace-only stop (live). pi's drop
  of `temperature` on Claude 4.7+ is now listed (constitution 3.2.0) and logged.
