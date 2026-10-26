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
  route (#66–#70) and several logins per provider (#227), under constitution principle VI
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
- **CI** (`.github/workflows/`): `ci.yml` (`gate` on pull requests into `dev`/`main` and pushes to `dev`, and beside it `binary`, which builds and tests the standalone binary with Bun), `secret-scan.yml` (gitleaks, new commits only, every branch), `claude-pr-review.yml` (manual), `publish.yml` (the release, run by hand on `main`, then `image.yml`, `package.yml` and `binary.yml` for the new tag)
- **commitlint**: conventional commits via `@commitlint/config-conventional`
- **Releases**: `publish.yml`, run by hand on `main` with the version the maintainer picks from the commit types since the last release. It bumps `package.json`, gates that commit, pushes it with its `pi-switchboard-v<version>` tag, and creates the GitHub release with notes generated from the merged pull requests; the image, the package and the binaries are published from the tag by `image.yml`, `package.yml` and `binary.yml`. GitHub Releases are the changelog; `CHANGELOG.md` stops at 0.4.0, the last release semantic-release made

## API compatibility policy

### Stable surface

The routes covered by constitution principle I, the one list of them (AGENTS.md and
`docs/api.md` link here). Each one meets principle I's criteria: an OpenAI-defined route, checked
against the pinned spec, described in `openapi.json`, documented in `docs/api.md` and here.

| Route | Since | Decision |
|---|---|---|
| `GET /v1/models` | Phase 1 | original contract |
| `GET /v1/models/{model}` | Phase 1 | original contract |
| `POST /v1/chat/completions` | Phase 1 | original contract |

Experimental, outside this table: `POST /v1/responses` (#140), opt-in (`responsesApi`, off by
default), described in `openapi.json` and checked against the pinned spec
(`test/integration/openai-spec-responses.test.ts`); see "Experimental: the Responses API" below.
It is promoted here once it has had real use (Codex CLI is the follow-up client). Adding or removing a row is a decision recorded in this table, with its issue, and a
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

- the stable routes, `GET /v1/switchboard/models`, `GET /v1/switchboard/usage` and
  `DELETE /v1/switchboard/cooldowns`, with their request and response schemas, error statuses and
  the bearer scheme;
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
3. exact alias match (#66, below)

Canonical fallback is only allowed for models inside the current exposed set.
Hidden models must not become reachable through canonical fallback, nor through an alias.

Do not rely on the old registry-wide shorthand ambiguity rules on the public HTTP surface.
The public model list itself defines the valid request IDs.

### Aliases (#66)

`aliases` in `proxy-config.json` maps a name to an exposed model's canonical ID, or to a fallback
chain (#67, below), the routing controls under constitution principle VI.
`src/openai/model-aliases.ts` (`exposeAliases`) runs inside `computeModelExposure`, after the
public and canonical IDs are built:

- **Exposed only while the target is.** The target is looked up among the exposed models by
  canonical ID, so an alias never reaches a hidden model (principle IV). An alias whose target is
  not exposed is left out with a `target-not-exposed` diagnostic. That is not a failure: leaving a
  model out of `enabledModels` is how scoped mode hides it.
- **Never shadows a model.** An alias named like an exposed public or canonical ID is left out
  with a `shadows-model` diagnostic, and the model keeps its name. It is not an exposure error
  (`ok: false`), which would answer every request with 500; `/healthz/models` answers 503 and
  lists it, and one warning is logged per distinct set. Resolving aliases last is a second guard.
- **Listed as its target under the alias.** Each exposed alias is an `ExposedModel` with
  `publicId` set to the alias and `alias` set, so `/v1/models`, `/v1/models/{alias}` and
  `/v1/switchboard/models` list it after the models (`owned_by` and `reasoning_efforts` are the
  target's). `exposure.models` and its count stay the real models.
- **Visible in the response and the log (principle VI).** `model` stays the target's canonical
  ID. `x_pi.alias` carries the alias, in a non-streamed response and in every stream chunk, and
  only when the request named one, so a request without an alias is unchanged. The chat request
  log line adds `alias`. The login is the provider in the canonical ID (Accounts, #227).
- **Verbatim.** Names and targets are never trimmed; an empty name or target is dropped by the
  config repair.

### Fallback chains (#67)

An alias value `{ targets: [...], fallbackOn: [...] }` tries its targets in order. `fallbackOn` is
required, and names the failure classes (`FailureClassSchema`, `src/config/schema.ts`) that move to
the next target, because principle VI allows fallback only on failures the configuration names.
A string alias, and a request that names a model, never fall back.

- **Exposure.** `exposeAliases` keeps the chain's exposed targets in order (`ExposedModel.route`)
  and lists the alias as the first of them. Each hidden target gets a `target-not-exposed`
  diagnostic, and the alias is left out only when none is exposed.
- **Dispatch** (`src/server/chat-dispatch.ts`):
  - `planRoute` picks the candidates. An image request skips text-only targets when another takes
    images. A request with `X-Switchboard-Upstream-Api-Key` keeps only the first target, because
    the key is one provider's and must not reach another.
  - `findCredentialedStart` checks credentials in order before remote images are fetched (#109),
    moving past a target only if `auth` is named.
  - `dispatchChat` gives each candidate one attempt. A failure before the response starts (for a
    stream, before pi's first event, as `streamChat` always waited for) is classed by
    `failureClass` from the mapped answer:

| Answer | Class |
|---|---|
| 429 | `rate_limit` |
| 503 (and 529, mapped to 503) | `unavailable` |
| 504 (and the idle timeout) | `timeout` |
| 401 `upstream_api_key_invalid`, 502 `upstream_auth_error`, 502 `upstream_credentials_missing` | `auth` |
| 404 `model_not_found` (the login refuses the model, #156) | `refused` |
| any other 502 | `upstream_error` |
| 400 | none: never falls back |

  When the class is named and a target is left, the chain moves on. Otherwise the failure is
  answered exactly as on the single-model path, including after the last target. A client that
  left, and any failure after a stream started (an SSE error event), end the request.
- **Visible (principle VI).** `model` is the model that answered, and `x_pi.attempts` lists
  `{ model, reason }` for each failed attempt, in the body and in every chunk, only when there is
  one. Each hop is a warning (alias, model, class, next model, attempt number), and a success after
  hops is an info line with the attempts. Never content. Principle VI also asks for the serving
  *login*: `x_pi.login` names it, and each attempt carries `login`, when the model has more than
  one login (Accounts below, #227); with one login the provider in `model` identifies it.
- **Limits.** The idle timeout applies per attempt, so an N-target chain can take N timeouts. There
  is no per-request opt-out: docker-agent can't send a header, and a body field would need a
  principle I exception (#177). A client that wants no fallback names the model, and one that
  wants a shorter chain uses another alias.

### Reasoning effort per alias target (#230)

An alias target may be `{ model, reasoningEffort }` instead of a canonical ID, alone or in
`targets` (`AliasModelSchema`, `src/config/schema.ts`; `aliasModels` reads either form). The config
repair drops an entry without its model or with an unknown effort. The effort is the operator's
choice for that name, so it replaces the request's (a principle I exception, constitution 3.7.0):

- **Exposure.** `exposeAliases` checks each target's effort against its model's ladder (pi's
  `getSupportedThinkingLevels`, passed into `computeModelExposure` so exposure loads without pi,
  #165). An unsupported effort is a configuration error, never a clamp: the target is left out
  with an `effort-unsupported` diagnostic, which, like `shadows-model`, makes `/healthz/models`
  answer 503 and logs one warning per distinct set. A chain keeps its other targets. A kept target
  carries `ExposedModel.reasoningEffort`, and `planRoute`'s per-login expansion keeps it.
- **Dispatch.** `withAliasEffort` (`src/server/alias-effort.ts`) gives each attempt the request
  with its target's effort, so every hop runs at its own. A target without one keeps the
  request's, clamped as usual.
- **Visible (principle VI).** `x_pi.reasoning_effort: { requested, applied }` (#175) is always
  present on such an answer: `requested` is the client's value or `null`, `applied` the target's.
  Each `x_pi.attempts` entry carries the `reasoning_effort` its target set. The chat request line
  adds `reasoningEffort` and `aliasEffort`; replacing a different client value is logged at info
  the first time per alias, then at debug.
- **Listing.** `/v1/switchboard/models` lists such an alias's `reasoning_efforts` as its one
  effort, with `reasoning_effort_fixed: true` (false on every other entry). `/v1/models` is
  unchanged.

### Family aliases (#231)

An alias target may be `{ family, pin?, reasoningEffort? }`: the family's newest exposed model, or
`pin` while it is set (`FamilyTargetSchema`, `src/config/schema.ts`). The operator opts in per alias;
nothing is built in (principle VI).

- **Newest** (`src/openai/model-families.ts`, `scanFamily`). pi's catalogue has no release date
  (#176), so the version is read from the model ID by one rule per provider: Anthropic
  `claude-{tier}-{major}[-{minor}]` (tiers `claude-opus`, `claude-sonnet`, `claude-haiku`,
  `claude-fable`; a `-YYYYMMDD` snapshot is a member a pin may name, never the newest), Codex
  `gpt-{version}-{tier}` (tiers `sol`, `luna`, `terra`, `astra`, a dotted version). A family is
  `provider/tier`, never a pattern; one no rule knows is `family-unknown`. A member the rule can't
  read is never picked and is `family-unparsed`. Versions compare number by number, a missing
  number counting as 0. Moving to release dates later changes only `scanFamily`, no config.
- **Resolution** runs inside `exposeAliases`, so on every request (and on each `/healthz/models`
  and console read): logins, logouts and catalogue refreshes move the alias with no restart. It
  resolves among the exposed models only (principle IV); the newest available member, when newer
  and hidden, is reported as `newerHidden`. A pin holds the alias: a pin that is not exposed is
  `target-not-exposed`, never replaced by the newest; a pin outside the family is
  `pin-outside-family`. The resolved model then goes through the same lookup and effort check as a
  named target, so a family can set `reasoningEffort` and be a chain target.
- **Visible (principle VI).** A family target that resolves to another model than last time logs
  one warning (alias, family, old and new model); the first resolution, and a pinned target, log
  nothing. The last resolution per alias and target is kept in memory per process.
  `/healthz/models` lists `familyAliases` (`{ alias, position, family, pin, resolved, newest,
  newerHidden }`). `family-unknown` and `pin-outside-family` join `shadows-model` and
  `effort-unsupported` as diagnostics that answer 503 (`MISCONFIGURED_ALIAS`); `family-unparsed`
  and `target-not-exposed` are only listed. Responses are as for any alias: `model` is the
  resolved canonical ID, `x_pi.alias` the family alias.
- **Exposure stays pi-free** (#165): the rules work on IDs, and `computeModelExposure` passes every
  available model's canonical ID for `newerHidden`.
- **Console.** The Models view shows each family target's resolution, pin and hidden newer model;
  the alias menu of a single family target adds **Pin to…** (the family's exposed members) and
  **Follow newest**, the targets menu offers both for a family target in a chain, and **+ New
  alias…** asks for a model or a family. Each saves through `saveConfigToFile`.

### Cooldowns (#68)

A 429 or 503 is remembered, so a chain stops calling a failing provider first on every request.
State is in memory (`src/pi/cooldowns.ts`), and routing on it is in `src/server/route-cooldowns.ts`.

- **Scope.** A 429 (`rate_limit`) cools the **login** that met it (#227: `anthropic-2` apart from
  `anthropic`): a subscription's limit covers the account. A 503 or 529 (`unavailable`) cools the
  **model**, under every login.
- **Length: from the failed response, no cap** (`src/pi/reset-time.ts`). pi calls `onResponse`
  only after a success (except Codex), so the proxy passes pi a `fetch` (`capturingFetch`) that
  copies each 429, 503 and 529 (status, headers, and up to 16 KiB of the body, from a clone).
  The copy is read before pi gets the response, so a body that stalls holds up that failure by at
  most 2 s (`BODY_READ_MS`). Reading it after returning would make `runAttempt` wait on it anyway.
  `resetAfterMs` takes the first source that gives a positive wait, in this order:
  1. `retry-after-ms`, then `retry-after` (seconds or an HTTP date);
  2. body `resets_in_seconds`, `retry_after` or `resets_at` (Codex's usage limit);
  3. the latest `*ratelimit*reset*` header (OpenAI's durations, Anthropic's timestamps), passing
     over a bucket whose `*-remaining` twin is above 0: those headers come for every bucket, full
     or not;
  4. the message's "try again in …" wording.

  A number is read as seconds to wait, as a Unix time in seconds past 1e9, or in milliseconds past
  1e11. A date counts only as ISO 8601 or an HTTP date, as `Date.parse` reads odd text as dates.
  A wait ending after the last time a `Date` can hold (`LATEST_DATE_MS`, the year 275760) is no
  real reset time and falls through too; `toISOString()` throws on such a date. With none, a
  growing default: 60 s, 180 s, then doubling, counted per provider or model and reset by a
  stated time or a success. Its end is clamped to that same date, which a client naming a
  rate-limited model would pass after about 38 failures in a row. That bound is the limit of
  `Date`, not a cap. pi's Google adapters refuse a custom `fetch`, so Google models always use
  the default.
- **Codex over SSE (#185).** pi's Codex adapter tries a WebSocket first (`transport: "auto"`),
  and `fetch` sees nothing of it. So the proxy passes `transport: "sse"` for
  `openai-codex-responses` (`transportOptions` in `src/pi/complete.ts`), and the 429 body's
  `resets_in_seconds` is read. pi throws that 429 with its own wording only ("You have hit your
  ChatGPT usage limit", no status), so "usage limit" is rate-limit wording in `BY_WORDING`.
  Before 0.3.1, a Codex limit answered 502 `upstream_error` and started no cooldown.

  Measured live on 2026-10-21 (`gpt-6-luna`, median time to the first event):

  | Calls | WebSocket | SSE |
  |---|---|---|
  | One turn, 4 calls each | 1,522 ms | 954 ms |
  | One turn with a session ID, 4 calls each | 1,199 ms | 916 ms |
  | Turns 2–6 on a 31k-token history, 10 each | 1,049 ms | 1,071 ms |

  With a session ID the WebSocket sends only the new turns, but that bought nothing measurable at
  31k tokens. Both transports read 30,720 tokens from the prompt cache.
- **Applied by routing only, recorded always (principle VI).** Every request's 429 or 503 on the
  proxy's login starts a cooldown, so the state is visible. A request with its own upstream key
  records and clears nothing: its failures are about that key, not the login others share. It
  never skips either, as `planRoute` gives it one candidate and no `fallbackOn`. Only a
  chain whose `fallbackOn` names the class skips a cooling candidate (`cooldownSkip`); a request
  that names a model calls it as before. The check runs as the chain reaches each candidate, so a
  429 met earlier in the same request skips that provider's later models too. When the candidate
  and every one after it are cooling, the one of those whose cooldown ends first is called (on a
  tie, the earlier), so a request is never answered without a call. A candidate already skipped
  is not reconsidered, even if it ends sooner. The comparison uses the state as each candidate is
  reached: a cooldown that a parallel request starts or clears meanwhile can change which one
  that is.
- **Visible.** A skipped candidate is an `x_pi.attempts` entry with `skipped: true`. Each
  cooldown's start, end and skip is an info line. `/healthz/models` lists the active cooldowns
  (operator), and `/v1/switchboard/models` gives each model's `cooldown` (clients that pick models
  themselves, #68's comment). A cooldown never fails `/healthz/models`.
- **Ended by a success.** A call that succeeds clears its provider's and its model's cooldowns,
  if they started before that call was sent. A call sent earlier was taken while the provider
  still had room, so it says nothing about the limit that started a newer cooldown.
- **Ended by the operator (#182).** `DELETE /v1/switchboard/cooldowns` (below) and the console's
  `c` end cooldowns at once, for a limit the operator knows has lifted or a wrong time a provider
  sent; both call `clearCooldownsFor`. There is no ceiling on a cooldown's length (#68's decision
  stands): a real weekly limit is honored until the operator says otherwise. The clear drops the
  streak with the cooldown, so the next failure without a time waits 60 s again, and skips the
  send-time check a success makes. Each cooldown it ends is an info line (`Cooldown of {scope}
  {name} cleared by the operator`), names only.
- **No hidden SDK retries.** pi 1.3.0 builds every SDK client with `maxRetries: 0` and defaults
  its own retry loop (`retryProviderRequest`) to 0, as does its Codex adapter. A 429 therefore
  reaches the proxy at once. #68's proposal to set `maxRetries: 0` per candidate was unneeded.

### Quota (#69)

Subscriptions report on every response how much of each usage window the account has used. The
proxy keeps the latest report per provider, in memory (`src/pi/quota.ts`). It shows it on
`/healthz/creds` (per provider, for the operator) and on `/v1/switchboard/models` (per model,
for clients that pick models themselves, #69's P6 comment). A fallback chain can keep a share of
it in reserve, skipping a provider that is close to its limit (below).

**What each subscription sends.** Read from a live probe of each login on 2026-10-21, one call each.
Copilot wasn't logged in, so it is unknown.

| Provider | Header | Meaning |
|---|---|---|
| Anthropic (Claude subscription) | `anthropic-ratelimit-unified-<5h\|7d>-utilization` | Share used, 0–1 (`0.0`, `0.47`) |
| | `anthropic-ratelimit-unified-<5h\|7d>-reset` | When the window resets, in Unix seconds |
| | `anthropic-ratelimit-unified-<5h\|7d>-status` | `allowed`, … |
| | `anthropic-ratelimit-unified-status`, `-reset`, `-representative-claim` | Overall status, its reset, and the window that binds (`five_hour`) |
| | `-fallback-percentage`, `-overage-status`, `-overage-disabled-reason` | Not kept |
| Codex (ChatGPT plan) | `x-codex-<primary\|secondary>-used-percent` | Share used, 0–100 (`0`, `2`) |
| | `x-codex-<primary\|secondary>-reset-at`, `-reset-after-seconds` | When it resets: Unix seconds, and seconds from now |
| | `x-codex-<primary\|secondary>-window-minutes` | `300` (5 hours), `10080` (7 days) |
| | `x-codex-plan-type`, `x-codex-active-limit` | `plus`, `premium` |
| | `x-codex-credits-*`, `-primary-over-secondary-limit-percent` | Not kept |

- **Exact fields only.** The same responses carry `anthropic-organization-id`,
  `anthropic-workspace-id`, `set-cookie`, request IDs and `x-codex-turn-state`, an opaque token.
  The proxy reads the window fields, the overall status and the plan by name, and checks each
  for its type. A share outside 0–1 or a value that isn't a plain number is dropped.
- **Where they come from.** The capturing `fetch` (#68) passes every response's headers on, success
  or failure. Codex sends its headers only over SSE, which the proxy uses for Codex (#185). pi's
  Google adapters refuse a custom `fetch`, so Google reports none.
- **Never made up.** A provider that reports nothing shows `null`, not zeros. A response without
  quota headers leaves the last report. A window whose reset has passed is left out, as its
  share is no longer known; with none left, the provider shows `null`. Once one window has
  reset, the overall `status` is shown as unknown, as it may have been that window's.
- **The shared login only.** A request with its own upstream key records nothing, as for
  cooldowns: its headers report that key's account.
- **Keyed by provider.** pi has one login per provider, so a provider's report is its login's.
  A second login to the same service is a second provider (`anthropic-2`, Accounts
  below), with a report and a reserve of its own.
- **Recorded for Anthropic only.** `test/fixtures/recordings/anthropic-messages/quota.json` is a
  live call from a login made for recording, and `test/integration/quota-replay.test.ts` replays
  it through pi's client to `/healthz/creds`. Codex is tested with the probe's header names and
  fake identifying values (`test/fixtures/quota-headers.ts`); its recording and a Copilot probe
  are #238. The recorder keeps a response's quota headers by exact name and nothing else
  (`KEPT_RESPONSE_HEADER` in `test/fixtures/recording.ts`), and records a `quota` call for
  Anthropic and for Codex (over SSE, as the proxy calls it); it needs a login made for recording
  (`PI_SWITCHBOARD_RECORD_AGENT_DIR`).

**The reserve** (`src/server/route-reserve.ts`, principle VI: configured, and reported). A
fallback chain skips a provider that is close to its limit, before it refuses:

- **Configured per provider.** `routing.reserve` in `proxy-config.json`, the share of each window
  to keep free, from 0 to 1 (`{ "anthropic": 0.2 }`); read per request with the aliases. Invalid
  entries (a share outside 0–1, a non-number) are dropped with the config warning. A provider
  left out has no reserve.
- **The worse window decides.** A provider is below its reserve when any window it reports has
  less than that share left. The share left is rounded to six places, so `1 - 0.8` is `0.2` and
  a provider with exactly its reserve left is not below it.
- **Between candidates only.** A request with one candidate is always sent; a route's last
  candidate is too. The candidates are an alias chain's models and, since #227, a model's logins,
  so a request that names a model served by two logins skips the first while it is below its
  reserve; reserves are keyed by login. Skips are checked after the cooldown check (#68). The
  reserve is its own configured control under principle VI, not a failure class: it needs no
  `quota` in a `fallbackOn`.
- **Never skip them all.** A provider below its reserve is skipped only when a later candidate is
  a real alternative: one above its reserve and not cooling down for a class the alias names (a
  candidate the chain will skip for its cooldown is none). When every alternative is below its
  reserve, or there is none, the one with the most left is called, the earlier on a tie, as
  cooldowns call the one that ends first: a reserve never fails a request by itself.
- **Needs a report.** A provider with no quota known (not reported yet, every window reset, or
  one that never reports, such as Google and API keys) is not below any reserve.
- **Reported.** The skip is in `x_pi.attempts` as `reason: "quota"` with `skipped: true`, and an
  info line names the alias, the model, the provider, the window, the share left and the
  reserve. It is not a request in the route totals (#70), as a cooldown skip is not. The
  console's Accounts view shows each provider's share used per window, red with `below reserve`
  when it is.

### Accounts: several logins per provider (#227)

pi stores one credential per provider ID, so a second subscription to the same service is a
second login: `{provider}-N` for N from 2, each a copy of one of pi's built-in providers
under its own ID (`src/pi/accounts.ts`). Nothing is configured; the store is the record. At
startup `initRegistry` registers a provider for every `{provider}-N` credential pi lists
(`registerStoredAccounts`); in the console, the login list offers each logged-in built-in
provider's next free slot (`Anthropic 2`), `runLogin` registers the slot before pi's
login and drops it again if the login fails or is cancelled, and `runLogout` drops it with the
credential, so its number is reused. The idea is pi-rotator's and pi-multi-account's; their `{provider}-account-N`
form is read as well, so a login made through either is served; neither extension is loaded, and neither can
act on the proxy's requests (they switch an interactive session's model). pi-multiprovider keeps
credentials outside pi's store, which the Scope rules out.

**A login is not a model** (constitution 3.6.0, principles IV and VI). The login's catalog is the
base's, so `src/openai/model-logins.ts` groups pi's available models by base provider and model
before exposure runs: `claude-opus-5-5` is one exposed model, owned by `anthropic`, whose entry
carries `logins` (`ExposedModel.login` is the serving provider ID; `provider` the base) in the
order routing tries them, base first, then slots by number. A model only a slot has (logged out
of the base) stands in under the base's name. `scoped` mode's `enabledModels` patterns match the
base, so they cover every login. A login's ID is not a public or canonical ID: a request naming
`anthropic-2/claude-opus-5-5` gets 404.

**Routing picks the login** (`src/server/route-plan.ts`, `route-hops.ts`). `planRoute` expands
each candidate model into one candidate per login. A hop between two logins of one model follows
`routing.logins.fallbackOn` (default `["rate_limit"]`, the constitution's one recorded default);
a hop between two models follows the alias's `fallbackOn`; a class the alias names but the logins
do not skips the rest of a model's logins and moves to the next model (`nextFor`). Cooldown and
reserve skips use the same rule: a cooling or depleted login is skipped only when a later
candidate is reachable for that class. A request with its own upstream key keeps the first login
only: the key is the client's, not one of the proxy's logins.

**Kept apart by login.** Cooldowns (#68) are keyed by `candidate.login`: a 429 cools the login,
a 503 cools the model under every login (`loginSubject`). Quota (#69) is recorded and reserved
per login (`routing.reserve` entries name logins). Route totals (#70) and the stats store key on
the login. `/healthz/creds` and the console's Accounts view list each login. The response reports
the login under `x_pi.login`, and each attempt's `login`, only when the model has more than one
(a single-login model's response is unchanged); the chat log lines carry `login`.
`/v1/switchboard/models` lists each model's `logins` with cooldown and quota; the entry's own
`cooldown` and `quota` are the first login's.

**Labels.** After a login, the console asks what to call it (`work`); **Set a label** in the
account's menu changes it. Labels live in `proxy-config.json` as `labels` (provider → text,
trimmed, 1–40 characters), saved by `saveLoginLabel` (`src/tui/login.ts`) through
`saveConfigToFile`, never in pi's store and never sent anywhere; they show in the Accounts view's
`label` column and beside the name in the login and logout lists. The provider's own account
identity (Anthropic's organization ID on responses, Codex's JWT claims) is deliberately not
read: #69 keeps no account or organization ID, and a label the operator writes needs nothing from
the credential.

- **A fresh built-in, not the composed provider.** The copy is made from a fresh
  `builtinProviders()` instance, not from the runtime's provider: the composed one carries the
  base's `models.json` overrides, `apiKey` included, which must not reach another login, and a
  dynamic catalog lives in the instance's closure, which copies would otherwise share. A base
  that is not built in (a `models.json` provider) offers no slot, and a stored `acme-2`
  credential is left alone with a warning. A `models.json` entry under the copy's own ID composes
  above it, as for any native provider (checked on pi 1.3.0: a `baseUrl` under `groq-2`
  applies to the copy's catalog, and `groq`'s key does not). Such an entry makes pi's
  `getProvider` answer before the slot is registered, so registration checks
  `getRegisteredNativeProvider`, and the console's login list offers the slot once.
- **Listed under its ID, sent as the base.** `getModels`/`getAllModels` re-key the catalog to the
  copy's ID, so pi resolves auth by that ID. The copy's API-key auth is limited to its own stored
  credential (`storedOnly`): pi's built-in resolvers fall back to ambient sources
  (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, AWS profiles), which are the base login's, so without
  that a copy would count as configured by them and a login whose credential went away would
  serve on the base's account (`test/integration/accounts-env.test.ts`). It follows that an extra
  login of a provider configured only by ambient sources (Bedrock through an AWS profile, Vertex
  through ADC) needs a stored credential of its own, such as Bedrock's bearer token from pi's
  login: the ambient one stays the base's. OAuth resolves from the stored credential only and is
  shared as is. The request itself goes to `base.stream` with
  `provider: base.id`, because pi's API code keys provider rules by name: `openai`'s ChatGPT
  sign-in (`isChatGPTSignIn`), `github-copilot`'s headers, `xai`'s reasoning items. Anthropic
  and Codex key nothing by name (OAuth shaping is by the token's `sk-ant-oat` prefix). pi's
  assistant message therefore names the base; the proxy reports the login from its route, never
  from the message. A catalog refresh (`refreshModels`; of pi's built-ins, in 1.3.0 and 1.4.0,
  only `radius` has one) is translated both ways, as pi's providers restore only models stored
  under their own ID.
- **Available before the first request.** A registered provider is only provisionally available
  until the next availability pass; `initRegistry` runs `refresh({ allowNetwork: false })` once
  after registering, so the snapshot the routes read includes a login with a stored credential.
- **Proven offline, not live.** `test/integration/accounts.test.ts` runs `groq` and a stored
  `groq-2` against the mock provider, which tells the logins apart by the key each
  request carries: the model listed once, owned by `groq`, with both logins on
  `/v1/switchboard/models` and `/healthz/creds`; a plain-named request moving to the second login
  on the first's 429 with `x_pi.login` and the attempt's `login`; the cooling first login skipped
  by the next request; no hop with `routing.logins.fallbackOn: []`; the slot's ID answering 404;
  then the login list offering `groq-3`, a scripted API-key login to it joining the
  model's logins at once, a cancelled login leaving no provider, and a logout dropping the slot
  and its label. A real OAuth refresh and response through a copy need a login made for
  recording (as #69's recordings do), never a copy of a live login.

### Usage by route (#70)

The operator's view of usage, keyed by what the proxy knows: alias × provider × served model. No
client-supplied key (#177 settled this), and never the request's `user`.

- **Log tags.** Every `pi.complete` line of an upstream call (start, result, throw) carries `alias`
  (`null` for a request that named a model) and `attempt`, the call's number in the chain from 1.
  The number counts cooldown skips and credential refusals before it, as `x_pi.attempts` lists
  them, and matches the `attempt` on the fallback warning. The result line already had the
  tokens, cache reads and writes, reasoning tokens and `costTotal`.
- **Running totals in memory** (`src/server/route-totals.ts`), one row per route, written by
  `chat-dispatch.ts`:
  - `requests`: each attempt on the model, first or fallback, including a credential refusal
    (an `auth` attempt in `x_pi.attempts`). A cooldown skip is not a request.
  - `failures` and `failuresByClass`: an attempt that failed before its answer started, by its
    class (`failureClass`). A 400 has no class, so it counts in `failures` only. A stream that ends
    with an error event after it started counts too, though the chain could not move on; it counts
    once however its relay ends (`streamFailureCounter`), as an error event and a throw out of the
    relay could both end the same stream. An attempt the client left is a request, not a failure.
  - `fallbacks`: the chain moving on from this model to the next.
  - tokens (uncached input, output, cache read, cache write) and `costUsd`: pi's `usage` on the
    final message of every upstream call, streamed or not, failed ones included (a failure usually
    reports none). A streamed call's usage is added when the stream ends.
  - A model refusing `prompt_cache_breakpoint` is called twice in one attempt (#163): both calls'
    usage is added under the one request. The refusal is a 400, which reports no tokens from the
    providers seen so far; a provider that did report some would make those rows' tokens per
    request look higher than one call's.
  - A request with its own upstream key (`X-Switchboard-Upstream-Api-Key`) counts like any other:
    it is usage through the route, even though it is not the proxy's login.
- **Reset on restart.** Nothing persists; the log is the durable record. `routeTotalsSince()` says
  when counting began. `clearRouteTotals()` empties the table and tells the listeners.
- **Never pruned.** A row stays until restart or a clear, so an alias renamed or removed in the
  config (read per request) keeps its rows. They are bounded by alias × model.
- **Readers.** The terminal console (#61) reads `routeTotals()` in-process and subscribes with
  `onRouteTotalsChange()`. Over HTTP, usage comes from the stats file instead, which survives a
  restart: `GET /v1/switchboard/usage` (#224, below).

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
- `aliases`: record of alias -> canonical ID of an exposed model (#66)

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
- `/proxy show` should summarize the effective exposure policy and preview representative public IDs, and list the aliases and any left out (#66)

## Authentication model

### Upstream credentials

Primary source:

- pi `ModelRuntime` (credentials, catalogs and request auth in one place; Pi 1.x replaced
  `AuthStorage` and `ModelRegistry.getApiKeyAndHeaders()` with it)

Completions run through `ModelRuntime.streamSimple()` (a non-streaming request reads the stream's
final message, as `completeSimple()` would), which resolves
request auth themselves on every request: API keys, OAuth with refresh, model-specific headers,
provider environment and an auth-resolved base URL (`ModelRuntime.prepareRequest`). The proxy
only pre-checks that auth resolves (`getRequestAuth()`), so a route can answer
`502 upstream_credentials_missing` before a response starts (#128). A per-request
`X-Switchboard-Upstream-Api-Key` overrides the resolved key.

When resolution fails, the answer has fixed text and the warning carries only pi's summary of the
failure (`summarizeAuthError`): pi's OAuth errors go on to quote the token endpoint's response and
a stack with install paths, which reach the log at `debug` at most, as on
`/healthz/creds?verify=true`.
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
- the header is matched as RFC 7235 §2.1 allows: the `Bearer` scheme in any case, one or more spaces, then the token, which must match exactly (#128 item 2). The token is compared in constant time: the SHA-256 digests of both, hashed once for the proxy's token, go through `crypto.timingSafeEqual`, so neither how much of a guess matched nor its length shows in the time a refusal takes (#128 item 1)
- two states (`ServerConfig.proxyAuth`): `off` and `token`. Auth that is set but cannot be applied refuses to start (`UnusableProxyAuthError` from `loadConfig`, CONSTITUTION principle II's exception): a file `authToken` that is not a string (`null` included, #82), a `--auth-token` or `PI_SWITCHBOARD_AUTH_TOKEN` that is set but empty (#99), or a config file that exists but cannot be read or is not valid JSON while neither the flag nor the env var sets a token (`configFileProblem` in `src/config/schema.ts`: the file may hold a token the proxy cannot see, and the defaults' `''` would turn it into auth off; a missing file holds nothing and starts with the defaults). The file's token is not used in place of an empty override, since that would ignore what was set. The CLI logs why at `fatal` (no log level filters it out), naming the field or the flag/variable and never the value, and exits `1`. It never falls back to `off`, which would turn a requested token into an open proxy, and it does not start to refuse every request, which would hide the mistake behind a running process
- the pi extension discards the proxy's output, so `/proxy start` checks the same causes before spawning (`startRefusal` in `extensions/proxy/process.ts`: the token it passes wins over pi's own `PI_SWITCHBOARD_AUTH_TOKEN`, which the child inherits, and either wins over the file) and refuses with the reason instead of reporting a proxy that never answered
- saving the config (the extension's settings panel, the model selector) writes such a value back unchanged; only an explicit choice on the auth row or `/proxy reset` replaces it
- the console changes auth without a restart (`p`, `src/tui/proxy-auth-menu.ts`). Each app holds a `ProxyAuthSwitch` (`src/server/proxy-auth.ts`), made from `config.proxyAuth` unless the caller passes one; `proxyAuthMiddleware` reads it on every request and hashes a token once per token, so a new token applies to the next request and the old one is refused from then on. The console passes its own switch to `listen()`. Turning auth on (a 32-byte `randomBytes` token as base64url, or a typed one, refused when empty or with surrounding spaces, which no header could match) or off is saved as `authToken` in the config file (`saveConfigToFile`, which reports whether it wrote; a failed save keeps the change for the session and says so). A token from `--auth-token` or `PI_SWITCHBOARD_AUTH_TOKEN` (`ServerConfig.proxyAuthOverride`) can be turned off for the session only: the file is left alone, and the override applies again at the next start. Turning auth off loosens what the operator set (constitution principle III), so it is logged as a warning, with the off-loopback warning when the bind address reaches beyond this machine. The token shows only in the console's own dialog and is copied on request (pi's `copyToClipboard`); it is never logged

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
- `reasoning_effort` (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`): an effort the model does not support is clamped with pi's `clampThinkingLevel` (nearest supported level above, else below), not rejected (#43). `max` is pi's `max` level (#132); on a model without it, it is the model's highest level. A client that sends one effort to every model must keep working when the model changes; `GET /v1/switchboard/models` lists each model's supported efforts. The response reports the clamp as `x_pi.reasoning_effort: { requested, applied }`, in the body and every chunk, whenever the request set `reasoning_effort`; `applied` is computed for the model that answered (after an alias's fallback, the later one) and is the level asked of pi, which a pi adapter may still translate. The first clamp per model (`provider/id`) is logged at info, later ones at debug, as dropped temperatures are (#175)
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

A whitespace-only `tool` message elsewhere also reaches pi as sent (#145), and since pi 1.4.0 the
adapters, not the proxy, decide what the provider sees (read from pi-ai 1.4.0's `dist`):

| API | A tool result that is only whitespace |
|---|---|
| OpenAI chat completions, OpenAI Responses, Codex | pi's placeholder `(no tool output)` (pi 1.3.0 sent the whitespace) |
| Google | `""` (pi 1.3.0 sent the whitespace) |
| Mistral | `(no tool output)`, as in 1.3.0; Mistral's adapter also trims a tool result that has text |
| Anthropic | the whitespace, as above |

### Prompt cache breakpoints

OpenAI's `prompt_cache_breakpoint` (`{ "mode": "explicit" }`, `PromptCacheBreakpointParam`) on a
text or image content part marks the exact end of a reusable prompt prefix. It affects caching
only, never the answer. The proxy accepts it on every text and image part (system, developer and
user), and sends it on only where the API takes it (constitution 3.1.0, principle I's exceptions):

| API | What happens |
|---|---|
| OpenAI chat completions and Responses at `api.openai.com` | Forwarded. pi joins the leading system and developer text into one string; the proxy's `onPayload` (`src/pi/cache-breakpoints.ts`) puts the client's parts back in its place, joined with the same blank lines, each with its breakpoint (`text` or `input_text` parts). User parts get theirs back by position. Each change is made only when pi's text matches exactly, so a payload pi built differently is left alone. A model there that refuses the field is retried without it and then left out (below). |
| Codex (`openai-codex-responses`) | Dropped: pi sends the system prompt as the plain string `instructions`, which has no part to carry it. |
| Every other API (OpenAI-compatible servers, Anthropic, Google, Bedrock, …) | Dropped: an OpenAI-compatible server may refuse a field it does not know, and the others have no such field. |

A drop is logged at `debug` (`Dropped {count} prompt_cache_breakpoint(s) for {modelId}`), and a
forward reports how many were placed. Rejecting the field instead would break docker-agent,
which sends it on every system part to `gpt-*` models (#149). `test/unit/cache-breakpoints.test.ts`
runs pi's real chat-completions and Responses builders, so a change in how pi builds the system
message shows up there.

**A model that refuses the field** (#163, constitution 3.4.0). Some models on `api.openai.com`,
the ChatGPT-subscription ones (`gpt-6-luna`, `gpt-5.6-terra`, `gpt-6.1-sol`, `gpt-6-astra`),
answer it with a 400: `{"message":"prompt_cache_breakpoint is not supported on this model",
"param":"prompt_cache_breakpoint",…}`. `retryWithoutBreakpoints` recognizes that answer in pi's
error text (`400: {…}` on chat completions, `OpenAI API error (400): {…}` on Responses, `param`
top level or under `error`) for a request that sent breakpoints. It remembers the model as
`provider/id` for the life of the process, and `piComplete` or `piStream` sends the request once
more. The breakpoint patch then leaves the field out for that model, on this request and every
later one, so each such model costs one failed request per proxy start, or one per request
already in flight when the first refusal comes back: a refusal naming the field proves its
request sent it, so those are each retried too (#166 review). A client that has left gets no
retry. pi emits `start` only once the provider has accepted the request, so a stream's refusal is
its first event, and the retry happens before the client sees anything. The first refusal per
model is logged at `info` (`{modelId} refused prompt_cache_breakpoint: retrying without it…`), and
later drops at `debug`. A 400 for any other `param`, and any other status, are answered as they
are. `test/integration/breakpoint-refusal.test.ts` runs the chain through pi's OpenAI adapter and
SDK, concurrent first requests included; `test/unit/cache-breakpoints.test.ts` pins the Responses
wording.

## Experimental: the Responses API (`POST /v1/responses`, #140)

Constitution principle I lets a route start experimental, opt-in and outside the stable surface.
This one is off unless `responsesApi` is on (`--responses-api`, `PI_SWITCHBOARD_RESPONSES_API`);
off, it answers 404 naming the switch, and stays in the OpenAPI document so the document does not
depend on the config. Decisions recorded on #140: stateless; `store: false` or absent only;
`include: ["reasoning.encrypted_content"]` supported for every model; reasoning emitted as
`reasoning` items; the acceptance client is the `openai` SDK's `responses.create()`, Codex CLI a
follow-up.

- **One path for both APIs.** `src/server/responses-route.ts` validates the body
  (`createResponseRequestSchema`, strict at every level), translates it into a chat request
  (`src/openai/responses-api/request.ts`, `toChatRequest`) and runs it through the chat route's
  `runChat`: exposure, aliases, routing, credentials, images, timeouts, disconnects, stats and
  error mapping are shared. A `RunShape` gives each route its answer format
  (`src/server/answer-formats.ts`: `chatFormat`, `responsesFormat`) and a change to the pi context
  (the replayed reasoning below); the dispatch writes answers through the format.
- **Translation.** `instructions` becomes the system message, `input` items become messages, and
  an assistant turn (a run of `reasoning`, assistant `message` and `function_call` items) becomes
  one assistant message with its text and tool calls. `max_output_tokens` is
  `max_completion_tokens`, `reasoning.effort` is `reasoning_effort`, `text.format` is
  `response_format`, function tools move `name` under `function`. `input_image.detail` is accepted
  and dropped, the Responses form of chat's `image_url.detail` (principle I's listed drop).
- **Refused by name (422).** `RESPONSES_REJECTED_FIELDS` lists every `CreateResponse` field the
  proxy does not accept, with its reason; the spec check compares it with the pinned spec, so a
  spec bump that adds a field fails until it is decided. Also `store: true`, a tool that is not a
  function, and an `include` other than reasoning.
- **Output** (`src/openai/responses-api/output.ts`). pi's content blocks become output items at the
  same index: thinking a `reasoning` item (the thinking as its summary), text a `message` with one
  `output_text`, a tool call a `function_call` whose `call_id` is pi's call ID. The request's
  settings are echoed, `store` is `false`, usage maps as on chat, and `x_pi` is chat's. A length
  stop is `incomplete` with `incomplete_details.reason: max_output_tokens`.
- **Stream** (`src/openai/responses-api/stream.ts`). `response.created` and
  `response.in_progress` on pi's first event, then per item `output_item.added`, its part
  (`content_part` or `reasoning_summary_part`) added, deltas, `.done` events, `output_item.done`,
  and `response.completed` or `response.incomplete` with the whole response. Every event has a
  `sequence_number` from 0. A failure ends with `response.failed`, whose `error.code` is
  `rate_limit_exceeded` or `server_error` (OpenAI's codes are a closed list) and whose
  `x_pi.error_code` is the code chat completions would give.
- **Reasoning tokens** (`src/openai/responses-api/reasoning-token.ts`). `encrypted_content` is
  pi's thinking block (text, signature, redaction flag) with the provider, API and model that
  produced it, as base64url JSON with a version. pi keeps OpenAI's own reasoning item, encrypted
  content included, as an OpenAI thinking block's signature and replays it
  (`openai-responses-shared.js`), and keeps Anthropic's signature likewise. On input,
  `withReplayedReasoning` puts the blocks back on the turn's assistant message and gives that
  message the token's model, so pi's `transformMessages` replays them to that model and drops them
  for any other. The token is not encrypted by the proxy: the thinking text is in it in the clear
  (base64url), next to OpenAI's ciphertext for OpenAI models, so the docs tell clients to treat it
  as response text, not as a blob safe to log. One the proxy did not write is a 400. So is a `reasoning` item
  without a token (as OpenAI refuses an echoed reasoning item it has not stored; the summary alone
  is nothing a model can take back), and reasoning that no message or function call follows.
  `withReplayedReasoning` checks that each assistant turn's reasoning lands on its own assistant
  message, and fails the request rather than misplace it.
- **The other operations** (`/v1/responses/*`: retrieve, delete, cancel, input items, input
  tokens, compact) need stored responses and are in `UNSUPPORTED_ENDPOINTS`.

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
      "created": 1792599474,
      "owned_by": "openai"
    }
  ]
}
```

Compatibility rule:

- keep the stable response strictly to the standard OpenAI model object fields
- do not attach capability metadata such as context window, max tokens, reasoning support, or modality support to the standard `/v1/models` path
- if richer metadata is exposed, use a separate non-standard endpoint rather than `x_pi` on the standard model object: `GET /v1/switchboard/models` (below)
- `created` is the Unix time the proxy started, the same for every model: OpenAI requires the field, and pi's catalogue has no release dates (#176). pi-ai generates its catalogue from models.dev, which has a `release_date`, but drops it, and pi will not keep it. A proxy-side snapshot of the dates was rejected: a second catalogue to keep in step with pi's, for a field no known client reads. Clients must not read it as recency.

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
  "data": [{
    "id": "claude-sonnet-4-5", "provider": "anthropic", "reasoning": true,
    "reasoning_efforts": ["none", "minimal", "low", "medium", "high"], "input": ["text", "image"],
    "context_window": 200000, "max_output_tokens": 64000,
    "cost": { "input": 3, "output": 15, "cache_read": 0.3, "cache_write": 3.75 }
  }]
}
```

Each entry is pi's catalogue entry for the model, as pi resolves it (`models.json` values included), so a client can choose by price, size and capability instead of hard-coding them (#173). An alias carries its target's entry under its own `id`.

- `provider`: pi's provider, as `owned_by` on `/v1/models`
- `reasoning`: whether the model reasons (`Model.reasoning`)
- `reasoning_efforts`: the `reasoning_effort` values the model runs at as asked, lowest first, from pi's `getSupportedThinkingLevels` (`off` is `none`, and every other level the effort of the same name, `max` included). `["none"]` for a model without reasoning
- `input`: what the model accepts, `text` and `image` (`Model.input`)
- `context_window`, `max_output_tokens`: in tokens (`Model.contextWindow`, `Model.maxTokens`)
- `cost`: USD per million tokens for uncached input, output, cache reads and cache writes (`Model.cost`; pi computes a call's cost as rate / 1,000,000 × tokens). `0` where pi has no price. A client can use these as docker-agent `cost` tables, which docker-agent needs to price calls through a custom `base_url` (#177)
- `cooldown`: `null`, or the model's active cooldown (`reason`, `scope`, `until` in Unix seconds), below "Cooldowns (#68)"
- `quota`: `null`, or the model's provider's latest quota (`observed_at`, `status`, `plan`, `windows` with `name`, `used` 0–1, `resets_at` in Unix seconds, `window_minutes`, `status`), below "Quota (#69)"
- new capability fields go here, never on `/v1/models`
- non-standard routes live under `/v1/switchboard/`, as `/v1/switchboard/agent/completions` would. The prefix was `/v1/pi/` until constitution 2.0.0; `/v1/pi/models` moved here with no alias

### `GET /v1/switchboard/usage`

Not part of OpenAI's API (#224): the stats file's usage over a window, for a proxy run without the console (the Docker image, say). Behind proxy auth like every `/v1/*` route.

- `?window=` `today` (from local midnight; the default), `week` (the last 7 days) or `all` (30 days, all the file keeps); the windows are `src/stats/windows.ts`, shared with the console. Anything else is `400` `invalid_request_error`, `param: "window"`. A repeated `window` counts by its first value, as `verify` does on `/healthz/creds`
- the body (`usageSchema`, `src/server/usage.ts`): `object: "switchboard.usage"`, the window, `from` and `to` (ISO times; `to` is the minute after the last), `bucket_minutes` (60, 360 or 1440 by window), then `models` and `aliases` with the same numbers (`requests`, `failed`, `left`, `average_ms`, `slowest_ms`, `average_first_event_ms`, `attempts`, `fallbacks`, `input_tokens`, `output_tokens`, `cache_tokens`, `cost_usd`), `failures` by class, `rejected` by status, and `timeline` (`start`, `requests` with rejected ones, `failed`, `rejected`)
- `aliases`: one entry per alias a request named, its attempts counted whichever model in a fallback chain made them, and `alias: null` for requests that named a model directly. Rejected requests are only in `rejected` and `timeline`
- reads the store through its own connection, opened on the first request (WAL lets it read while the recorder writes). The reads are synchronous, on the thread that serves requests, so one window's answer is reused for 5 s, the recorder's own write interval: a burst of requests reads the file once. A file that won't open or read answers `503` `stats_unavailable` and is closed (a failed close is logged, not thrown) and opened again on the next request; stats off (`--no-stats`) is `503` `stats_unavailable` too, never empty numbers. The connection lives until the process exits: the route has no server lifecycle to close it on, and a WAL reader holds no lock
- routes, counts, timings, tokens and cost only: never message content, the request's `user`, or a credential. A rejected request's model is the client's text, already capped by the recorder

### `DELETE /v1/switchboard/cooldowns`

Not part of OpenAI's API (#182): ends cooldowns early, without a restart. Behind proxy auth like
every `/v1/*` route. Decided on #182 (constitution 3.8.0): a route rather than a config ceiling,
which would reverse #68's decision to honor a provider's time, and beside a console key, which
alone would not reach a proxy run without the console (`/proxy start`, the Docker image). It is the
one route that writes state, and it writes only the cooldowns fallback chains read: it calls no
provider and changes no configuration. With proxy auth off (the default, for a proxy bound to
`127.0.0.1`), any client that can reach the port can end cooldowns, as it can call every other
route. The worst it does is one failed call per login still limited, whose 429 starts the
cooldown again; a proxy others can reach should keep proxy auth on, as the startup warning for a
bind off loopback says.

- no query ends every cooldown. `?provider=` names a login's provider ID (`anthropic-2`) and ends
  its cooldown after a 429; `?model=` names a model by its canonical or public ID and ends the
  model's own cooldown after a 503 or 529, not its logins' (a 429 is the login's limit, cleared by
  `provider`). Both end both. A repeated name counts by its first value, as `window` does above
- a name nothing is known by is `404` `invalid_request_error`: `login_not_found` (`param:
  "provider"`) for a login that serves no exposed model and is not cooling down, `model_not_found`
  (`param: "model"`) for a model that is neither exposed nor cooling down. A name is checked
  against the active cooldowns first, so a cooldown on a login or model the exposure config has hidden
  since can still be ended by name; the exposure is read only when no cooldown matches
- `200` with `{ object: "list", data }`: the cooldowns that were active and are now ended, in the
  shape `/healthz/models` lists them (`cooldownView`, `src/server/cooldowns.ts`), soonest end
  first; empty when the name is known but nothing was cooling. A cooldown already over is
  forgotten with its streak but not listed

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
- `401` proxy auth failure (`authentication_error`, no code), or the provider rejected the key the
  client sent in `X-Switchboard-Upstream-Api-Key` (`authentication_error`,
  `upstream_api_key_invalid`, #128)
- `404` model not found (`model_not_found`): no exposed model has the ID, or the provider refused
  the model for the login the proxy uses (#156); an unsupported endpoint, or any other route
  (`Invalid URL (<METHOD> <path>)`)
- `413` request body larger than `maxBodySize` (POST, PUT and PATCH): a declared `Content-Length`
  over it is refused before reading, and a chunked body is counted as it arrives and refused once
  it passes, without reading the rest (#187)
- `422` unknown or rejected parameter, unsupported tool schema (`unsupported_parameter`)
- `429` upstream rate limit or usage limit (`rate_limit`)
- `500` internal proxy failure, including an invalid model exposure config
- `502` the provider rejected pi's stored credential (`upstream_auth_error`), pi has no usable
  credential for the model's provider and no `X-Switchboard-Upstream-Api-Key` was sent
  (`upstream_credentials_missing`, #128), or any other upstream failure (`upstream_error`), such as
  an upstream 404 or 500
- `503` provider unavailable (`provider_unavailable`, upstream 503) or overloaded
  (`provider_overloaded`, upstream 529, or no status and wording that says it is out of capacity)
- `504` upstream timeout (`timeout`): an upstream 408 or 504, or the provider sent nothing for
  `upstreamTimeoutMs` (an idle timeout that restarts on every upstream event, raw provider events included (#50), not a cap on the call;
  `src/pi/upstream-idle.ts`)

Upstream failures (`mapUpstreamError`, `src/server/errors.ts`): pi reports a failure as text, with
no structured status (`onResponse` fires only for successful responses). The provider's HTTP status
is read from the fixed positions pi 1.3.0's messages put it in: leading, and only when followed by
what only a status is followed by (`429: {…}`, `429 {…}`, `429 "…"`, `429 status code (no body)`;
`429 tokens…` is not a status), after a label (`OpenAI API error (429): …`, `Mistral API error
(429): …`), Google's `got status: 429.` or its error body's `error.code`. When a status is found it
decides; the wording (`rate limit`, `too many requests`, `usage limit`, `timed out`, `overloaded`,
`model is at capacity`, `servers are currently busy`, `experiencing high demand`, `service
unavailable`, …, checked in that order) is consulted only when no status is reported (Bedrock,
network failures, the proxy's own idle timeout, pi's Codex usage limit), and a number elsewhere in
the text never counts (#42). `usage limit` also matches `usage_limit_reached` and
`subscription_sharing_usage_limit_exceeded`, but not "usage limitations" (#190). The capacity
wordings are the phrases pi's own retry classifier (`pi-ai/utils/retry`) treats as transient;
with no status they answer `503 provider_overloaded`, whose class `unavailable` cools the model
down. The client gets a fixed message and code, never the upstream text. A missing or broken
upstream credential is refused with `502 upstream_credentials_missing` before any response starts,
streamed or not (`checkCredential`, `src/server/chat-dispatch.ts`).

Credential answers (#128 items 3 and 4, principle I): a `401` tells a client its own credential is
wrong, so only the proxy token and a client's own key get one.

- The provider refuses a key the request sent in `X-Switchboard-Upstream-Api-Key`: `401
  authentication_error`, code `upstream_api_key_invalid`, with fixed text naming the header
  (`forClientKey`). The provider's text is never quoted; it can carry the key.
- The provider refuses pi's stored credential: `502 upstream_auth_error`, as before; the client
  did nothing wrong.
- pi has no usable credential for the model's provider: `502 upstream_credentials_missing`, fixed
  text telling the operator to log in with pi on the proxy's host. pi's reason is logged as a
  warning, not answered. `failureClass` reads the code as `auth`, so an alias whose `fallbackOn`
  names `auth` still moves past it.

Context overflow (#40): `mapFailedCall` runs pi's `isContextOverflow` on the failed call's final
message, which recognizes overflow wording from about 15 providers (Anthropic, OpenAI, Google,
Bedrock, Mistral, OpenRouter, …), before the status mapping. Since pi 1.4.0 it also counts any
provider 413 as an overflow, whatever the body says (GitHub Copilot answers a too-large request
with `413 failed to parse request`), so a 413 is a `400 context_length_exceeded`, not a 502, and
no longer moves a chain whose `fallbackOn` names `upstream_error` (a 400 has no failure class). A
reported status other than 400 or 413 rules it out, so a 429 that says "too many tokens" stays a
rate limit. A provider that accepts an over-long prompt and answers anyway (input beyond the
context window, or a `length` stop with no output) is not an error: the answer goes to the client
and a warning is logged.

Provider rejections (#147, #128 item 5): an upstream 400 or 422 that is not a context overflow is
the provider refusing a field the client sent, such as Claude's `top_p` on 4.7 and later, a forced
`tool_choice` on Claude 5.x, or a whitespace-only stop sequence. It answers `400
invalid_request_error`, code `upstream_invalid_request`, with fixed text ("The provider rejected
the request as invalid. Check the fields this model accepts."), so a client does not retry a
request that cannot succeed. The provider's own message stays out of the response, as it can quote
the request, and reaches the log at `debug` only; the route's line for it is a warning, not an
error. An upstream 401 or 403 is still `upstream_auth_error` for pi's stored credential (a
client's own key gets `401 upstream_api_key_invalid`, above), and so is a 400 whose wording is
about credentials (an API key, authentication, an access token): Google answers a bad API key
with `400 INVALID_ARGUMENT`, which the client cannot fix. The wording check
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
hiding the model (`docs/api.md`, "Exposure modes"). Live, Codex refuses before pi's first event, so a
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

Images are fetched only after the model's upstream credential is checked (`checkCredential`): a
request that cannot reach the provider gets its `502` without the proxy fetching anything.

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
  One exception (#168): exactly one argument, `--version`, `-v`, `--help` or `-h`, runs without
  a token, since the CLI prints and exits for those without starting a server. Anything beside
  it goes through the guard.
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
  `@vx-daniel` scope and the token in `~/.npmrc` once (`docs/install.md`, "Installation").
- **Ruled out, tested with pi 1.3.0:**
  - `pi install git:github.com/vx-daniel/pi-switchboard` clones `dev` and runs
    `npm install --omit=dev`. `dist/` is not in git, and `prepare` needs the dev dependencies,
    which that leaves out.
  - A release tarball as a URL (`npm:https://…/x.tgz`) installs and is listed, but pi takes the
    whole URL for the package name, looks under `node_modules/<url>`, and never loads the
    extension.
  - By package name, pi finds the package, and `/proxy start` runs the installed
    `dist/index.mjs`.
- **pi's packages are not `dependencies`** (#165). pi warns about an extension package that
  lists `@earendil-works/pi-ai`, `pi-coding-agent` or `pi-tui` in `dependencies`, and rightly: the
  extension runs in pi's process, where pi provides them, and the library entry points it imports
  (`config`, `exposure`) loaded this package's installed copy of pi as well, a second pi runtime.
  So:
  - **Those entry points import no pi at runtime.** `piAgentDir` (`src/config/agent-dir.ts`)
    stands in for pi's `getAgentDir`, Windows shell paths included, checked against it in
    `test/unit/agent-dir.test.ts` (on Windows with `process.platform` stubbed). `sameModel` in
    `model-scope.ts` stands in for `modelsAreEqual`; `model-scope.test.ts` compares the whole
    resolver with pi's, so a dedup that differs from pi's fails there.
    `test/unit/library-entry-points.test.ts` loads the four entry points with every pi package
    mocked to throw.
  - **`pi-tui` is an `optionalDependency`**, like pi's other packages: the console
    (`pi-switchboard tui`, #61) needs it in the CLI's own process. In pi's process, pi's loader
    still gives the extension the host's copy.
  - **`pi-ai` and `pi-coding-agent` are `optionalDependencies`.** The proxy that `/proxy start`
    runs, the standalone CLI and the image need them in their own process; with pi's bundled
    build there is no host copy on disk to use. npm, pnpm and pi's own install add optional
    dependencies by default, and pi checks only `dependencies`. An install with `--omit=optional`
    or `--no-optional` leaves them out; the CLI entry (`src/index.ts`) loads the CLI
    (`src/cli.ts`) dynamically, so it says which package is missing and how to fix it, and exits
    1, instead of failing with a stack trace.

  Measured with pi 1.3.0 and a marker in the installed copies: before, pi's own process loaded
  both at startup; after, only the proxy process does, and pi prints no extension warning.

### Standalone binary

The proxy compiled into one executable with `bun build --compile` (#61, ported from #86), so it
runs with no Node and no pi installed. Bun is build-only (constitution 3.5.0): the npm package
and the image run on Node, and Bun appears only in `scripts/build-binary.ts`, its CI job and its
release workflow, never in `check:all` or the pre-commit hook.

- **Its own entry, `src/standalone/main.ts`.** It repeats the setup pi's own Bun binary does
  (pi-coding-agent `dist/bun/`) before loading `src/index.ts`. It restores an environment a sandbox
  emptied (`src/standalone/sandbox-env.ts`, from `/proc/self/environ`), since losing
  `PI_SWITCHBOARD_AUTH_TOKEN` silently would turn proxy auth off. Then it registers pi-ai's OAuth
  flows (`@earendil-works/pi-ai/bun-oauth`) and Bedrock provider (`/bedrock-provider`, `/compat`)
  statically: pi-ai loads them through variable import specifiers, which no bundler follows, so a
  plain compile serves until an OAuth token needs refreshing and then fails every request with
  `Cannot find module './anthropic.js'`. Those imports are dynamic, after the restore, because a
  static import would read the environment before it is recovered; their literal specifiers are
  still embedded. `src/index.ts` loads the CLI dynamically to explain a missing pi package (#165);
  in the binary pi is always embedded, and the literal specifier is followed the same way.
- **Compile flags.** `--no-compile-autoload-dotenv --no-compile-autoload-bunfig`, as pi's binary
  uses. Without them the binary reads `.env` and `bunfig.toml` from the directory it is started
  in, so a stray `.env` could set `PI_SWITCHBOARD_HOST` or `PI_SWITCHBOARD_AUTH_TOKEN`: settings
  come only from flags, the environment and the config file (principle III).
- **Targets.** `node scripts/build-binary.ts` builds the host's `dist-bin/pi-switchboard`
  (`pi-switchboard.exe` on Windows); `--all` cross-compiles `pi-switchboard-<os>-<arch>` for
  linux-x64, linux-arm64, darwin-x64 and darwin-arm64 on one Linux machine, with
  `dist-bin/SHA256SUMS`; `--windows`, on Windows only, builds `pi-switchboard-windows-x64.exe`
  and `-windows-arm64.exe`, with `dist-bin/SHA256SUMS-windows`. The macOS and Windows binaries are
  unsigned.
- **Icon.** A Windows binary carries `assets/pi-switchboard.ico` (`--windows-icon`), made from
  `assets/pi-switchboard-icon.png`. Bun sets an icon only when it compiles on Windows, so the
  Windows set is built on a Windows runner. ELF and Mach-O executables have no icon; neither does
  a container image (OCI defines no icon field, and Docker Hub takes a repository logo only from
  verified publishers), so the image's Docker Hub overview shows the README header instead.
- **Windows.** `binary.yml` with `platforms: windows` builds the Windows set on `windows-latest`,
  runs the binary test suite there against the
  `pi-switchboard-windows-x64.exe` the release gets (`PI_SWITCHBOARD_BINARY` names it, so the
  suite tests the shipped file, not a rebuild), runs `--version` on `windows-latest` and
  `windows-11-arm`, and with a tag uploads the two `.exe` files and `SHA256SUMS-windows` to that
  release, attested like the others. The release workflow runs both sets for each release, at once
  (`binary` and `binary-windows`), each set's files in its own artifact (`binaries-unix`,
  `binaries-windows`): the two calls share the release run, where an artifact name can be uploaded
  only once. Until 0.4.0 the Windows set was run by hand after the release. The test suite
  starts the binary with `USERPROFILE` and `SystemRoot` as well as `HOME`
  (`test/fixtures/platform-env.ts`): Windows takes the home from `USERPROFILE`, and a process
  without `SystemRoot` cannot open sockets.
- **Tests.** `test/binary/` runs the compiled host binary against the fixtures: a chat completion
  through the mock provider, an expired OAuth login refreshed through a local recording HTTPS
  proxy (no `Cannot find module`), and a `.env` and a `bunfig.toml` in its working directory
  ignored. The `.env` sets a token and the `bunfig.toml` preloads a script that sets one and
  writes a marker file; auth staying off (no token and a wrong token both pass) and no marker
  show them ignored. Compiled from `src/index.ts`, the refresh test fails; compiled without
  `--no-compile-autoload-dotenv`, the `.env` test fails; without `--no-compile-autoload-bunfig`,
  the `bunfig.toml` test fails. The `binary` Vitest project exists only when
  `PI_SWITCHBOARD_BINARY_TESTS=1`, which `pnpm run test:binary` sets after building, so `vp test`
  and the gate never need Bun. CI runs it in the `binary` job (Bun 1.4.3, `oven-sh/setup-bun`), on
  the same triggers as `gate`.
- **Release assets.** The release workflow's `binary` job calls `binary.yml` with each new release
  tag. Its `build` job checks the tag out, runs `test:binary` and compiles every target.
  Its `smoke` matrix then runs each binary's `--version` on a native runner (ubuntu x64,
  `ubuntu-24.04-arm`, `macos-14` for arm64, `macos-15-intel` for x64, since `macos-13` is
  retired), so the darwin and arm64 binaries are run before release, not only built. Its `release`
  job checks them against `SHA256SUMS`, attests their build provenance
  (`actions/attest-build-provenance`; the only job with `id-token: write` and
  `attestations: write`) and uploads them to the tag's GitHub release.
- **Retryable upload, never overwriting.** The upload adds only the set's expected assets the
  release is missing, the checksum file last. An asset already there is downloaded and must be
  byte-identical to the new build, or the run fails before uploading anything. This relies on Bun
  producing identical binaries for one tree and Bun version, which two local `--all` builds showed
  (the same `SHA256SUMS`), not a guarantee Bun makes; if a build ever differs, a retry stops at the
  first existing asset, and the release's existing assets must be deleted by hand first. With
  all of them already there it succeeds without uploading. So a run that failed partway is fixed by
  running `binary.yml` again by hand with the tag. Third-party actions in `binary.yml` and the CI
  `binary` job are pinned by commit SHA.
- **Releases before the binary.** A tag whose tree has no `scripts/build-binary.ts` (0.3.0 and
  earlier) fails in the `build` job's first steps with that reason: its tree cannot build one, and
  building it with a newer tree's scripts would attest binaries the tag's source did not produce.
  The first release with binaries is the first one after 0.3.0.
- **Build-only runs.** `binary.yml` run by hand with no tag builds the branch it runs on, tests
  it, and smoke-tests every target on its own platform against `package.json`'s version; the
  `release` job is skipped, so nothing is uploaded. That is how the workflow is checked before a
  release.
- **Logins.** The binary uses the logins in pi's `auth.json` (`~/.pi/agent`, or
  `PI_CODING_AGENT_DIR`), made by pi, the image's pi, or the binary's own console (`tui`, below).

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
├── index.ts            -- entry point: loads the CLI, names a missing pi package
├── cli.ts              -- citty CLI: the headless proxy, or `tui` for the console
├── env.d.ts            -- typed process.env
├── config/
│   ├── schema.ts         -- ProxyConfig Zod schema and types, defaults, repair, JSON I/O (exported via ./config)
│   └── env.ts            -- ServerConfig from file + env + CLI overrides
├── logging/
│   └── index.ts          -- LogTape setup, categories, level guide, redaction (exported via ./logging)
├── server/
│   ├── app.ts            -- Hono app assembly (middleware + routes)
│   ├── routes.ts         -- GET /v1/models, GET /v1/models/:model, the /v1/switchboard/ routes, POST /v1/chat/completions
│   ├── usage.ts          -- GET /v1/switchboard/usage: the stats file's usage over a window
│   ├── cooldowns.ts      -- DELETE /v1/switchboard/cooldowns, and the cooldown shape /healthz/models lists
│   ├── health.ts         -- GET /healthz, /healthz/models, /healthz/creds
│   ├── middleware.ts     -- request-id, proxy-auth, body size limit, disconnect detection
│   ├── errors.ts         -- OpenAI-style error helpers, upstream error mapping
│   ├── request-id.ts     -- piproxy-{random} generation
│   ├── http-status.ts    -- named HTTP status codes
│   ├── startup.ts        -- server flags, config with logging, listener (CLI and console)
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
├── tui/
│   ├── accounts-view.ts  -- the Accounts view's rows: providers, quota used, the login row
│   ├── command.ts        -- `pi-switchboard tui` (citty)
│   ├── console.ts        -- the console: pi-tui screen, server in the same process
│   ├── log-buffer.ts     -- the log view's bounded line buffer
│   ├── log-view.ts       -- the log view's position: following, or pinned when scrolled back
│   ├── login.ts          -- pi's login flow routed to pi's own screens
│   ├── status-refresh.ts -- the status and accounts reads: newest wins, no stale verification
│   └── stderr-capture.ts -- stray stderr writes to the log view, a whole line at a time
└── utils/
    └── guards.ts         -- isRecord() and other type guards
```

### Console (`pi-switchboard tui`, #61)

An opt-in console for running the proxy at a terminal. One process holds the HTTP server, a
full-screen pi-tui view (`TuiAltScreen`) and the proxy's `ModelRuntime`, so the console reads
everything in memory and needs no HTTP surface of its own. Quitting it stops the proxy.

- **Entry.** `src/cli.ts` finds `tui` as the first argument that is neither a flag nor a flag's
  value (`pi-switchboard --port 4000 tui` works), and dispatches it before citty: citty's
  `subCommands` would run the headless `main` after the subcommand. The console module is
  imported dynamically, so the headless proxy never loads pi's interactive UI. Both share
  `src/server/startup.ts`: the server flags, the config with its logging, and the listener,
  which waits until the server listens. Without a terminal on stdin and stdout, `tui` refuses to
  start (exit 1) and names the headless command.
- **Failures.** The server listens before the console takes over the terminal, so a port in use
  fails with the terminal untouched. Once the screen is up, any way out (quit, a signal, an
  error, an uncaught exception) stops the screen, restores stderr and closes the server; on a
  failure the command prints the reason after the last 20 log lines and exits 1. The headless
  CLI reports a port in use as a fatal log line and exit 1.
- **Requests** (`requests-view.ts`; `http-requests.ts`). The first view is a table of every HTTP
  request: `requestLogMiddleware`, registered right after the request ID middleware and so ahead
  of proxy auth and the body size limit, adds each request as it arrives and ends it with its
  status when its answer is ready (a stream's headers). It keeps the method, the path without the
  query (where a caller could put a secret) and cut at 256 characters, the status and the
  timings, never a header, a body or a credential: the last 500 answered requests and, apart from
  them, the last 100 client errors (4xx), so anyone who can reach the port can't flood out the
  rest. A health check shows only once it has failed, as the request log puts passing ones at
  debug: one in flight isn't listed or redrawn for, and one answered with a 2xx isn't kept. The
  console's redraws are coalesced by pi-tui (at most one per 16 ms), so a flood can't storm the
  screen. In memory only, and no HTTP
  route serves it. A chat request's row joins its chat request (`active-requests.ts`) by the
  request ID, which the proxy generates: the model or alias it named, the model that served it,
  the time to its first event, and for a stream the true end, when the stream closed. The right
  columns drop on a narrow view (the ID under 120, the first event under 104, the duration under
  84). The table follows new requests, or stays pinned to a request by its place in the order
  (not by its distance from the bottom) while new ones arrive. `r` switches between it and the raw
  log, each keeping its own position; the mouse wheel scrolls whichever is shown
  (`wheelLines`).
- **Raw log.** LogTape writes into a bounded buffer (`log-buffer.ts`, 5000 lines) instead of stderr,
  with the same redaction, in the `console` layout of the pretty format: the time only, and the
  category without the `pi-switchboard` root, 16 columns wide, so the message starts at column 42.
  While the console runs, a stray stderr write (one that bypasses LogTape) goes into the buffer a
  whole line at a time, marked `[stderr]`, instead of corrupting the screen (`stderr-capture.ts`).
  A line wider than the terminal wraps (pi-tui's `wrapTextWithAnsi`); scrolling still moves by
  log line. A log shorter than the screen starts at the top. The view follows new lines; scrolled
  back with the mouse wheel, the arrow keys or the page keys (`log-view.ts`), it stays on the same
  lines while new ones arrive, and follows again at the newest line or on `End`. The wheel reaches
  the console's root component as a `TuiMouseEvent` (pi-tui's alternate screen captures the mouse
  by default), moving further on a fast spin (`wheelScrollLines: 'auto'`); it scrolls the raw log
  or the Requests table only. The screen's own viewport scrolling would take PgUp and PgDn first, so the console unbinds
  them there.
- **Screen** (`layout.ts`, `screen.ts`, `frame.ts`, `status-strip.ts`). The screen is rendered
  as rows from one input per frame (`consoleScreen`), so a test holds every row to the terminal's
  width (pi-tui throws on a wider one) at every size. `consoleLayout` says where things go: the
  status strip on the first row; on a terminal of 30 rows or more two rows of folder tabs
  (`folderTabs`), the current one opening into the frame's top border; below that the tabs sit in
  the top border, the current one an inverted amber pill; the view inside the frame's side
  borders; the bottom border; the footer. The strip shows the name and version, a `● SERVING`
  badge, the address, proxy auth, exposed and available models (exposure computed as
  `/healthz/models` does), uptime, open connections and active cooldowns, read every 5 s and
  after each login or logout, and on the right the last 30 minutes of finished chat requests as
  a sparkline (from `finishedRequests()`, so under load the oldest minutes may be undercounted;
  the rate carries `+` then) with the rate over the last 5 minutes. Too narrow, the counts drop
  from the end, then the right group, then the version; an exposure-config or models.json error
  is never dropped. The tab row's right end says a word about the view, the bottom border's its
  size. The footer draws keys as chips (`keycap`): the view's keys left, the global keys right
  with `q quit (stops the proxy)` fixed at the end; a narrow footer drops the other global keys
  from the front, then the view's keys from the end. The redesign follows the instrument-panel
  mock an open-design agent drew (`.local/index2.html`, local and not committed; the
  screenshots are in the PR), in five phases (#259–#263): this chrome, the Accounts table,
  plain-number Stats tiles, the Models effort matrix, and the Requests table. What it left out on
  purpose is in #264–#266.
- **Ending cooldowns** (#182). `c` in the Accounts and Models views, the two that show cooldowns
  and list the key, ends every cooldown (`clearCooldownsFor({})`), as
  `DELETE /v1/switchboard/cooldowns` does with no query, then reads the status again. One login's
  or one model's is ended through the route.
- **Settings and restart** (#288; `settings-view.ts`, `console-settings.ts`, `proxy-server.ts`).
  View `5` lists every `proxy-config.json` setting a standalone proxy uses (not `aliases` and
  `labels`, which the Models and Accounts views edit, nor the pi package's `lifetime` and `zed`)
  by when a change applies: the ones `fileConfigReader` reads per request, and proxy auth through
  the `ProxyAuthSwitch`, apply to the next request; the rest are read into `ServerConfig` at
  startup and apply on a restart. A row shows the saved value, the running value while a restart
  is due, and the flag or env var that wins over the file (`buildCliOverrides` and the env, read
  once at start). Each editor checks the value against the schema's bounds and saves the whole
  file with `saveConfigToFile`, never with `replaceInvalidAuthToken` (#82). `r` restarts the HTTP
  server in the process: the config is reloaded with the start's flags (`reloadConfig`, which
  leaves logging as it is), the new server is bound before the old one closes on a new address
  (a failed bind keeps the old one, its config, auth and recorder), and on the same address the
  old listener closes, then the new config binds it or, failing that, the old one binds it again;
  if neither can, nothing listens and the console stops with the reason. Requests in flight
  finish on the old server. Stats are recorded from process-wide events, so `listen`'s
  stop-on-close would have two recorders count the same requests during the handover: the console
  starts the server with `openServer` and moves the recorder itself, one at a time. The log level
  and the Stats view follow the new config once it listens. A frame too narrow for five tabs
  drops the last ones but never the current view's.
- **Sidebar** (`sidebar.ts`). On a terminal at least 100 columns wide, the right 30% (34 to 48
  columns) shows four panels beside the frame, from its top border to its bottom border, with the
  date and time over them on a tall terminal; `s` hides and shows it. QUOTA (each login with its
  label, its quota windows as bars, the time to each reset, `no quota reported`, below-reserve,
  and its cooldowns), IN FLIGHT (the chat requests in flight), RECENT (the last minute's requests
  with the average time and time to a stream's first event, its failures and rejections on a
  second line when any, then the latest finished requests) and SESSION (the route totals summed).
  The proxy's own status is the strip's. Rendering is a function of a snapshot the console
  gathers per frame; a 1 s tick moves the clocks on and counts the server's open connections
  (`getConnections`). Under stress (a cooldown, a login below its reserve, or a request that
  failed or was rejected in the last minute; #215) IN FLIGHT and RECENT come before QUOTA,
  RECENT's title names the minute's failures (or, with none, its rejected requests), and a quiet
  login (no cooldown, not below its reserve, every window under 70%) collapses to one row. The
  usual layout returns a minute after the last failure or rejection, once nothing is cooling down
  or below its reserve: the reorder follows the same window RECENT counts. On a short screen the
  blank rows between panels go first, then SESSION, then RECENT's list down to its summary, then
  the bottom is cut. The requests come from `active-requests.ts`: the chat route adds one
  before
  it dispatches (never message content or a credential), the dispatcher names each attempt's
  model and marks a stream's first event, and the request ends when the dispatch returns or, for
  a stream, when the stream closes. It ends `ok`, `failed` (an error answer, or a stream that
  failed) or `left` (the client disconnected, whatever the answer). A chat request answered before
  the dispatch (proxy auth, the body size limit, validation, an unexposed model, a credential pi
  can't resolve, a remote image or a message it can't convert) is `rejected`, with its status:
  `rejectedChatMiddleware`, mounted on the chat path ahead of the body size limit and proxy auth,
  records any answer the route did not mark as dispatched (`chatDispatched`), with the model the
  request named once its body validated (`chatModel`) (#214). The last 500 finished requests that
  reached a model are kept, and apart from them the last 100 rejected ones: the middleware runs
  before proxy auth, so anyone who can reach the port can send rejected requests, and a flood of
  them must not push out the others. The minute's count reads `500+` (or `100+ rejected`) when a
  list may be missing some of it. Like the route totals, all of it is in memory and no HTTP route
  serves it.
- **Accounts** (`accounts-view.ts`). The logins pi has a credential for (`getCredentialStatuses`,
  as `/healthz/creds`): login type, source and model count; never the credential. A table: a
  status dot (red on a failed verification, yellow while cooling down or below the reserve), the
  login, its label, its kind, its models, each quota window's share used with an eighths gauge
  where the width allows (a narrow view keeps the numbers), and notes for the reserve, the
  soonest cooldown and the verification. Under it, when the view has room for both, a detail pane
  for the selected row: source, each window's gauge and reset, the reserve with the share left,
  each cooldown, the verification, and the actions from `accountActions`. Rendering is a function
  of a snapshot (`accountsSnapshot`, with the quota store and the reserve check passed in as
  lookups); the quota colour rule (`quotaColor`) and the gauge are `panel.ts`'s, shared with the
  sidebar. The table scrolls to keep the selection on screen. `↑` `↓` select a
  row (`navigation.ts`; the selection stays on the list when a logout shortens it), and `Enter`
  opens that provider's actions in pi's `ExtensionSelectorComponent`: verify, log in again (or a
  new API key), log out. A last row opens pi's login selector, as `n` does. `v` verifies them all,
  which may refresh an OAuth token, and the result stays until that provider's next login or
  logout. A verification still running when a provider's login changes drops its result for
  that provider, which was about the old credential (`status-refresh.ts`).
- **Navigation.** `←` `→`, `Tab` and `Shift+Tab` move between the views, wrapping around; `1`
  to `4` jump to one. `↑` `↓` act on the view shown: scrolling in Requests, selection in Accounts and
  Models. The footer sits on the screen's last row and lists the current view's keys as chips,
  with the global keys at the right end (see **Screen**).
- **Stats** (`dashboard.ts`, #216). A dashboard over the stats store, for one of three windows:
  today (from local midnight), the last 7 days, or all 30 days kept; `t` `w` `a` pick one. The
  console opens the stats file itself, beside the recorder's connection (WAL lets it read while
  the recorder writes), and reads a snapshot at most every 5 s for one window and chart width, so
  the redraws that every request causes don't query the file. Window pills (the current one
  amber), then tiles of plain numbers (sums of the per-model numbers, the averages weighted by
  requests; six from 110 columns, four under), then panels: TIMELINE (one bar per column, the
  bucket size rounded up so the window fits, bars drawn in eighths of a row against the busiest
  bucket and ending under `now`; a bucket's failed and rejected requests are stacked at the foot
  of its bar, at least one cell, red when any failed and yellow when they were only rejected,
  since coloring a whole bar would mark nearly every busy bar), MODELS, ALIASES (only when a
  request named an alias, since direct requests alone would repeat the totals; `direct` for
  those), the two tables with the same columns, fallbacks included; then one errors line (failed
  and rejected requests, failed attempts by class, rejections by status). The timeline takes the
  room the tables don't need, 3 to 16 rows of bars; on a short screen the bars past 3 give way
  first, then the tables' rows past one (`+N more`), then the tiles, then the bottom is cut
  (`dashboardLayout`). Today's cost for the status strip is read by its own source
  (`createTodayCostSource`, also every 5 s) so it doesn't push out the dashboard's snapshot; it is
  `undefined`, and the strip leaves it out, whenever the view shows the totals instead. With stats
  off or a file that won't open, the view falls back to #70's in-memory route totals
  (`stats-view.ts`), one row per alias × served model plus a total, under a line that says why. A
  read that fails once the file is open (the dashboard's or the strip's cost) is logged once and
  both fall back for the rest of the session, rather than trying again (and maybe waiting out the
  busy timeout) on every redraw. Panels, label-value lines and compact numbers are shared with the
  sidebar (`panel.ts`).
- **Models** (`models-view.ts`, `console-models.ts`, `aliases.ts`; #230). The exposed models
  as a matrix, grouped by provider in the order they first appear: a dot under each of
  `REASONING_EFFORTS` the model runs at as asked (`supportedReasoningEfforts`), then any cooldown
  (the time left, `3m00s`, and the reason when it fits). Then an ALIASES box, beside the matrix
  from 151 columns and under it otherwise: every configured alias with its targets, each target's effort,
  `fallbackOn`, and its diagnostics in red, wrapped onto more lines rather than cut, then **+ New
  alias…**. The selection order is the matrix's (`modelsItems` walks the same provider groups),
  so `Enter` acts on the row marked. The matrix and the box each scroll to keep the selection on
  screen; a view under ten rows shows only the part with the selection. `Enter` on a model
  starts an alias for it, on an alias opens its menu (rename; targets and efforts: add, set the
  effort, move up or down, remove; fall back on, a checkbox list over the failure classes;
  delete), and on the last row starts a new alias. A target is picked from the exposed models and
  its effort from that model's ladder (or the request's), so the editor can't write an alias the
  proxy would leave out. A name that is empty, has whitespace, is an exposed model's public or
  canonical ID, or is another alias's is refused with the reason, and the question asked again.
  Each change is saved at once through `saveConfigToFile`, written in the shortest form the schema
  reads (a plain ID for one target without an effort or fallback classes), keeping the alias's
  place in the file; the proxy reads the file per request, so the next request uses it. Each save
  is logged at info with the alias name. pi's selector has no initial index, so after a checkbox
  is ticked the cursor returns to the top.
- **Logins** (constitution 3.5.0: Scope and principle III). pi runs every flow and stores every
  credential; the console only shows pi's own screens, in a local terminal, never over HTTP.
  `n` opens pi's provider selector (`OAuthSelectorComponent`, every account and API-key login pi
  offers); the login runs on pi's `LoginDialogComponent`, with pi's `ExtensionSelectorComponent`
  for a choice such as the login method, driving `ModelRuntime.login` on the runtime the server
  answers from, so the provider's models are served at once, with no restart. pi keeps the
  routing from its prompts and events to those screens private, so `login.ts` repeats it, with
  pi's installation device ID (Sign in with ChatGPT refuses to start without one) and pi's catalog
  refresh after the login. pi's sign-in callback servers (such as `127.0.0.1:1455` for ChatGPT)
  and its paste-the-URL fallback work unchanged; Esc cancels and closes them. `x` logs out of a
  credential pi stored (`ModelRuntime.logout`). pi's dialog shows a typed API key as it is typed,
  as pi's own `/login` does. The console binds pi's `app.message.copy` key (Ctrl+X, as in pi), so
  the dialog's sign-in URL can be copied.
- **Theme** (`theme.ts`, `tokyonight-storm.ts`). Tokyo Night Storm, in true color where the
  terminal has it and else the nearest of 256 colors. The palette is data in
  `tokyonight-storm.ts` (pi's theme tokens, from the pi theme `tokyonight-storm.json`), with no
  import of pi's code, so the logging module colors the console's log view from it too.
  `installConsoleTheme()` builds pi's `Theme` from it with pi's public constructor, which checks
  every token pi requires. pi loads a named theme only from `~/.pi/agent/themes`, which the console
  doesn't write to, so the console installs that `Theme` under the key pi keeps its global theme
  on (`Symbol.for('@earendil-works/pi-coding-agent:theme')`), and pi's dialogs (login, selectors)
  draw with it. That key is pi's, not public API: the console calls `initTheme()` first, so a pi
  that moves it keeps its system theme in the dialogs. The console's own text is colored by role
  (`paint`, `strong`, `highlight`, `activeTab`, `tabAccent`, `badge`, `keycap`); the status strip
  sits on `bgHighlight` (`chrome()`), the frame, sidebar and footer on the plain background. A
  chrome row may already be styled, so the background is set again after every reset inside it.
  The instrument panel's amber is the theme's yellow, named once as `tabAccent` (the current
  tab's outline, the tab digits, the strip's mark and cost figures); the compact tabs' current
  pill is that amber inverted; the `SERVING` badge is success on `toolSuccessBg`; a footer key is
  bold on `selectedBg`. Inversion and bold go through pi-tui's `styleText`, because the theme's
  own `inverse` and `bold` go through chalk, which emits nothing in the console. A
  non-empty `NO_COLOR` turns all of it off: plain text, pi's system theme, and an uncolored log
  view.

### Stats store (`src/stats/`, #216)

Per-minute counts of the chat traffic, kept across restarts for the console's Stats view. On by
default (`stats`, `--no-stats`, `PI_SWITCHBOARD_STATS=false`).

- **Storage.** `node:sqlite` (`DatabaseSync`), built into Node 24 and into Bun, which compiles the
  standalone binary: no dependency. The file is `pi-switchboard-stats.sqlite` in pi's agent dir,
  in WAL mode, so a console can read while proxies in other processes write. The busy timeout is
  250 ms: `node:sqlite` waits synchronously, on the thread that serves requests, so a write that
  can't get the lock in time is dropped rather than stalling every request in flight. `PRAGMA
  user_version` holds the schema version; a file from a newer proxy is refused.
- **Tables** (`store.ts`), each keyed by the minute: `request_minutes` (finished requests by
  alias, model, outcome and, for a rejected one, status, with total and longest duration and the
  total time to a stream's first event), `attempt_minutes` (#70's attempts, failures, fallbacks,
  tokens and cost by alias and served model) and `failure_minutes` (failed attempts by model and
  class). Routes, counts and timings only: never message content, the request's `user`, or a
  credential. A rejected request's model is the name the client sent, so it is cut to 128
  characters, and past 20 distinct names in a minute the rest are filed as `(other)`. Queries: a
  timeline in buckets with empty ones filled in, per-model and per-alias numbers (one query
  grouped by either column, `usageBy`), and failures by class with rejected requests by status.
  Readers: the console's Stats view and `GET /v1/switchboard/usage`.
- **Recording** (`recorder.ts`). Route totals emit typed events (`RouteEvent`) and the requests
  tracker passes each finished request to its listeners; the recorder adds them up per minute and
  route in memory and writes them every 5 s in one transaction, and when the server closes or the
  process exits (the store writes synchronously, so an `exit` handler can). A write that fails is
  logged and its rows dropped: stats never hold up or fail a request. Rows older than 30 days are
  pruned on start and about every hour.
- **Started by `listen()`** (`server/startup.ts`), for the headless proxy and the console alike, so
  the console's history covers every proxy that writes to the same agent dir. `createApp` alone
  (the tests) records nothing. A file that can't be opened is a warning and no stats, never a
  failed start.

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
- usage logging: each upstream call's result line (`pi.complete`, at `debug`) has its tokens and
  cost, streamed or not, with its `alias` and `attempt` (#70); running totals per route are kept in
  memory ("Usage by route (#70)")

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
