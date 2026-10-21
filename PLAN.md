# Plan

This document is the implementation source of truth for `pi-switchboard`.

Use this file for architecture, API compatibility policy, security boundaries, phase gates, and acceptance criteria. Use `TODO.md` for the actionable checklist. Use `ROADMAP.md` for a short phase summary.

## Goals

pi-switchboard is a local HTTP API over pi's models, logins and providers that speaks OpenAI's API
to its clients (constitution, "Scope").

Primary goals:

- Serve OpenAI's API where pi can back it: models and chat completions today, the Responses API
  next (#140)
- Reuse pi's configured auth and model definitions; run no logins of its own
- Route requests across pi's logins: aliases, fallback chains, cooldowns, quota awareness, usage by
  route (#66–#70), under constitution principle VI
- Support OpenAI function tools where they can be translated safely
- Stay checked against OpenAI's published spec (#132) and describe itself in OpenAPI (#129)

Secondary goals:

- Preserve request and usage observability
- Be safe by default for local usage
- Distribution: the pi package on GitHub Packages, npmjs later (#59), a Docker image (#60), a
  standalone binary (#61)
- Later, not planned: an experimental agentic mode ("Agentic mode" below)

## Non-goals

- OpenAI endpoints pi cannot back: embeddings, audio, image and video generation (pi-ai 1.3 has
  image generation for OpenRouter only), realtime
- OpenAI's stateful platform services: stored chat completions and responses, assistants,
  threads, files, batches, fine-tuning, conversations. The proxy keeps no conversation state
- Other vendors' client protocols (Anthropic `/v1/messages`, Gemini `/v1beta`): clients speak
  OpenAI's API to the proxy, and pi speaks each provider's to the provider
- Logins, token refresh or credential storage of its own: pi owns them
- Legacy `POST /v1/completions`
- Exposing unrestricted agent tool execution under an OpenAI-compatible route

## Production defaults

- Bind to `127.0.0.1` by default
- Do not expose the proxy on `0.0.0.0` unless explicitly configured
- Log a per-request proxy request ID
- Accept an incoming `X-Client-Request-Id` and propagate it through logs
- Abort upstream work when the client disconnects
- Reject unsupported parameters clearly instead of silently ignoring them (the exceptions are listed in `CONSTITUTION.md` principle I)

## Tooling and type safety

Strict tooling through [Vite+](https://viteplus.dev), configured in `vite.config.ts`:

- **TypeScript**: ultra-strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`)
- **Oxfmt** (`vp fmt`): the Viaanix style copied from `oxc-config-viaanix` v4.0.0 (single quotes, no semicolons, no trailing commas, 2-space indent, 100 columns, sorted imports); Markdown and the lockfile are left as written. Lint skips hidden folders, `dist/`, and `docs/` (Viaanix `ignorePatterns`)
- **Oxlint** (`vp lint`): the Viaanix shared rules (copied and flattened from `Viaanix/oxc-config-viaanix` v4.0.0 strict: base, TypeScript, type-aware, strict layers), type checking, `maxWarnings: 0`, and `reportUnusedDisableDirectives: deny`; plus repo additions: `no-unsafe-type-assertion`, `no-unnecessary-condition`, stricter `no-unused-vars`, zod plugin, import-alias plugin, and repo rules in `lint/repo-rules.ts` (`no-enum`, `no-delete`, `no-implicit-any-let`). `no-console` is `warn` everywhere, with no file exceptions; with `maxWarnings: 0` any `console` call fails lint
- **`vp check`**: format, lint, and type check in one pass
- **Vitest** (`vp test`): tests import from `vite-plus/test`
- **tsdown** (`vp pack`): ESM build with `.d.ts`
- **Zod v4**: namespace import (`import * as z`), `safeParse()` for all external data, `z.int()` for integer fields
- **Type guards**: `isRecord()` for narrowing `unknown`, never `as` casts
- **Import aliases**: `@proxy/*` -> `src/*`, no `.js` extensions, no relative imports
- **Typed env**: `src/env.d.ts` for `process.env` dot notation
- **Gate** (`scripts/gate.ts`, `pnpm run check:all`): format → lint + type check → tests with coverage → fallow → build; the single definition of green, run by the pre-commit hook, CI, and the release workflow
- **fallow** (`.fallowrc.jsonc`, `fallow-plugin-oxlint-js.jsonc`): dead code, duplication and complexity, CRAP scored against the test coverage; adopted at zero findings (#83), so any new one fails the gate. Exceptions are config entries with reasons, never inline comments. No complexity ceiling is raised: the ones set at adoption were refactored away (#85), the last being `resolveModelScope`
- **Git hooks** (`.vite-hooks/`): pre-commit (`check:all`), commit-msg (commitlint), pre-push (lockfile sync)
- **CI** (`.github/workflows/`): `ci.yml` (`gate` on pull requests into `dev`/`main` and pushes to `dev`), `secret-scan.yml` (gitleaks, new commits only, every branch), `claude-pr-review.yml` (manual), `publish.yml` (release on `main`, then `image.yml` and `package.yml` for the new tag)
- **commitlint**: conventional commits via `@commitlint/config-conventional`
- **semantic-release**: version, changelog, GitHub release and the release commit; the image and the package are published from its tag by `image.yml` and `package.yml`

## API compatibility policy

### Stable surface

The routes covered by constitution principle I, the one list of them (AGENTS.md and README link
here). Each one meets principle I's criteria: an OpenAI-defined route, checked against the pinned
spec, described in `openapi.json`, documented in README and here.

| Route | Since | Decision |
|---|---|---|
| `GET /v1/models` | Phase 1 | original contract |
| `GET /v1/models/{model}` | Phase 1 | original contract |
| `POST /v1/chat/completions` | Phase 1 | original contract |

Planned: `POST /v1/responses` (#140), experimental first, then promoted here once it meets the
criteria. Adding or removing a row is a decision recorded in this table, with its issue, and a
`feat` (or breaking) change; it is not a constitution amendment.

### Reference spec

"Close to OpenAI's schema" (constitution, principle I) is measured against OpenAI's published
OpenAPI spec ([`openai/openai-openapi`](https://github.com/openai/openai-openapi)), pinned to one
commit (#132). `test/fixtures/openai-spec/openapi-subset.json` holds the schemas the stable surface
is checked against, and everything they reference:

- `ListModelsResponse`, `Model`
- `CreateChatCompletionRequest`, `CreateChatCompletionResponse`, `CreateChatCompletionStreamResponse`
- `ErrorResponse`

`test/integration/openai-spec.test.ts` validates every response body of the stable routes against
it: models, chat completions streamed and not, and each error status. It also checks the request
schema in both directions. Every field and enum value the proxy accepts must exist in OpenAI's
request, with one listed kind of exception: a response-message field an OpenAI SDK echoes back in
history (`annotations`, accepted only empty; see "Unknown field policy"). Every OpenAI field or
value the proxy does not accept must be listed in the test, with what the proxy does instead.

Moving the pin is deliberate: `pnpm run openai-spec:update <commit>` rewrites the subset, and a
bump that adds a request field or enum value fails the test until it is accepted or listed. The
fields the proxy adds (`x_pi`, `prompt_tokens_details.cache_write_tokens`) pass because OpenAI's
schemas leave `additionalProperties` open; a bump that closes one fails.

### Operational endpoints

Outside the OpenAI-compatible surface, not shaped like OpenAI responses (`src/server/health.ts`):

- `GET /healthz`: liveness, no proxy auth, `{ "status": "ok" }` only, no upstream calls.
- `GET /healthz/models`: available and exposed model counts, exposure modes, `models.json` load
  error; `503` when nothing is exposed or the exposure config is invalid. A parse error is reduced to where the file is not valid
  JSON (`describeModelsJsonError`): JSON.parse messages quote the text around the fault, often a
  key. The same reduced text is what the startup warning logs.
- `GET /healthz/creds`: per provider with a credential, its type, source and available model
  count; local state only unless `?verify=true` resolves each credential (may refresh OAuth);
  `503` when no provider has one or a verification fails. A verification error carries pi's
  summary, the token URL and the upstream status only (`summarizeAuthError`); the upstream body
  and pi's stack stay out of the response, and the body reaches the log at `debug` only.

The detail endpoints require proxy auth when it is on, because they name providers and models.
None returns a credential. Without a proxy token, `?verify=true` is open to whoever can reach the
port, as `/v1/chat/completions` is; it can do less harm than a completion: pi refreshes a token only
when it is about to expire, and runs the refresh inside its credential store's serialized `modify`,
so repeated or concurrent calls neither refresh every time nor refresh twice.

### OpenAPI document and docs UI

The proxy describes its own API in OpenAPI 3.1 (#129), built with
[`hono-openapi`](https://github.com/rhinobase/hono-openapi) from the routes
(`src/server/openapi.ts`):

- `GET /v1/switchboard/openapi.json`: the document. Always on.
- `GET /docs`: [Swagger UI](https://github.com/honojs/middleware/tree/main/packages/swagger-ui)
  for it, with "Try it out", at the root where a browser goes (an operational endpoint). Off
  unless `docsUi` (`--docs-ui`, `PI_SWITCHBOARD_DOCS_UI`, the settings panel) is on, because the page
  loads `swagger-ui-dist`, pinned to `SWAGGER_UI_VERSION`, from the jsDelivr CDN; off, it answers
  an OpenAI-style 404. It is not bundled: `swagger-ui-dist` depends on `@scarf/scarf`, whose
  install script reports installs to an analytics service.

Both skip proxy auth (constitution 2.2.0). A browser cannot send a bearer token to open a page,
and Swagger UI cannot load the document before the token is entered with "Authorize". Neither
names a model, provider or credential, and every route they describe still needs the token. The
document is registered before the auth middleware in `createApp`; `/docs` is outside `/v1`.

What the document covers: every route the proxy serves, which a test checks against the app's
route table.

- the stable routes and `GET /v1/switchboard/models`, with their request and response schemas,
  error statuses and the bearer scheme;
- the health endpoints, under "Operational", with their bodies (`/healthz` needs no token);
- the document and the docs page, under "Documentation". `/docs` is registered whatever the
  config, so the document does not depend on `docsUi`;
- the OpenAI endpoints the proxy answers with 404, under "Not supported", as deprecated `GET` and
  `POST` operations (they answer any method). They are written into the document by hand: hono-
  openapi leaves wildcard and `ALL` routes out.

The response schemas are the Zod schemas the builders type their bodies with (`OpenAIChatCompletion`
is `z.infer` of `openAIChatCompletionSchema`, the health bodies likewise in `src/server/health.ts`),
so the document cannot name a field the code does not send. They are never parsed at runtime.

What a route reads from a request is validated with hono-openapi's `validator()`, which also
documents it, so no parameter or request body is described by hand:

| Route | Validated | Schema (`src/server/openapi.ts`) |
|---|---|---|
| `GET /v1/models/{model}` | path `model` | `modelPathSchema` |
| `POST /v1/chat/completions` | header `X-Switchboard-Upstream-Api-Key`, JSON body | `chatHeadersSchema`, `chatRequestBodySchema` |
| `GET /healthz/creds` | query `verify` | `credentialsQuerySchema` |

- **The chat body keeps the proxy's 400/422 split and wording.** The validator's hook answers a
  failed body with `chatRequestRejection` (`src/openai/validate.ts`): a named 422 for a rejected
  or unknown field, a 400 naming the first invalid value. The schema runs once per request; the
  rejection parses again only for a body that already failed.
- **Any `Content-Type`.** `validator('json')` reads only a body declared as JSON, so
  `jsonBodyMiddleware` declares it JSON first. The proxy has always read the body as JSON whatever
  its declared type, and `curl -d` sends form-urlencoded.
- **Malformed JSON.** The validator throws Hono's `HTTPException` (400, "Malformed JSON in request
  body"), which `app.onError` answers in OpenAI's error shape.
- **`?verify=`**: only `true` verifies, and any other value is the same as none. A repeated
  `verify` counts by its first value, as before; the schema accepts the array the validator
  builds for it, so it never fails into hono-openapi's own error shape. Surrounding spaces are
  trimmed, so `%20true` now verifies.
- **Model IDs from the path are trimmed,** as the chat body's `model` already was (the repo's Zod
  lint rule requires `.trim()`): `/v1/models/%20gpt-x` finds `gpt-x`. The exposure config is
  still matched exactly as written (constitution, principle IV).
- **No failure hooks besides the chat body's.** The path, header and query schemas accept any value
  the request can carry, so their validators never fail.
- **No default 400.** `defaultValidationErrorResponse` is off: hono-openapi's default documents a
  400 in its own `{ success, error, data }` shape, which the proxy never sends.

`openapi.json` at the repository root is the document as committed: a file snapshot in
`test/integration/openapi-document.test.ts`. A change to a route, field, status or description
fails the test until `vp test -u` rewrites it, so the contract change shows up in review. The
health bodies are tracked there too, so a new health field is a reviewed change. Its
`info.version` is the API's (`v1`), not the package's, so a release does not change it.

The model detail route is `/v1/models/:model{.+}`: hono-openapi leaves a wildcard route out of the
document. Hono decodes the ID once (`%252F` stays a literal `%2F`), and a malformed escape is
answered `404 model_not_found` rather than thrown as a 500. `/v1/models/` with no ID keeps its
OpenAI-style 404.

### Errors thrown inside the proxy

`app.onError` answers anything a handler or middleware throws, instead of Hono's plain-text 500
and its `console.error`:

- a Hono `HTTPException` with a 4xx status (today only the validator's malformed-JSON 400): that
  status, as `invalid_request_error` with Hono's fixed message;
- anything else, an invalid exposure config included: `500`, `server_error`, code
  `internal_error`, with fixed text. The thrown message, which can quote a path or a config value,
  is logged at debug only; the error line names the error class.

### Unsupported endpoints

Return OpenAI-style errors for:

- `POST /v1/completions`
- `POST /v1/embeddings`
- `POST /v1/audio/*`
- `POST /v1/images/*`
- assistants, threads, runs, files, batches, fine-tuning

Any other request no route matches, a known path with another method included, answers 404 too,
in OpenAI's error shape and wording: `Invalid URL (<METHOD> <path>)`, `invalid_request_error`
(`app.notFound` in `createApp`, #133). Under `/v1`, proxy auth runs first, so without the token an
unknown `/v1` path answers 401 and does not reveal which paths exist.

## Public and canonical model IDs

Internal canonical model IDs remain:

- `provider/model-id`

Examples:

- `openai/gpt-4o`
- `anthropic/claude-sonnet-4-20250514`
- `openrouter/anthropic/claude-sonnet-4-20250514`

Canonical IDs are an internal storage and routing primitive.
Use them for:

- internal registry lookup
- persisted custom-model selections
- backward-compatible request resolution for models that are still exposed

The public HTTP API does not always expose canonical IDs.
Public model IDs are configurable and should prefer universal provider-neutral names when possible.

### Public model ID modes

Supported public ID modes:

- `collision-prefixed` — default
- `universal`
- `always-prefixed`

#### `collision-prefixed`

Start from the raw model ID (`model.id`) for every exposed model.
If any two exposed providers share at least one raw model ID, prefix **all** models from providers in that connected conflict group.

This is a provider-group rule, not a per-model rule.
If `openai` and `codex` collide on one exposed model name, prefix all exposed `openai/*` and all exposed `codex/*` public IDs.
Do not prefix unrelated providers that are outside that conflict group.

#### `universal`

Expose raw model IDs only.
If the exposed model set contains duplicates, configuration is invalid and must fail validation explicitly.
Do not silently downgrade to a prefixed mode.

#### `always-prefixed`

Expose `<public-prefix>/<model-id>` for every model.
This is closest to the behavior before Phase 3A, which exposed canonical `provider/model-id` IDs.

### Public prefix labels

Prefixed public IDs use:

- `<public-prefix>/<model-id>`

Default `public-prefix` is the provider key.
The prefix label must be configurable per provider via settings.

Validation rules:

- prefix labels must be unique among exposed providers in prefixed modes
- invalid prefix collisions must surface as explicit configuration errors

### Exposure modes

Supported exposure modes:

- `all` — expose all available models
- `scoped` (default) — expose the models pi's global `enabledModels` setting selects; with none
  set, every available model
- `custom` — expose only an allowlist of canonical model IDs, matched exactly; an empty list
  exposes no model (#88): the operator chose to pick models, so nothing picked fails closed

Persist custom-model selections as canonical IDs, not public IDs.
That keeps configuration stable when public ID mode or prefix labels change.

### Resolution policy

For incoming model references on the HTTP API, resolve in this order:

1. exact public ID match
2. exact canonical ID match for backward compatibility

Canonical fallback is only allowed for models inside the current exposed set.
Hidden models must not become reachable through canonical fallback.

Do not rely on the old registry-wide shorthand ambiguity rules on the public HTTP surface.
The public model list itself defines the valid request IDs.

### Route handling

`GET /v1/models/{model}` must support URL-encoded full model IDs because both canonical IDs and prefixed public IDs can contain `/`.

Examples:

- `/v1/models/gpt-5.4-mini`
- `/v1/models/openai%2Fgpt-5.4-mini`
- `/v1/models/codex%2Fgpt-5.4-mini`
- `/v1/models/openrouter%2Fanthropic%2Fclaude-sonnet-4-20250514`

Do not rely on a single path-segment router parameter without decoding support.

## Model exposure configuration

Shared proxy configuration must grow to include model-exposure controls.
The JSON config file, CLI overrides, env handling, and settings panel must all agree on the same schema.
That schema is the Zod `ProxyConfigSchema` in `src/config/schema.ts`: the config types are inferred from it, and the settings panel takes each mode's values from its enum. A config file is never refused: a field the schema rejects is repaired (numbers clamped to the schema's bounds, lists and maps keep their valid entries, anything else defaults) and named, by path only, in one warning per change. Model IDs and prefix labels are never normalized: exposure follows the config exactly as written.

Required settings:

- `publicModelIdMode`: `collision-prefixed` | `universal` | `always-prefixed`
- `modelExposureMode`: `all` | `scoped` | `custom`
- `customModels`: string[] — canonical model IDs only
- `providerPrefixes`: record of provider key -> public prefix label

Note: `scoped` mode delegates to pi's global `enabledModels` setting (from `/scoped-models` Ctrl+S,
or a hand-edited `settings.json`). No proxy-side config is needed: the proxy reads
`SettingsManager.getEnabledModels()` at request time and resolves the entries as pi does (#46):
exact `provider/id` or bare IDs, globs over `provider/id` or the ID (`anthropic/*`, `*sonnet*`),
`:level` thinking suffixes (the level is dropped; exposure is per model), and fuzzy matching of IDs
and names. pi exports only an async resolver that refreshes availability (reading the credential
store for every provider); its synchronous `resolveModelScopeFromModels` is not in the package's
`exports`. So `src/pi/model-scope.ts` ports the synchronous one, run against the same
available-model snapshot the proxy exposes. The port follows pi's loop step for step, with its
glob and reference branches as one helper each (`globMatches`, `referenceMatches`), so it can be
read against pi's source; `test/unit/model-scope.test.ts` checks it against pi's resolver.
Patterns that match nothing, match several providers, or carry an invalid thinking level are
listed in `/healthz/models` (`scopeDiagnostics`) and in `/proxy show`. pi's
`--models` flag is per session and does not apply.

Settings-panel requirements:

- the main `/proxy` panel remains the default no-arg entry point
- enum settings for public ID mode and exposure mode must persist immediately
- `scoped` mode is managed via pi's `/scoped-models` command, not a proxy-specific UI
- model selection for `custom` mode should use a searchable selector UI
- prefix overrides should be editable without requiring manual JSON editing
- `/proxy verify` should validate collisions, invalid universal mode, unknown providers, and missing custom models
- `/proxy show` should summarize the effective exposure policy and preview representative public IDs

## Authentication model

### Upstream credentials

Primary source:

- pi `ModelRuntime` (credentials, catalogs and request auth in one place; Pi 1.x replaced
  `AuthStorage` and `ModelRegistry.getApiKeyAndHeaders()` with it)

Completions run through `ModelRuntime.streamSimple()` (a non-streaming request reads the stream's
final message, as `completeSimple()` would), which resolves
request auth themselves on every request: API keys, OAuth with refresh, model-specific headers,
provider environment and an auth-resolved base URL (`ModelRuntime.prepareRequest`). The proxy
only pre-checks that auth resolves (`getRequestAuth()`), so a route can answer 401 before a
response starts. A per-request `X-Switchboard-Upstream-Api-Key` overrides the resolved key.

When resolution fails, the 401 and the warning carry only pi's summary of the failure
(`summarizeAuthError`): pi's OAuth errors go on to quote the token endpoint's response and a stack
with install paths, which reach the log at `debug` at most, as on `/healthz/creds?verify=true`.
The summary is pi's own first clause, so it can still quote operator config: for a `models.json`
key command that resolves to nothing, pi's message names the command
(`… from shell command: <command>`). Keep secrets out of key commands themselves (read them from a
file or a secret manager the command calls).

### Per-request override

Do not use the standard `Authorization: Bearer ...` header for upstream provider overrides.

Use a proxy-specific header instead, for example:

- `X-Switchboard-Upstream-Api-Key`

Reason:

- OpenAI-compatible clients already use `Authorization` for proxy authentication
- reserving `Authorization` keeps future proxy auth compatible with ecosystem expectations

### Proxy auth

- incoming `Authorization: Bearer <proxy-key>` protects the proxy itself; off by default for local use
- the token comes from `--auth-token`, `PI_SWITCHBOARD_AUTH_TOKEN` or `authToken` in the config file, in that order; `"authToken": ""` turns it off
- two states (`ServerConfig.proxyAuth`): `off` and `token`. Auth that is set but cannot be applied refuses to start (`UnusableProxyAuthError` from `loadConfig`, CONSTITUTION principle II's exception): a file `authToken` that is not a string (`null` included, #82), or a `--auth-token` or `PI_SWITCHBOARD_AUTH_TOKEN` that is set but empty (#99). The file's token is not used in place of an empty override, since that would ignore what was set. The CLI logs why at `fatal` (no log level filters it out), naming the field or the flag/variable and never the value, and exits `1`. It never falls back to `off`, which would turn a requested token into an open proxy, and it does not start to refuse every request, which would hide the mistake behind a running process
- the pi extension discards the proxy's output, so `/proxy start` checks the same two causes before spawning (`startRefusal` in `extensions/proxy/process.ts`: the token it passes wins over pi's own `PI_SWITCHBOARD_AUTH_TOKEN`, which the child inherits, and either wins over the file) and refuses with the reason instead of reporting a proxy that never answered
- saving the config (the extension's settings panel, the model selector) writes such a value back unchanged; only an explicit choice on the auth row or `/proxy reset` replaces it

## Request contract for `POST /v1/chat/completions`

### Supported fields

- `model`
- `messages`
- `stream`
- `temperature`
- `max_tokens`
- `max_completion_tokens`
- `stop`
- `user`
- `stream_options.include_usage`
- `tools`
- `tool_choice`
- assistant `tool_calls`
- `tool` role messages
- `reasoning_effort` (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`): an effort the model does not support is clamped with pi's `clampThinkingLevel` (nearest supported level above, else below) and logged at debug, not rejected (#43). `max` is pi's `max` level (#132); on a model without it, it is the model's highest level. A client that sends one effort to every model must keep working when the model changes; `GET /v1/switchboard/models` lists each model's supported efforts
- `response_format` (`text`, `json_object`, `json_schema`)
- `top_p`
- `frequency_penalty`
- `presence_penalty`
- `seed`
- `parallel_tool_calls`
- `metadata`
- `prediction`
- `prompt_cache_key` (#39): pi's `sessionId`; 1–64 characters after trimming, `null` the same as none. Over 64 is a `400`, because pi itself cuts a key to 64 (`clampOpenAIPromptCacheKey`), which would silently merge keys sharing their first 64 characters. It is never a raw payload field: pi writes it where the API takes one (OpenAI Responses, Codex, chat completions to `api.openai.com`) and sends Anthropic session-affinity headers only when the model's `compat.sendSessionAffinityHeaders` is on and the login is not OAuth. On Codex pi also keeps one WebSocket per key and login for 5 minutes and sends only the new input with `previous_response_id` when the request extends the previous one exactly; any other request goes whole. A client that sends a new key per request leaves one socket open per key for those 5 minutes, which is acceptable for a local proxy (revisit if the proxy is shared). `prompt_cache_retention` (deprecated) and `prompt_cache_options` (no pi equivalent) stay unknown fields (`422`)
- image content parts (base64 data URIs; remote `http`/`https` URLs only with `remoteImages` on, which is off by default, see "Image URL fetching")

Compatibility preference:

- prefer `max_completion_tokens` over deprecated `max_tokens`
- support `json_schema` in `response_format` on the stable chat-completions path
- broaden `reasoning_effort` to match the current OpenAI enum surface

### Rejected

- `n > 1`
- `logprobs`
- `top_logprobs`
- `logit_bias`
- `functions` (deprecated)
- `function_call` (deprecated)
- audio output/modality (`audio`, `modalities`: unknown fields, `422`)
- input audio content parts (`400`)
- file content parts (`400`)
- unsupported multimodal content parts (`400`)
- unsupported tool schema shapes (`422`)
- any parameter not explicitly supported or allowlisted for passthrough (`422`)

### Unknown field policy

Default behavior, at the top level and inside messages and content parts alike (their schemas are
strict, #146):

- reject with `422`, naming every unknown field in the message (`Unknown parameter(s): …`) and
  the first in `param`, as its full dotted path inside a message
  (`messages.0.content.0.cache_control`)

The fields in "Rejected" above (`n`, `logprobs`, `top_logprobs`, `logit_bias`, `functions`,
`function_call`) get `422` too, with `'<field>' is not supported in this version of the proxy`.
So does a value in an assistant field an OpenAI SDK sends empty when it echoes a reply back in
history (the Python SDK's `model_dump()` carries every response field), as pi has nowhere to put
it: `refusal`, `audio` and the deprecated `function_call` are accepted only as `null`, and the
response-only `annotations` only as `null` or `[]`. `tool_calls: null` means no calls. A known
field with an invalid value or shape (an unsupported content part included) gets `400`, at the
field's own path: messages are told apart by `role` and a user message's string or parts by shape,
so an error inside one names the field, not the message.

Two OpenAI message fields pi has no equivalent for are accepted and dropped instead, as
constitution principle I lists them (#146): `name` on a `system`, `developer`, `user` or
`assistant` message (a participant name) and `detail` on an `image_url`. Clients send both
routinely. Each drop is logged at `debug`, by count, never the value. `name` on a `tool` message is
not one of them: OpenAI defines none there (the call a result answers names the tool), so it is
an unknown field, `422` (a maintainer decision on the #155 review).
`test/integration/openai-spec-messages.test.ts` checks every role's and part's fields against
OpenAI's spec, as `openai-spec.test.ts` does the top level.

### Text is kept as sent

Request text whose whitespace is data reaches pi exactly as the client sent it (#145): message
content of every role, `text` parts, tool results, `stop` sequences and `prediction` content. These
use the one `textSchema` (`src/openai/text-schemas.ts`). Every other request string (`model`, tool
and function names, call IDs, `user`, `prompt_cache_key`, image URLs, tool-call `arguments`) is
trimmed, as the `zod/prefer-string-schema-with-trim` lint rule requires. That rule is off for
`text-schemas.ts` alone (`vite.config.ts`, with the reason), so no other file can opt out by
accident.

Before #145, every string was trimmed: `stop: ["\n"]` went out as `[""]`, and leading indentation
and trailing newlines were stripped from message text. A system or developer message that is only
whitespace is skipped. It carries no instruction, and Anthropic refuses a blank system prompt; the
trimmed `""` used to come out as no system prompt, and skipping it keeps that. A blank part of a
system or developer message is left out when the parts are joined.

Whitespace-only text elsewhere goes to pi as sent, and pi's adapters handle it. On Anthropic, pi
drops a blank user message, user text part or assistant text block. A blank tool result goes as
its text, which Claude accepts, as it did the trimmed `""` (checked live, 2026-10-20). A
whitespace-only `stop` sequence is the exception: Claude refuses it, as it refused the trimmed
`""`, and the client gets a 502 for its own field (#147).

### Prompt cache breakpoints

OpenAI's `prompt_cache_breakpoint` (`{ "mode": "explicit" }`, `PromptCacheBreakpointParam`) on a
text or image content part marks the exact end of a reusable prompt prefix. It affects caching
only, never the answer. The proxy accepts it on every text and image part (system, developer and
user), and sends it on only where the API takes it (constitution 3.1.0, principle I's exceptions):

| API | What happens |
|---|---|
| OpenAI chat completions and Responses at `api.openai.com` | Forwarded. pi joins the leading system and developer text into one string; the proxy's `onPayload` (`src/pi/cache-breakpoints.ts`) puts the client's parts back in its place, joined with the same blank lines, each with its breakpoint (`text` or `input_text` parts). User parts get theirs back by position. Each change is made only when pi's text matches exactly, so a payload pi built differently is left alone. |
| Codex (`openai-codex-responses`) | Dropped: pi sends the system prompt as the plain string `instructions`, which has no part to carry it. |
| Every other API (OpenAI-compatible servers, Anthropic, Google, Bedrock, …) | Dropped: an OpenAI-compatible server may refuse a field it does not know, and the others have no such field. |

A drop is logged at `debug` (`Dropped {count} prompt_cache_breakpoint(s) for {modelId}`), and a
forward reports how many were placed. Rejecting the field instead would break docker-agent,
which sends it on every system part to `gpt-*` models (#149). `test/unit/cache-breakpoints.test.ts`
runs pi's real chat-completions and Responses builders, so a change in how pi builds the system
message shows up there.

## Message mapping policy

### Roles

- `system`, `developer` (treated alike):
  - before the first conversation turn -> the system prompt, joined with a blank line, in order
  - later -> a pi `SystemMessage` where the client put it (#45). On a model whose compat sets
    `supportsMidConvoSystemMessages`, pi sends it in place: chat completions and Responses between
    the same turns; Anthropic just before the next assistant turn, because Anthropic refuses
    anything between a `tool_use` and its `tool_result`. On any other model pi merges it into the
    leading prompt (`collapseSystemMessages`), so the payload is what the proxy sent before #45.
- `user` -> pi user message
- `assistant` -> pi assistant message history
- `tool` -> pi tool result message

### Content parts

Supported:

- text
- image content parts using base64 data URIs
- image content parts with an `http` or `https` URL, only while `remoteImages` is on (off by
  default): the chat route downloads each one and replaces it with a data URI before message
  conversion, under the limits in [Image URL fetching](#image-url-fetching). A refused image fails
  the request with `400` `invalid_request_error` at `messages[i].content[j].image_url.url`

Rejected:

- remote image URLs while `remoteImages` is off: `400` at
  `messages[i].content[j].image_url.url`, naming the setting
- input audio
- file parts
- unsupported structured content variants

### Assistant tool calls

Support OpenAI `function` tool calls first.

Do not claim support for custom tool shapes until a compatible mapping is defined and tested.

## Tool schema policy

OpenAI tool parameter schemas are JSON Schema. pi tools expect TypeBox schemas.

Stable policy:

- support a documented subset of JSON Schema only
- reject unsupported schema constructs with `422`
- do not silently downgrade schemas: every keyword is carried upstream, dropped as meta, or
  rejected

Supported subset:

- `type: object` with `properties` and `required`
- `type: string`, `number`, `integer`, `boolean`, `null`
- `type: array` with `items` schema
- `enum` (string values only, mapped to TypeBox Union of literals); a string enum may also carry
  the `string` constraints below (e.g. `format`)
- nullable types via `type: [T, "null"]`: constraints go on the `T` branch, annotations on the
  union
- `anyOf` for nullable types and simple unions (max 10 branches); a sibling `type` is carried as
  written
- annotations on any node: `description`, `title`, `default`, `examples`, `deprecated`,
  `readOnly`, `writeOnly`
- constraints, carried upstream, only on the type they apply to:
  - `string`: `minLength`, `maxLength`, `pattern`, `format`, `const`
  - `number`, `integer`: `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`,
    `multipleOf`, `const`
  - `boolean`: `const`
  - `array`: `minItems`, `maxItems`, `uniqueItems`
  - `object`: `minProperties`, `maxProperties`, `additionalProperties` (boolean)
- keyword values are checked by kind only: lengths and counts are non-negative integers, bounds
  are finite numbers, `pattern`/`format`/annotations are strings, flags are booleans, `examples`
  is an array. `const` is not checked against the node's type, and `pattern` is not compiled: a
  provider that rejects them answers with its own error.

Dropped: `$schema`, `$id`, `$comment`. They carry nothing for the model; zod-to-json-schema and
similar generators add `$schema` to every schema. Each drop is logged at debug with its path.

Rejected (`422`, naming the keyword and its path; logged as a warning with the tool name):

- `$ref`
- `oneOf` / `allOf`
- `if` / `then` / `else`
- `patternProperties`
- `not`
- `additionalProperties` as a schema object
- recursive schemas
- non-string enum values
- any other keyword (e.g. `x-*` extensions, OpenAPI `nullable`, `propertyNames`), or a supported
  keyword on a type it does not apply to
- a supported keyword whose value is of the wrong kind, including a `required` that is not an
  array of property names (ignoring it would make every property optional)

## Known gaps and silent drops

The sections below record where the proxy once ignored parameters instead of rejecting them, and
what became of each. Two kinds of drop remain, as deliberate exceptions listed in
`CONSTITUTION.md` principle I (1.2.0): Codex `temperature`, and passthrough fields a provider has
no equivalent for (the per-API tables under "API-aware payload translation", #81). Any other
silent drop is a violation of that principle.

### `tool_choice` — resolved

`tool_choice` is forwarded to upstream providers via `onPayload` passthrough, the same
mechanism used for `top_p`, `seed`, `response_format`, and other provider-specific fields.
All OpenAI `tool_choice` values are supported: `"none"`, `"auto"`, `"required"`, and
named function choice `{ type: "function", function: { name: "..." } }`.

Passthrough fields (including `tool_choice`) are injected verbatim via `onPayload` only for
OpenAI-compatible APIs (`openai-completions`, `openai-responses`, `azure-openai-responses`,
`mistral-conversations`). Anthropic, Google and Codex get the subset they support, translated to
their own payload shapes (see "API-aware payload translation"); Bedrock and any other API get
none. The fields are still accepted by the proxy schema; where they are not translated they have
no effect.

### `strict` on function tools — strict where supported (#44)

A tool's `strict: true` maps to pi's constrained sampling,
`constrainedSampling: { type: "json_schema", strict: "prefer" }` (`src/openai/tools.ts`). Each pi
API adapter (OpenAI chat completions and Responses, Azure, Codex, Anthropic, Google, Bedrock,
Mistral) decides from the model's `compat` whether strict applies, rewrites the schema with
`makeStrictJsonSchema` (every property required, optional ones nullable,
`additionalProperties: false`), and sends `strict: true` in that API's own shape. `strict: false`,
`null` or absent sends no strict sampling.

Before #44 the proxy patched `tools[i].function.strict` in `onPayload`. Only chat completions has
that shape, so strict was silently dropped on every other API, and forced onto chat-completions
endpoints whether or not they support it, with the schema as sent.

**Known gap, by decision:** where strict cannot apply, the tool is sent without it, and neither the
client nor the log is told. That happens when pi does not mark the model strict-capable (its
default for OpenAI-compatible endpoints, including custom `models.json` models without
`compat.supportsStrictMode` / `supportsStrictTools`), or when the schema is outside the
provider's strict subset (Anthropic refuses `minimum`, `maximum`, `multipleOf`, …). `"require"`
would refuse those requests instead, but it would break every client that sends `strict: true` by
default on most non-OpenAI routes. Clients that need the guarantee must validate tool arguments
themselves. docker-agent sends no per-tool `strict` on Chat Completions, so it is unaffected.

### Tool schema keywords — resolved

Before #37, the converter kept only the structure (`type`, `properties`, `required`, `items`,
`enum`, `anyOf`, `description`) and silently dropped every other keyword: ranges, lengths,
`pattern`, `format`, defaults, and `additionalProperties: false`. The model saw looser schemas
than the client wrote, and `strict: true` tools reached OpenAI without the
`additionalProperties: false` its strict mode requires on every object (see #44 above for how
strict is applied now).

Supported constraints and annotations are now carried upstream, meta declarations are dropped
and logged, and any other keyword is rejected with `422` (see "Tool schema policy"). Clients
whose schemas use keywords outside the subset, which used to be silently dropped, now get a
`422`.

pi decides what each provider receives. For Anthropic it sends only the top-level `properties`
and `required`, so a top-level `additionalProperties` does not reach Anthropic; nested schemas
pass through unchanged. Google receives the schema as `parametersJsonSchema` (full JSON Schema).

### `parallel_tool_calls` — resolved

`parallel_tool_calls` is forwarded to upstream providers via `onPayload` passthrough.
The field was previously rejected (422) because the pi SDK does not expose parallel tool
call control. Analysis showed this rejection broke real clients:

- **Continue** sends `parallel_tool_calls: false` for most models
- **Open WebUI** and **Aider** do not send the field

The proxy's SSE streaming code already handles multiple tool calls per response via
`contentIndex` tracking, so the response side was always capable. `parallel_tool_calls` is
injected verbatim for OpenAI-compatible APIs, translated to `disable_parallel_tool_use` for
Anthropic (only when `false`), and overrides pi's default for Codex; Google and Bedrock ignore it.

### `metadata` and `prediction` — resolved

`metadata` is accepted as an arbitrary key-value record and forwarded via `onPayload`.
Open WebUI sends it with task info on every request.

`prediction` is accepted with OpenAI's `{ type: "content", content: string | TextPart[] }`
shape and forwarded via `onPayload`. Continue sends it for models that support predicted
output (speculative decoding).

Both fields are only injected for OpenAI-compatible APIs. Other providers are unaffected.

### Resilience architecture — intentional design

The proxy is a stateless translation layer, not a load balancer or API gateway. The
following are intentionally omitted:

- **No concurrency limiter**: The primary deployment model is a local proxy serving one
  client (Zed, Continue, etc.). The client controls its own concurrency. A server-side
  limiter would duplicate client logic and cause confusing double-throttling.
- **No circuit breaker**: For a single-client local proxy, a circuit breaker would
  prevent requests after upstream failures even when the upstream has recovered. The
  client already handles retries.
- **No rate limiting**: Same argument — the client controls its own request rate.
- **No retry logic**: Retries are the client's responsibility. The proxy never resends
  a failed upstream request.

Upstream overload is handled reactively:
- `mapUpstreamError()` detects rate limit (429) and overload (503/529) patterns
- A warning-level `server.chat` log line ("Upstream overloaded") is emitted for these events
- The mapped error propagates to the client as an OpenAI-style error response

If the proxy is deployed in a multi-client scenario (e.g., shared team proxy), resilience
features should be provided by an external reverse proxy (nginx, Caddy, etc.) rather
than built into this translation layer.

### Stateless architecture — no session continuity

The proxy is fully stateless. Each `POST /v1/chat/completions` request builds a fresh
`Context` from the `messages` array and discards it after the response. There is no
session persistence, no conversation memory, and no model-change detection across requests.

This is by design (matches the standard OpenAI chat completions contract), but means:
- The client is solely responsible for maintaining conversation history
- Switching models between requests is invisible to the proxy
- There is no server-side context caching or optimization

The pi SDK's stateful `AgentSession` is not used. Phase 4 (experimental agentic mode)
is intended to address this but is not started.

### API-aware payload translation

The proxy translates OpenAI request fields into the correct format for each provider API.
Fields that have no equivalent in a target API are skipped: the request succeeds and the
provider's default behavior applies. This is one of the two deliberate exceptions
`CONSTITUTION.md` principle I lists (#81); the tables below are the record of what each API gets.

#### OpenAI-compatible APIs

`openai-completions`, `openai-responses`, `azure-openai-responses`, `mistral-conversations`

All passthrough fields injected directly as flat top-level properties (same names):
`stop`, `user`, `top_p`, `frequency_penalty`, `presence_penalty`, `seed`,
`response_format`, `tool_choice`, `parallel_tool_calls`, `metadata`, `prediction`.

#### Anthropic (`anthropic-messages`)

[`docs/reference/claude-openai-compatibility.md`](docs/reference/claude-openai-compatibility.md) compares this translation, field by field, with Anthropic's own OpenAI-compatible endpoint (#143).

Fields translated to Anthropic's wire format:

| OpenAI field | Anthropic translation |
|---|---|
| `temperature` | `temperature`, by pi, only with thinking off and only to a model whose pi catalog entry neither clears `supportsTemperature` nor sets `supportsMidConvoEffort` (Claude 4.7 and later refuse a temperature below 1). Otherwise pi leaves it out; the proxy passes it to pi anyway and logs that it did not reach Claude, the first per model at `info` (constitution 3.2.0, #147) |
| `top_p` | `top_p` (same name, natively supported) |
| `stop` | `stop_sequences` (string or array → always array) |
| `user` | `metadata: { user_id }`, through pi's `metadata` option, which its Anthropic adapter sends (#48), not the payload patch |
| `tool_choice: "auto"` | `tool_choice: { type: "auto" }` |
| `tool_choice: "none"` | `tool_choice: { type: "none" }` |
| `tool_choice: "required"` | `tool_choice: { type: "any" }` |
| `tool_choice: { function: { name } }` | `tool_choice: { type: "tool", name }` |
| `parallel_tool_calls: false` | `disable_parallel_tool_use: true` on `tool_choice` |
| `seed` | Skipped (not supported) |
| `frequency_penalty` | Skipped (not supported) |
| `presence_penalty` | Skipped (not supported) |
| `response_format` | Skipped (not directly supported) |
| `metadata` (arbitrary) | Skipped (Anthropic only accepts `user_id`) |
| `prediction` | Skipped (not supported) |

#### Google (`google-generative-ai`, `google-vertex`)

Fields translated to Google's camelCase names and set flat on the payload's `config`, beside
pi's own `temperature` and `maxOutputTokens`. `@google/genai` builds the wire request's
`generationConfig` from those keys; a nested `config.generationConfig` is never read, which is
how these fields were dropped before #110.

| OpenAI field | Google translation |
|---|---|
| `top_p` | `config.topP` |
| `stop` | `config.stopSequences` (always array) |
| `seed` | `config.seed` |
| `frequency_penalty` | `config.frequencyPenalty` |
| `presence_penalty` | `config.presencePenalty` |
| `tool_choice: "auto"` | `config.toolConfig.functionCallingConfig.mode: "AUTO"` |
| `tool_choice: "none"` | `config.toolConfig.functionCallingConfig.mode: "NONE"` |
| `tool_choice: "required"` or `{ function: { name } }` | `config.toolConfig.functionCallingConfig.mode: "ANY"` |
| `user` | Skipped (not supported) |
| `parallel_tool_calls` | Skipped (not supported) |
| `response_format` | Skipped (Google uses `responseMimeType` / `responseSchema`) |
| `metadata` | Skipped (not supported) |
| `prediction` | Skipped (not supported) |

#### Codex Responses API (`openai-codex-responses`)

The Codex API is a restricted variant of the Responses API. It accepts only `tool_choice`
and `parallel_tool_calls` as passthrough fields. All other standard fields (`top_p`, `seed`,
`stop`, `user`, `frequency_penalty`, `presence_penalty`, `response_format`, `metadata`)
are rejected with "Unsupported parameter".

pi 1.3.0 sends `tool_choice: options.toolChoice ?? "auto"` and hardcodes `parallel_tool_calls:
true`. The proxy overrides both when the client sends explicit values.

| OpenAI field | Codex translation |
|---|---|
| `tool_choice` | Direct override of SDK default |
| `parallel_tool_calls` | Direct override of SDK default |
| All other passthrough fields | Skipped (rejected by Codex API) |
| `temperature` | Dropped; the first drop per model is logged at `info`, later ones at `debug` (#49). The Codex backend rejects it with `400 Unsupported parameter: temperature`, though pi 1.3.0 forwards it. A deliberate exception to "reject unsupported parameters clearly", listed in `CONSTITUTION.md` principle I (#80): a `422` would break clients that always send a temperature, on every Codex model |

#### Other APIs (`bedrock-converse-stream`)

No passthrough. These APIs use completely different payload schemas. Fields are accepted
by the proxy schema but have no effect.

## Response contract

### Non-streaming

Return an OpenAI-compatible object with:

- `id`
- `object: "chat.completion"`
- `created`
- `model`
- `choices`
- `usage`

Choice policy:

- always `choices[0].index = 0`
- emit assistant text in `choices[0].message.content`
- emit tool calls in `choices[0].message.tool_calls`
- always `choices[0].logprobs: null`: OpenAI's spec requires the field, and the proxy rejects
  `logprobs` requests (#132)
- map finish reasons conservatively

No `system_fingerprint`: OpenAI's spec types it as a string (deprecated, optional), and pi has no
value to send. It was `null` before #132, which the spec does not allow.

Finish reason mapping:

- pi `stop` -> `stop`
- pi `length` -> `length`
- pi `toolUse` -> `tool_calls`
- pi `error`, `aborted` (and pi's `pending`, `deferred`) -> `stop`, since a finish reason is
  required and OpenAI has no better fit

Do not synthesize OpenAI finish reasons that pi cannot actually distinguish, such as `content_filter`.

### Streaming

Emit standard server-sent events:

- `data: {json}\n\n`
- terminal `data: [DONE]\n\n`

Each chunk should include:

- `id`
- `object: "chat.completion.chunk"`
- `created`
- `model`
- `choices`

Chunk policy:

- emit a first delta with `role: "assistant"`
- map text deltas to `choices[0].delta.content`
- map tool call deltas to `choices[0].delta.tool_calls`
- keep a stable chunk `id` for the full streamed response

Usage policy:

- if `stream_options.include_usage` is true, emit a final chunk with empty `choices` and populated `usage`
- if the stream is interrupted, do not guarantee a final usage chunk
- `usage.prompt_tokens` is the whole prompt: Pi's uncached `input` plus cache reads and cache
  writes (Pi reports them separately, and OpenAI clients expect the whole prompt); the cached
  parts are broken out in `usage.prompt_tokens_details.cached_tokens` and `cache_write_tokens`

Reasoning policy:

- do not emit non-standard reasoning fields on the stable OpenAI-compatible path
- if reasoning streaming is exposed later, use an explicit experimental flag or namespaced extension field

## Models endpoints

### `GET /v1/models`

Return the OpenAI-compatible list shape:

```json
{
  "object": "list",
  "data": [
    {
      "id": "gpt-5.4-mini",
      "object": "model",
      "created": 0,
      "owned_by": "openai"
    }
  ]
}
```

Compatibility rule:

- keep the stable response strictly to the standard OpenAI model object fields
- do not attach capability metadata such as context window, max tokens, reasoning support, or modality support to the standard `/v1/models` path
- if richer metadata is exposed, use a separate non-standard endpoint rather than `x_pi` on the standard model object: `GET /v1/switchboard/models` (below)

Availability rule:

- distinguish between `configured` and `healthy`
- do not claim a model is healthy just because credentials are configured
- apply exposure filtering before public ID generation

### `GET /v1/models/{model}`

Return the standard OpenAI-compatible model object:

- `id`
- `object: "model"`
- `created`
- `owned_by`

Resolution rule:

- resolve within the currently exposed model set only
- accept exact public IDs first
- accept canonical IDs only as backward-compatible aliases for models that remain exposed

### `GET /v1/switchboard/models`

Not part of OpenAI's API: what pi knows about each exposed model that the standard model object has no field for. Same exposure filtering and public IDs as `GET /v1/models`, behind proxy auth like every `/v1/*` route.

```json
{
  "object": "list",
  "data": [{ "id": "claude-sonnet-4-5", "reasoning_efforts": ["none", "minimal", "low", "medium", "high"] }]
}
```

- `reasoning_efforts`: the `reasoning_effort` values the model runs at as asked, lowest first, from pi's `getSupportedThinkingLevels` (`off` is `none`, and every other level the effort of the same name, `max` included). `["none"]` for a model without reasoning
- new capability fields go here, never on `/v1/models`
- non-standard routes live under `/v1/switchboard/`, as `/v1/switchboard/agent/completions` would. The prefix was `/v1/pi/` until constitution 2.0.0; `/v1/pi/models` moved here with no alias

## Error contract

Use an OpenAI-style shape:

```json
{
  "error": {
    "message": "...",
    "type": "...",
    "param": "...",
    "code": "..."
  }
}
```

### Error mapping

- `400` invalid JSON, invalid request shape or value, unsupported or invalid content part
  (remote image URL while `remoteImages` is off, or one it refused; audio, file, bad data URI); or the conversation is longer than the model's
  context window (`invalid_request_error`, `param: "messages"`, `context_length_exceeded`, as
  OpenAI answers it); or the provider refused the request as invalid, its 400 or 422
  (`invalid_request_error`, `upstream_invalid_request`, #147)
- `401` proxy auth failure or no upstream credential for target provider
- `404` model not found (`model_not_found`): no exposed model has the ID, or the provider refused
  the model for the login the proxy uses (#156); an unsupported endpoint, or any other route
  (`Invalid URL (<METHOD> <path>)`)
- `413` request body larger than `maxBodySize`
- `422` unknown or rejected parameter, unsupported tool schema (`unsupported_parameter`)
- `429` upstream rate limit (`rate_limit`)
- `500` internal proxy failure, including an invalid model exposure config
- `502` upstream auth failure (`upstream_auth_error`), or any other upstream failure
  (`upstream_error`), such as an upstream 404 or 500
- `503` provider unavailable (`provider_unavailable`, upstream 503) or overloaded
  (`provider_overloaded`, upstream 529)
- `504` upstream timeout (`timeout`): an upstream 408 or 504, or the provider sent nothing for
  `upstreamTimeoutMs` (an idle timeout that restarts on every upstream event, raw provider events included (#50), not a cap on the call;
  `src/pi/upstream-idle.ts`)

Upstream failures (`mapUpstreamError`, `src/server/errors.ts`): pi reports a failure as text, with
no structured status (`onResponse` fires only for successful responses). The provider's HTTP status
is read from the fixed positions pi 1.3.0's messages put it in: leading, and only when followed by
what only a status is followed by (`429: {…}`, `429 {…}`, `429 "…"`, `429 status code (no body)`;
`429 tokens…` is not a status), after a label (`OpenAI API error (429): …`, `Mistral API error
(429): …`), Google's `got status: 429.` or its error body's `error.code`. When a status is found it
decides; the wording (`rate limit`, `too many requests`, `timed out`, `overloaded`,
`service unavailable`, …, checked in that order) is consulted only when no status is reported
(Bedrock, network failures, the proxy's own idle timeout), and a number elsewhere in the text never
counts (#42). The client gets a fixed message and code, never the upstream text. A missing or broken
upstream credential is refused with `401` before any response starts, streamed or not
(`checkRequestAuth`).

Context overflow (#40): `mapFailedCall` runs pi's `isContextOverflow` on the failed call's final
message, which recognizes overflow wording from about 15 providers (Anthropic, OpenAI, Google,
Bedrock, Mistral, OpenRouter, …), before the status mapping. A reported status other than 400 or 413
rules it out, so a 429 that says "too many tokens" stays a rate limit. A provider that accepts an
over-long prompt and answers anyway (input beyond the context window, or a `length` stop with no
output) is not an error: the answer goes to the client and a warning is logged.

Provider rejections (#147, #128 item 5): an upstream 400 or 422 that is not a context overflow is
the provider refusing a field the client sent, such as Claude's `top_p` on 4.7 and later, a forced
`tool_choice` on Claude 5.x, or a whitespace-only stop sequence. It answers `400
invalid_request_error`, code `upstream_invalid_request`, with fixed text ("The provider rejected
the request as invalid. Check the fields this model accepts."), so a client does not retry a
request that cannot succeed. The provider's own message stays out of the response, as it can quote
the request, and reaches the log at `debug` only; the route's line for it is a warning, not an
error. An upstream 401 or 403 is still `upstream_auth_error` (#128 item 3 decides it), and so is a
400 whose wording is about credentials (an API key, authentication, an access token): Google
answers a bad API key with `400 INVALID_ARGUMENT`, which the client cannot fix. The wording check
reads the provider's whole message, which can quote the request, so a refusal that quotes a prompt
mentioning an API key would answer `502 upstream_auth_error` too; that errs toward the operator.

A model the provider login cannot use (#156): pi's Codex catalog lists models a ChatGPT plan does
not include, and the proxy exposes what pi lists, so a request reaches Codex, which refuses it with
"The '<model>' model is not supported when using Codex with a ChatGPT account." It arrives as a
WebSocket stream event with no status (or a 400), so the proxy recognizes it by that wording and
answers `404 invalid_request_error`, code `model_not_found`, `param: "model"`, with fixed text ("The
model is not available with the provider login the proxy uses. Choose another model."). That is
OpenAI's answer for a model an account cannot use, and agent clients move on to another model on
it; a 502 read as an outage and was retried. The wording is Codex's own and could change: if it
does, the refusal is a 502 again. The route logs it as an error, as the operator can fix it by
hiding the model (README, "Exposure modes"). Live, Codex refuses before pi's first event, so a
stream gets the 404 too; a stream that has started gets the same body as its error event.

A streaming request is not answered until pi's first event. pi's adapters emit `start` only once the
provider has accepted the request, so a failure before it (an overflow, a rate limit, bad
credentials, a provider that never answers) gets its HTTP status and JSON body, as OpenAI answers a
streaming request it refuses. Once the stream has started its status is `200`, and a failure ends it
with an error event carrying the same mapped `{ message, type, param, code }` as the non-streaming
answer, then `[DONE]` (#54). A client that leaves during the wait is not logged as an upstream
failure. The raw upstream text is logged at debug only, in all paths.

Error rules:

- never leak secrets in errors
- preserve useful parameter names in `param` where possible
- log upstream request IDs when available

## Security boundaries

### Image URL fetching

Off by default. With `remoteImages` on (`PI_SWITCHBOARD_REMOTE_IMAGES`, `--remote-images`, the
settings panel), the chat route downloads each remote `image_url` before message conversion
(`src/openai/remote-images.ts`) and puts it back as a base64 data URI, because pi accepts images
only as data. Off, a remote URL is rejected with `400`. The fetch (`src/openai/remote-image-fetch.ts`)
is a request the proxy's host makes for a client, so every hop is held to:

- **Scheme:** `http` and `https` only.
- **Addresses:** the host is resolved to all its addresses (a literal IP is taken as is), and one
  address that is not public refuses the host: loopback (`127.0.0.0/8`, `::1`), private
  (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`), link-local (`169.254/16` with the
  `169.254.169.254` metadata address, `fe80::/10`), carrier-grade NAT (`100.64/10`), unspecified
  (`0.0.0.0`, `::`), multicast, and reserved ranges (`0/8`, the documentation and benchmarking
  ranges, `240/4` with broadcast). IPv4-mapped IPv6 addresses are checked as the IPv4 address they
  carry; the transition prefixes that embed one another way (IPv4-compatible `::/96`, NAT64,
  6to4, Teredo) are refused outright.
- **No DNS rebinding:** the socket's `lookup` returns only the addresses that were checked, so a
  second DNS answer cannot redirect the connection; the Host header and the TLS server name and
  certificate check stay on the URL's host name. Each fetch opens a fresh connection (no pooled
  socket).
- **Redirects:** followed by hand, at most 3; each target is checked again (scheme and addresses).
- **Time:** 5 seconds to connect, 10 seconds for the whole fetch with its redirects.
- **Size:** at most 15 MiB, the most whose base64 fits the 20 MiB data URI limit; counted while the
  body streams, and the connection is dropped as soon as it passes (a declared `content-length`
  over the cap is refused before reading).
- **Type:** the response `content-type`, without parameters, must be `image/png`, `image/jpeg`,
  `image/gif` or `image/webp`; an empty body is refused.
- **Count:** at most 8 remote images per request, checked before any fetch. A request's images are
  fetched together; the first refusal cancels the rest, and so does the client disconnecting.
- **Memory:** the images of one request share a budget of 15 MiB in all (one full-size image, or
  several smaller ones), drawn down while their bodies stream; past it the fetch is dropped and the
  request refused. Without it, 8 full-size images would hold about 120 MiB, and twice that in
  base64, for one request. Concurrent requests each have their own budget.
- **Credentials:** a plain GET with the proxy's user agent; no client header, cookie or
  `Authorization` is forwarded.

Images are fetched only after the model's upstream credential is checked (`checkRequestAuth`): a
request that cannot reach the provider gets its `401` without the proxy fetching anything.

A refusal answers `400` `invalid_request_error` at that part's `param` with a fixed message per
reason; it never quotes the remote server's response. The reasons differ, though (`blocked`,
`unresolvable`, `timeout`, …), so a client that may fetch can learn whether a host name resolves
to an internal address. That is accepted for an opt-in feature on a local-first proxy; a deployment
that exposes the proxy with remote images on should keep proxy auth on. Each fetch logs one line
under `openai.images` (host, status, bytes, duration; never the full URL, whose query can carry a
token), and a refusal logs a warning naming the reason. The address policy, resolver and limits
are parameters of the fetch (`createApp`'s `remoteImageFetch`) so tests can reach a local server;
no setting loosens them.

### Container image

The `Dockerfile` builds the proxy from this repository's source (#60), replacing number-5's
private build from a release tarball. pi comes only through the proxy's own lockfile, so the login
command and the server run the same pi on one `auth.json`.

- **Token guard in the image, not the proxy.** The image binds `0.0.0.0`, so its entrypoint
  (`docker/entrypoint.sh`) refuses to start without `PI_SWITCHBOARD_AUTH_TOKEN`, exiting `64`
  before it listens. The proxy itself still only warns when it binds off loopback with auth off.
  Moving the refusal into the proxy would change auth semantics for every non-container user, so
  it stays an image rule (#60, "Decision needed"); the token comes from the environment only.
- **Writes only to the volume.** UID 1000, `/app` owned by root, and in `compose.yaml` a
  read-only root filesystem, `/tmp` as tmpfs, `cap_drop: ALL` and `no-new-privileges`. pi's login
  and its refreshes, and the proxy's `proxy-config.json`, live in the volume at
  `PI_CODING_AGENT_DIR=/home/node/.pi/agent`. The volume is never seeded from a host `auth.json`,
  since a refresh rotates the refresh token under the other copy.
- **No install scripts.** Dependencies install with `--ignore-scripts`. The build output is
  JavaScript, built once on the builder's platform; production dependencies install on the target
  platform, as some ship per-platform binaries. Source maps, type declarations and TypeScript
  sources are deleted from them, since none is executed: 398 MB to 314 MB unpacked, 101 MB to
  91 MB to pull (2026-10-21).
- **Base: `node:<version>-bookworm-slim`.** Alpine was measured as well: pruned, 73 MB to pull and
  252 MB unpacked. It was not taken, because the 18 MB saved is not worth musl (pi's TUI ships
  glibc-only native prebuilds) or the risk of a future native dependency without a musl build.
- **Published once per version, to two registries.** The release workflow's `image` job calls
  `image.yml` with each new release tag. It builds that tag for `linux/amd64` and `linux/arm64`
  and pushes the same image, in one push, as `vxdaniel/pi-switchboard:<version>` on Docker Hub
  (what the docs lead with: the short name) and `ghcr.io/vx-daniel/pi-switchboard:<version>` on
  GHCR (linked to this repository; GitHub documents no pull limit for public images, and Docker
  Hub allows 100 anonymous pulls per 6 hours per IP address). It refuses a tag already published
  on either registry, and any registry error other than "not found", so a version always means
  one image. There is no `latest`. The multi-platform manifest is pushed last, so a failed run
  publishes nothing; run `image.yml` by hand with the tag to publish a release whose image is
  missing.
- **Registry setup, once.** Docker Hub needs the `DOCKERHUB_TOKEN` repository secret, a
  `vxdaniel` access token with read and write access. Without it the image job fails before
  pushing anywhere. Turn on immutable tags on the Docker Hub repository, so the registry enforces
  what `image.yml` checks (on since 2026-10-21). GitHub's docs say a new package starts private,
  but the GHCR package was public from its first publish, 0.1.0: anonymous `docker pull` worked at
  once, presumably because it is linked to this public repository. If a package ever turns up
  private, set it public in the package settings (a public package cannot be made private again).
- **Port published on loopback.** Compose publishes `127.0.0.1:4141` only, keeping the
  local-first default for the host.

### pi package

The pi package, `@vx-daniel/pi-switchboard` (the CLI, the library entry points and the extension),
is published to GitHub Packages' npm registry (#59), not npmjs: the maintainer is not ready to
share it widely. npmjs comes later, by choice.

- **Published once per version.** The release workflow's `package` job calls `package.yml` with
  each new release tag. It builds that tag with the frozen lockfile and runs
  `pnpm publish --ignore-scripts` with `GITHUB_TOKEN`. pnpm rewrites the `catalog:` specs and
  drops `prepare`. Scripts are off because the release gate already tested that commit. The
  registry refuses a version twice. Run `package.yml` by hand with a tag to publish a release
  whose package is missing.
- **Installing needs a token.** GitHub Packages requires a classic personal access token with
  `read:packages` to install any package, public ones included, unlike GHCR. Every user sets the
  `@vx-daniel` scope and the token in `~/.npmrc` once (README, "Installation").
- **Ruled out, tested with pi 1.3.0:**
  - `pi install git:github.com/vx-daniel/pi-switchboard` clones `dev` and runs
    `npm install --omit=dev`. `dist/` is not in git, and `prepare` needs the dev dependencies,
    which that leaves out.
  - A release tarball as a URL (`npm:https://…/x.tgz`) installs and is listed, but pi takes the
    whole URL for the package name, looks under `node_modules/<url>`, and never loads the
    extension.
  - By package name, pi finds the package, and `/proxy start` runs the installed
    `dist/index.mjs`.
- **pi warns at load** that `@earendil-works/pi-ai`, `pi-coding-agent` and `pi-tui` should be
  `peerDependencies` with `*`. The extension loads all the same, and moving them is not a plain
  fix: the proxy the extension starts imports pi in its own process, and pi installs packages with
  `--legacy-peer-deps`, which skips peers.

### Agentic mode

Later, not planned (ROADMAP "Later, not planned"). Agentic mode is experimental and not built.
`PI_SWITCHBOARD_AGENTIC=true` sets a flag that only the startup log reads.

Security defaults for any future agentic mode:

- disabled by default
- explicit opt-in
- tools on an allowlist
- `cwd` controlled by server policy or strict allowlist
- extension loading disabled by default

## Internal architecture

Module layout:

```text
src/
├── index.ts            -- entry point, CLI bootstrap (citty)
├── env.d.ts            -- typed process.env
├── config/
│   ├── schema.ts         -- ProxyConfig Zod schema and types, defaults, repair, JSON I/O (exported via ./config)
│   └── env.ts            -- ServerConfig from file + env + CLI overrides
├── logging/
│   └── index.ts          -- LogTape setup, categories, level guide, redaction (exported via ./logging)
├── server/
│   ├── app.ts            -- Hono app assembly (middleware + routes)
│   ├── routes.ts         -- GET /v1/models, GET /v1/models/:model, GET /v1/switchboard/models, POST /v1/chat/completions
│   ├── health.ts         -- GET /healthz, /healthz/models, /healthz/creds
│   ├── middleware.ts     -- request-id, proxy-auth, body size limit, disconnect detection
│   ├── errors.ts         -- OpenAI-style error helpers, upstream error mapping
│   ├── request-id.ts     -- piproxy-{random} generation
│   ├── http-status.ts    -- named HTTP status codes
│   └── types.ts          -- Hono ProxyEnv type
├── openai/
│   ├── schemas.ts              -- Zod v4 request schemas
│   ├── validate.ts             -- request validation with rejected-field checks
│   ├── messages.ts             -- OpenAI messages -> pi Context
│   ├── remote-images.ts        -- remote image URLs -> data URIs, before conversion (remoteImages on)
│   ├── remote-image-fetch.ts   -- one SSRF-safe image fetch: address policy, pinned DNS, limits
│   ├── model-exposure.ts       -- exposure engine: filtering, public IDs, resolution (exported via ./exposure)
│   ├── models.ts               -- ExposedModel -> OpenAI model object
│   ├── reasoning-effort.ts     -- reasoning_effort -> pi thinking level
│   ├── responses.ts            -- pi AssistantMessage -> OpenAI ChatCompletion
│   ├── sse.ts                  -- pi events -> SSE ChatCompletionChunk frames
│   ├── tools.ts                -- OpenAI function tools -> pi Tool[]
│   └── json-schema-to-typebox.ts -- JSON Schema -> TypeBox conversion
├── pi/
│   ├── registry.ts       -- ModelRuntime + SettingsManager init
│   ├── complete.ts       -- ModelRuntime streamSimple bridge
│   ├── model-scope.ts    -- port of pi's enabledModels pattern resolver
│   └── upstream-idle.ts  -- upstream idle timeout, relayed over pi's event stream
├── sync/
│   └── zed.ts            -- Zed settings.json model sync
└── utils/
    └── guards.ts         -- isRecord() and other type guards

### Dead code

`src/pi/resolve-model.ts`, superseded by `src/openai/model-exposure.ts` in Phase 3A, has been
removed.

### Scaling notes

`routes.ts` is the sole composition root. The chat route validates its body and header with hono-openapi's `validator()`, then `handleChatCompletion` drives the helpers (`inlineImages`, `buildPiContext`, `checkRequestAuth`, `streamChat`, `completeChat`). This is manageable for the current surface but should be decomposed before a second completion route (the Responses API, #140) or routing middleware (#66–#70) is added.

The pi extension lives in `extensions/proxy/`, isolated from the core proxy. pi loads `index.ts` (the `/proxy` command family and lifecycle hooks) as the single extension; the sibling modules split the rest: `state.ts` (shared config/registry state), `process.ts` (PID file, probe, start/stop/status), `reports.ts` (show/models/verify), `zed-sync.ts`, `settings-panel.ts`, and `model-selector.ts`. Add new extension modules there rather than as top-level files in `extensions/`, which pi would load as separate extensions.

The proxy has no concurrency controls. Node's runtime handles request parallelism, but
there are no semaphores, connection pools, or circuit breakers protecting upstream
providers. This is acceptable for local single-user use but would need addressing for
any multi-user or high-concurrency deployment.

## Delivery phases

### Phase 0 — Contract lock [DONE]

Before runtime work:

- freeze model ID strategy
- freeze auth override strategy
- freeze streaming chunk contract
- freeze error contract
- freeze initial parameter support matrix
- freeze image-fetch security policy
- mark agentic mode experimental

Deliverable:

- this plan file
- aligned `ROADMAP.md`
- aligned `TODO.md`

### Phase 1 — Stable core proxy [DONE]

Build:

- project scaffolding (Bun, Hono, Zod v4, tsdown, Biome, oxlint, lefthook, commitlint); Bun, Biome and lefthook since replaced by Node and Vite+ (see "Tooling and type safety")
- `ModelRuntime` integration
- model resolution (canonical + shorthand with ambiguity detection)
- `GET /v1/models`
- `GET /v1/models/{model}` with encoded slash support
- non-streaming chat completions via `ModelRuntime.streamSimple()`'s final message
- streaming chat completions via `ModelRuntime.streamSimple()`
- request IDs and structured logging
- disconnect cancellation via AbortController
- OpenAI-style errors

Release gate:

- unit tests for mapping logic
- integration tests for models and validation
- no unsupported parameters silently accepted, beyond the exceptions `CONSTITUTION.md` principle I lists
- zero oxlint errors, zero biome errors (today: `pnpm run check:all` with zero lint warnings; Biome is gone)
- typecheck passes with ultra-strict tsconfig

### Phase 2 — Tools and richer compatibility [DONE]

Build:

- OpenAI function tools subset (JSON Schema -> TypeBox for supported subset)
- tool-call message roundtrip (assistant tool_calls + tool role results)
- `stream_options.include_usage` (final usage chunk in SSE)
- base64 image inputs (remote URLs rejected by default)
- `reasoning_effort` (mapped to pi ThinkingLevel)
- passthrough parameters: `top_p`, `frequency_penalty`, `presence_penalty`, `seed`, `response_format`

Deliverable:

- `src/openai/json-schema-to-typebox.ts` — JSON Schema -> TypeBox conversion
- `src/openai/tools.ts` — OpenAI function tools -> pi Tool definitions
- updated `src/openai/schemas.ts` — Phase 2 fields added to request schema
- updated `src/pi/complete.ts` — reasoning_effort + passthrough parameters
- unit tests for JSON Schema conversion and tool acceptance/rejection
- integration tests for tool validation

Release gate:

- tool schema tests pass
- tool streaming already wired in Phase 1 SSE module
- remote image security deferred (disabled by default)

### Phase 3 — Hardening and packaging [DONE]

Build:

- request body limits
- timeout defaults
- graceful shutdown
- compatibility smoke tests with real clients
- CI gates for typecheck, lint, test
- npm packaging

Release gate:

- compatibility smoke tests pass for target clients
- logs and trace IDs are stable
- no known security policy gaps remain for stable features

### Phase 3A — Model exposure and identifier controls [DONE]

Build:

- standardize `/v1/models` and `/v1/models/{model}` to the minimal OpenAI model object
- remove `x_pi` from the standard models path
- add shared model-exposure computation with public-ID generation and reverse lookup
- add configurable public ID modes: `collision-prefixed`, `universal`, `always-prefixed`
- add configurable exposure modes: `all`, `scoped`, `custom`
- add provider prefix overrides with explicit uniqueness validation
- restrict model resolution to the exposed set for models listing, detail lookup, and chat requests
- preserve canonical-ID backward compatibility only for models that remain exposed
- refactor the Pi extension toward a controller-backed config flow
- add `/proxy verify` and model-exposure preview to the command family
- add focused selector UIs for scoped providers and custom model selection

Deliverable:

- shared model-exposure module used by models endpoints and chat resolution
- shared config schema extended with exposure controls
- updated settings panel and `/proxy` command family
- route and integration tests covering exposure modes and ID modes
- documentation aligned to the new public ID policy

Release gate:

- public model IDs are unique under every valid configuration
- invalid `universal` mode and invalid prefix collisions fail validation explicitly
- hidden models are not reachable by canonical fallback
- `/v1/models` stays standard OpenAI shape with no capability extensions
- typecheck, lint, and tests pass

### Phase 3B — SDK conformance and robustness testing

Status: the pre-work and every deliverable file below exist. The SDK tests run the `openai` SDK
against the in-process Hono app, without `_strict_response_validation`.

Validate that the proxy produces responses the official OpenAI SDK can parse without errors. This is the single highest-value test investment because it catches the exact field-level bugs that break real clients (Open WebUI, Continue, Aider).

There is no standard conformance test suite for OpenAI-compatible APIs. Every project (LiteLLM, vLLM, Ollama) rolls its own. The approach here uses the official `openai` Node SDK (v6+) as a client with strict response validation enabled.

Pre-work:

- remove dead `src/pi/resolve-model.ts` and its test
- add `openai` as an explicit devDependency (currently transitive via pi-ai)

Build:

**Wire-level SSE conformance (no credentials needed)**

Validate the exact SSE frame format against the `ChatCompletionChunk` contract using mock `AssistantMessage` / `AssistantMessageEvent` objects:

- each chunk has `id`, `object: "chat.completion.chunk"`, `created` (number), `model`
- `delta.role` is `"assistant"` on first chunk only
- `delta.content` is a string (never `undefined` when text is present)
- `finish_reason` is `null` on intermediate chunks, then `"stop"` / `"length"` / `"tool_calls"` on the final content chunk
- tool call delta chunks: `delta.tool_calls[n].index`, `.id`, `.type`, `.function.name`, `.function.arguments` are present and well-typed
- usage chunk: `choices` is an empty array, `usage` has `prompt_tokens`, `completion_tokens`, `total_tokens` as numbers
- final line is `data: [DONE]\n\n`

**Non-streaming response conformance (no credentials needed)**

Validate the exact `ChatCompletion` shape from `buildChatCompletion` output:

- required fields: `id`, `object: "chat.completion"`, `created`, `model`, `choices`, `usage`
- `choices[0].finish_reason` is never `null` (unlike streaming)
- `choices[0].message.role` is `"assistant"`
- `choices[0].message.content` is `string | null` (explicitly `null` when tool_calls present, not `undefined`)
- `choices[0].message.tool_calls` shape includes `id`, `type: "function"`, `function.name`, `function.arguments`
- `usage.prompt_tokens`, `usage.completion_tokens`, `usage.total_tokens` are all numbers

**SDK round-trip conformance (requires one API credential)**

Use `new OpenAI({ baseURL, apiKey: "dummy" })` with `_strict_response_validation: true` against the running proxy:

- `client.models.list()` succeeds and returns iterable model objects
- `client.models.retrieve(id)` succeeds for an exposed model
- `client.chat.completions.create({ stream: false })` -- simple text completion
- `client.chat.completions.create({ stream: true })` -- streaming text, collect all chunks
- `client.chat.completions.create({ tools })` -- non-streaming tool call
- `client.chat.completions.create({ stream: true, tools })` -- streaming tool call
- `client.chat.completions.create({ stream: true, stream_options: { include_usage: true } })` -- usage chunk

These tests skip gracefully when no credentials are available.

**Security tests (no credentials needed)**

- blocked localhost image URL returns error
- blocked private-range image URL returns error
- oversized image payload rejected

Deliverable:

- `test/unit/sse-conformance.test.ts` — wire-level SSE validation
- `test/unit/response-conformance.test.ts` — non-streaming shape validation
- `test/unit/security.test.ts` — image URL blocking
- `test/conformance/helpers.ts` — SDK client factory, skip-if-no-auth
- `test/conformance/sdk-models.test.ts` — SDK models endpoint tests
- `test/conformance/sdk-chat.test.ts` — SDK non-streaming chat
- `test/conformance/sdk-streaming.test.ts` — SDK streaming chat
- `test/conformance/sdk-tools.test.ts` — SDK tool call tests

Release gate:

- all SSE conformance tests pass without credentials
- all response conformance tests pass without credentials
- all security tests pass without credentials
- SDK conformance tests pass when credentials are available, skip cleanly otherwise
- the `openai` Node SDK with `_strict_response_validation: true` parses every response without errors
- typecheck, lint, and tests pass

### Later, not planned — experimental agentic mode

Kept as a design note. The phases after the rename (Distribution, Routing, More of OpenAI's API)
are in `ROADMAP.md`; if agentic mode is picked up, it needs:

- explicit agentic endpoint or explicit opt-in header
- `AgentSession` event bridge
- session persistence and resume
- strict cwd policy
- extension allowlist

Recommendation:

- prefer a separate endpoint such as `/v1/switchboard/agent/completions` instead of overloading the stable OpenAI-compatible route

## Observability

Logging is LogTape (`src/logging/index.ts`, whose header defines the categories, the level guide and
what must never be logged). The CLI writes to stderr at `--log-level` / `PI_SWITCHBOARD_LOG_LEVEL` /
`logLevel` (default `info`), as pretty lines in local time (the system zone, `TZ` in a container)
on a TTY and JSON Lines with a UTC `@timestamp` otherwise; `--log-format` / `PI_SWITCHBOARD_LOG_FORMAT`
(`pretty`, `json`) overrides that choice. Passing `/healthz` checks log at `debug`. The pi
extension logs to a file only when `PI_SWITCHBOARD_EXTENSION_LOG_FILE` is set.

A JSON line's `message` keeps LogTape's rendering, which quotes every string value
(`Listening on http://"0.0.0.0":4141`). This is deliberate (#159): values such as the requested
model, a path or `X-Client-Request-Id` come from clients, and the quotes keep a crafted one from
passing for message text. JSON encoding already keeps a value from forging a second line
(`test/unit/logging.test.ts`, "keeps a property containing a newline on a single line").
`properties` carries the values unquoted for anything that parses logs. People reading by eye use
`pretty`, which prints values bare. Bare strings in JSON, and template-only messages, were
considered and not taken.

Minimum production observability:

- generated proxy request ID, carried by every log line a request causes (`withContext`)
- accepted `X-Client-Request-Id`
- upstream request ID capture where available (not built: the proxy logs and returns only its own
  request ID, as `x-request-id`)
- one `server.http` line per request and per response (status, duration)
- a `server.chat` "Chat request for … resolved to …" line, written once the model has resolved,
  with the requested model, the resolved canonical `provider/id`, the provider and the stream mode
  (ids and flags only: never message content or credentials; not written when the model is not
  found)
- disconnect and abort logging
- usage logging when available (today only the non-streaming total, at `debug`)

## Test strategy

### Unit tests

- role and content mapping
- finish reason mapping
- usage mapping
- error mapping
- JSON Schema -> TypeBox conversion (supported subset and rejected keywords)
- OpenAI function tool -> pi Tool conversion
- model-exposure filtering, public ID generation, conflict groups

### Conformance tests — wire-level (no credentials)

Validate the exact response shapes that the OpenAI SDK expects. These are the highest-value offline tests because field-level mistakes (wrong type, missing field, `undefined` vs `null`) silently break real clients.

- SSE chunk conformance: required/optional fields, `delta` shape, `finish_reason` lifecycle, tool call deltas, usage chunk, `[DONE]` termination
- non-streaming response conformance: `ChatCompletion` required fields, `message.content` nullability, `tool_calls` shape, `usage` fields
- OpenAI spec conformance (#132): every stable response, stream chunk and error body validated against the pinned OpenAI spec ([Reference spec](#reference-spec)), and the request schema checked against OpenAI's request in both directions

### Conformance tests — SDK round-trip (require credentials)

Use the official `openai` Node SDK as client, routed into the in-process Hono app by a custom `fetch` (`test/conformance/helpers.ts`), so the SDK's own response parsing runs against the proxy's shapes. `_strict_response_validation` is not set. vLLM takes a similar approach (Python SDK against their server).

- `client.models.list()` and `client.models.retrieve()`
- non-streaming text completion
- streaming text completion
- non-streaming and streaming tool calls
- `stream_options.include_usage` usage chunk

Skip gracefully when no credentials are available (CI without auth).

### Security tests (no credentials)

- with `remoteImages` off, every remote image URL (localhost, private range, public) rejected
  with `400` before any upstream call (`test/unit/security.test.ts`)
- oversized base64 payload, unsupported image MIME type, malformed data URI rejected
- the remote image address policy (allowed and blocked IPv4/IPv6, IPv4-mapped forms), and each
  fetch safeguard against a local server: size cap while streaming, content type, redirects to a
  blocked address, redirect count, deadline, scheme, pinned DNS, no client headers
  (`test/unit/remote-image-fetch.test.ts`)
- through the chat route: off by default, a loopback URL blocked with nothing fetched, a fetched
  image reaching the provider as base64, the per-request cap (`test/integration/remote-images.test.ts`)

### Integration tests

- `GET /v1/models` shape
- `GET /v1/models/{model}` with encoded IDs
- chat completions validation and rejection
- tool acceptance and unsupported schema rejection
- model-not-found flow
- proxy auth enforcement
- unsupported endpoint rejection

### Compatibility smoke tests

Target at least:

- `curl`
- Open WebUI
- Continue
- Aider

## Acceptance criteria

The implementation is production-ready for the stable proxy only if all of the following are true:

- `GET /v1/models` returns an OpenAI-compatible list shape using only standard model object fields
- `GET /v1/models/{model}` supports encoded slash-containing IDs
- public model IDs are unique under the active exposure configuration
- canonical fallback does not bypass exposure filtering
- non-streaming chat completions return OpenAI-compatible payloads
- streaming returns valid SSE chunks followed by `[DONE]`
- final usage chunk behavior matches the documented `stream_options.include_usage` contract
- the official `openai` Node SDK with `_strict_response_validation: true` parses every response without errors
- SSE conformance tests validate chunk shapes, `finish_reason` lifecycle, and tool call deltas
- response conformance tests validate `content` nullability and `tool_calls` shape
- unsupported fields are rejected clearly
- secrets are never logged
- client disconnects abort upstream work
- request IDs are logged consistently
- supported tool schemas roundtrip correctly
- no dead code in production `src/` tree
- stable features pass unit, conformance, integration, and security tests
- zero oxlint errors and warnings, typecheck clean (`pnpm run check:all`)
