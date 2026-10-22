# TODO

Actionable implementation checklist for `pi-switchboard`.

Read `PLAN.md` first. This file should track concrete work items and decisions needed to implement that plan.

## Phase 0 — Contract lock

### API and routing

- [x] Document the canonical external model ID format: `provider/model-id`
- [x] Document shorthand model resolution rules
- [x] Document the ambiguous shorthand error shape
- [x] Confirm how Hono route matching will support encoded slash-containing model IDs
- [x] Decide whether to expose any non-standard metadata under `x_pi`

### Authentication and headers

- [x] Reserve `Authorization` for proxy authentication compatibility
- [x] Choose the upstream override header name: `X-Switchboard-Upstream-Api-Key` (implemented)
- [x] Decide whether proxy auth exists in v1 or stays disabled by default
- [x] Decide whether to accept and return `X-Client-Request-Id` / `X-Request-Id`

### Request compatibility policy

- [x] Freeze the Phase 1 supported request fields
- [x] Freeze the Phase 2 supported request fields (documented in PLAN.md)
- [x] Freeze the explicit rejection list
- [x] Decide whether unknown top-level fields are always rejected with `422`
- [x] Decide how `developer` role content is merged into the effective system prompt

### Streaming contract

- [x] Define the initial chunk shape for streamed responses
- [x] Define tool-call delta chunk sequencing rules
- [x] Define final usage chunk behavior for `stream_options.include_usage`
- [x] Define behavior when the stream aborts before final usage is available
- [x] Decide whether any non-standard reasoning deltas are exposed at all

### Security policy

- [x] Decide whether remote image URLs are enabled in the stable proxy (behind the remote-images setting, off by default; [#109](https://github.com/vx-daniel/pi-switchboard/issues/109))
- [x] If enabled, document SSRF protections and size limits (PLAN.md, "Image URL fetching"; README, "Security defaults")
- [x] Document bind-host defaults
- [x] Document any future remote exposure guidance
- [x] Mark agentic mode experimental and disabled by default

## Phase 1 — Stable core proxy

### Project setup

- [x] Initialize `package.json`
- [x] Configure `tsconfig.json` for strict TypeScript
- [x] Configure Biome (since replaced by Vite+, see Fork maintenance)
- [x] Configure oxlint (now run through Vite+)
- [x] Choose the npm build tool and align docs and config
- [x] Add Hono
- [x] Add `@earendil-works/pi-coding-agent`
- [x] Add `@earendil-works/pi-ai`
- [x] Add Zod
- [x] Add test tooling
- [x] Add `src/index.ts`

### Config and bootstrap

- [x] Create env/config loading module
- [x] Add host and port configuration
- [x] Add proxy auth config placeholders if supported
- [x] Add feature flags for experimental capabilities

### Core pi integration

- [x] Create `AuthStorage` integration (replaced by `ModelRuntime` in the Pi 1.x migration)
- [x] Create `ModelRegistry` integration (replaced by `ModelRuntime` in the Pi 1.x migration)
- [x] Surface model-registry load errors clearly at startup and in logs
- [x] Implement model lookup by canonical ID
- [x] Implement shorthand lookup with ambiguity detection
- [x] Implement per-request upstream key override without using `Authorization`

### Models endpoints

- [x] Implement `GET /v1/models`
- [x] Return `{ object: "list", data: [...] }`
- [x] Return items shaped like `{ id, object: "model", created, owned_by }`
- [x] Decide and document what `created` means for pi-backed models
- [x] Implement `GET /v1/models/{model}` with encoded ID support
- [x] Return OpenAI-style `404` when a model is not found

### Request parsing and validation

- [x] Create Zod schemas for the Phase 1 request contract
- [x] Validate request body shape before model resolution
- [x] Reject unsupported fields with clear `422` errors
- [x] Normalize `max_tokens` and `max_completion_tokens`
- [x] Validate `X-Client-Request-Id` if present

### Message conversion

- [x] Convert `system` messages into the effective system prompt
- [x] Convert `developer` messages into the effective system prompt
- [x] Convert `user` text messages into pi user messages
- [x] Convert `assistant` text history into pi assistant messages
- [x] Convert `tool` messages into pi tool result messages
- [x] Reject unsupported content parts clearly

### Non-streaming completions

- [x] Route non-streaming requests to `completeSimple()` (now `streamSimple()`, reading the stream's final message, as `completeSimple()` does)
- [x] Build OpenAI-style non-streaming response objects
- [x] Map finish reasons conservatively
- [x] Map usage fields from pi `Usage`
- [x] Handle upstream failures through normalized error responses

### Streaming completions

- [x] Route streaming requests to `streamSimple()`
- [x] Build SSE encoder for OpenAI chat-completions chunks
- [x] Emit first chunk with assistant role
- [x] Emit text deltas as `choices[0].delta.content`
- [x] Emit `[DONE]` at stream end
- [x] Cancel upstream work on client disconnect
- [x] Ensure listener and abort-controller cleanup on all paths

### Errors and observability

- [x] Implement normalized OpenAI-style error response helper
- [x] Generate per-request proxy request IDs
- [x] Accept and log `X-Client-Request-Id` if present
- [x] Capture upstream request IDs where available
- [x] Add structured request logging
- [x] Log aborts, disconnects, and upstream timeouts distinctly

### Stable-phase tests

- [x] Unit test model ID parsing
- [x] Unit test shorthand ambiguity handling (via integration test)
- [x] Unit test message-role conversion
- [x] Unit test finish reason mapping
- [x] Unit test usage mapping
- [x] Golden test `GET /v1/models`
- [x] Golden test `GET /v1/models/{model}`
- [x] Integration test model-not-found flow
- [x] Integration test upstream-auth-missing flow
- [x] Integration test client-disconnect cancellation (abort controller wired)

## Phase 2 — Tools and richer compatibility

### Tools

- [x] Define the supported JSON Schema subset for function tools
- [x] Implement JSON Schema -> TypeBox conversion for the supported subset
- [x] Reject unsupported schemas with `422`
- [x] Convert OpenAI `tools` into pi tool definitions
- [x] Convert assistant `tool_calls` history into pi tool-call content
- [x] Convert `tool` role results back into pi tool-result messages
- [x] Support `tool_choice` where compatible (forwarded per provider via `onPayload`, see Phase 3C)

### Streaming tool calls

- [x] Map `toolcall_start` to OpenAI tool-call delta initialization
- [x] Map `toolcall_delta` to argument streaming
- [x] Preserve stable tool-call IDs and indexes across chunks
- [x] Emit final finish reason `tool_calls` when appropriate

### Usage in streaming

- [x] Support `stream_options.include_usage`
- [x] Emit the final empty-choices usage chunk when requested
- [x] Document that interrupted streams may not include usage

### Additional request fields

- [x] Support `reasoning_effort` (mapped to pi ThinkingLevel)
- [x] Decide which fields are direct passthrough vs allowlisted transformation
- [x] Support `response_format` (text, json_object via onPayload passthrough)
- [x] Support `top_p` (via onPayload passthrough)
- [x] Support `frequency_penalty` (via onPayload passthrough)
- [x] Support `presence_penalty` (via onPayload passthrough)
- [x] Support `seed` (via onPayload passthrough)

### Images

- [x] Support base64 image data in user message parts
- [x] Decide whether remote image URL fetching is enabled (behind the remote-images setting, off by default; [#109](https://github.com/vx-daniel/pi-switchboard/issues/109))
- [x] If enabled, implement SSRF protections, timeout, redirect, and size limits (`src/openai/remote-image-fetch.ts`: public addresses only with pinned DNS, 3 redirects, 5 s connect and 10 s total, 15 MiB streamed cap, image content types, 8 per request)
- [x] Validate image MIME types and payload sizes

### Phase 2 tests

- [x] Unit test supported and rejected tool schemas
- [x] Unit test JSON Schema -> TypeBox conversion
- [x] Integration test tool acceptance and rejection

## Phase 3 — Hardening and packaging

### Runtime hardening

- [x] Add request body size limits
- [x] Add upstream timeout defaults
- [x] Add graceful shutdown
- [x] Ensure in-flight streams are handled cleanly on shutdown
- [x] Decide whether any retries are appropriate and where they are forbidden

### Release engineering

- [x] Add CI typecheck
- [x] Add CI lint
- [x] Add CI tests
- [x] Add npm packaging validation
- [x] Verify README examples against the implemented API

### Compatibility testing

- [x] Smoke test with `curl`
- [ ] Smoke test with Open WebUI
- [ ] Smoke test with Continue
- [ ] Smoke test with Aider
- [x] Record known compatibility gaps in docs

## Phase 3A — Model exposure and identifier controls

### Contract and config

- [x] Replace the public models-path contract with standard OpenAI model objects only
- [x] Remove `x_pi` from `/v1/models` and `/v1/models/{model}`
- [x] Add `publicModelIdMode`: `collision-prefixed` | `universal` | `always-prefixed`
- [x] Add `modelExposureMode`: `all` | `scoped` | `custom`
- [x] Add `customModels` and `providerPrefixes` to shared config
- [x] Delegate `scoped` mode to pi's `SettingsManager.getEnabledModels()`
- [x] Normalize and persist custom model selections as canonical IDs only
- [x] Validate duplicate prefix labels explicitly
- [x] Validate invalid `universal` mode collisions explicitly

### Shared model-exposure engine

- [x] Add a shared module that derives the exposed model set from config + available models
- [x] Compute public IDs from the active ID mode
- [x] Build provider conflict groups for `collision-prefixed` mode
- [x] Prefix all providers in a connected conflict group, not only colliding models
- [x] Build reverse lookup maps for public ID -> canonical model and canonical ID -> exposed model
- [x] Ensure hidden models cannot resolve through canonical fallback

### Server integration

- [x] Route `GET /v1/models` through the shared model-exposure engine
- [x] Route `GET /v1/models/{model}` through the shared model-exposure engine
- [x] Route chat request model resolution through the shared model-exposure engine
- [x] Resolve exact public IDs before canonical fallback
- [x] Keep canonical fallback only for models that remain exposed
- [x] Return explicit config errors when the exposure policy is invalid

### Compatibility refresh

- [x] Expand `reasoning_effort` enum to `none`, `minimal`, `low`, `medium`, `high`, `xhigh`
- [x] Support `response_format: { type: "json_schema" }`
- [x] Prefer `max_completion_tokens` over deprecated `max_tokens` in docs and validation messaging
- [x] Re-evaluate which current OpenAI chat fields remain explicitly rejected vs deferred (moved to Phase 3D)

### Pi extension UX

- [x] Refactor `/proxy` extension config handling around a controller pattern
- [x] Add public ID mode and exposure mode to the main settings panel
- [x] Add `/proxy verify`
- [x] Add provider selector UI for `scoped` mode (removed in 97db649: `scoped` now follows pi's `enabledModels`, set with `/scoped-models`)
- [x] Add searchable model selector UI for `custom` mode
- [x] Add prefix override editing flow (removed from the panel in 97db649; `providerPrefixes` is set in `proxy-config.json`)
- [x] Add effective public-ID preview to `/proxy show` and the settings UI (`/proxy show` lists the exposed public IDs; the settings panel no longer shows a preview)

### Tests and docs

- [x] Add unit tests for exposure filtering and public ID generation
- [x] Add unit tests for provider conflict-group behavior
- [x] Add unit tests for invalid universal mode and duplicate prefix labels
- [x] Add integration tests for all/scoped/custom exposure modes
- [x] Add integration tests for public ID resolution and canonical fallback restrictions
- [x] Update `PLAN.md`, `ROADMAP.md`, and `README.md` to match the new model exposure contract

## Phase 3B — SDK conformance and robustness testing

### Pre-work

- [x] Remove dead `src/pi/resolve-model.ts` and `test/unit/resolve-model.test.ts`
- [x] Add `openai` as explicit devDependency (currently transitive via pi-ai)

### Wire-level SSE conformance (no credentials)

- [x] Each chunk has `id`, `object: "chat.completion.chunk"`, `created` (number), `model`
- [x] `delta.role` is `"assistant"` on first chunk only
- [x] `delta.content` is a string, never `undefined` when text is present
- [x] `finish_reason` is `null` on intermediate chunks, correct value on final content chunk
- [x] Tool call delta chunks: `delta.tool_calls[n].index`, `.id`, `.type`, `.function.name`, `.function.arguments`
- [x] Usage chunk: `choices` is empty array, `usage` has `prompt_tokens`, `completion_tokens`, `total_tokens`
- [x] Final line is `data: [DONE]\n\n`

### Non-streaming response conformance (no credentials)

- [x] Required fields: `id`, `object: "chat.completion"`, `created`, `model`, `choices`, `usage`
- [x] `choices[0].finish_reason` is never `null`
- [x] `choices[0].message.role` is `"assistant"`
- [x] `choices[0].message.content` is `string | null` (explicitly `null` when tool_calls present)
- [x] `choices[0].message.tool_calls` shape: `id`, `type: "function"`, `function.name`, `function.arguments`
- [x] `usage` fields are all numbers
- [x] Every stable response, stream chunk and error body validates against OpenAI's published spec, pinned (#132)
- [x] Request fields and enum values checked against OpenAI's request both ways; each one not accepted is listed (#132)

### SDK round-trip conformance (requires credentials, skip otherwise)

- [x] `client.models.list()` succeeds and returns iterable model objects
- [x] `client.models.retrieve(id)` succeeds for an exposed model
- [x] Non-streaming text completion parses without SDK errors
- [x] Streaming text completion parses all chunks without SDK errors
- [x] Non-streaming tool call parses without SDK errors
- [x] Streaming tool call parses all chunks without SDK errors
- [x] `stream_options.include_usage` usage chunk parses without SDK errors

### Security tests (no credentials)

- [x] Blocked localhost image URL returns error
- [x] Blocked private-range image URL returns error
- [x] Oversized image payload rejected

## Phase 3C — Known gaps and silent drops

Issues identified by code audit. These violate the project's own policy of rejecting
unsupported parameters clearly instead of silently ignoring them.

### `tool_choice` silent drop

- [x] Forward `tool_choice` to upstream via `onPayload` passthrough in `collectPayloadFields()`
- [x] Add unit test verifying `tool_choice` is included in `onPayload` passthrough

### `strict` on function tools silent drop

- [x] ~~Forward `strict` flag via `onPayload` by patching the upstream payload~~ (reached chat completions only)
- [x] Map `strict: true` to pi's `constrainedSampling` ("prefer"), applied per API by pi (#44)
- [x] Integration tests per API family: completions, Responses, Anthropic, fallback, strict off

### PLAN.md documentation drift

- [x] `anyOf` is correctly listed as supported in PLAN.md (TODO item was stale)
- [x] Update PLAN.md known gaps section to reflect resolved `tool_choice` and `strict` fixes

## Pi 1.x migration [DONE]

- [x] Depend on `@earendil-works/pi-*` `^1.3.0` (Pi 1.0 is the first release whose Anthropic client sends Claude Code 2.1.280, which Opus 5.5 requires)
- [x] Replace `AuthStorage` + `ModelRegistry.create()` with the async `ModelRuntime`; completions run through it
- [x] Map the `pending` and `deferred` stop reasons to `stop`
- [x] Report cache reads and writes in `usage.prompt_tokens`, with `prompt_tokens_details`
- [x] Refresh the extension's model registry on each entry point (`ctx.modelRegistry`)
- [ ] Run the conformance suite against live models on Pi 1.x

## Phase 3D — Compatibility analysis and resilience [DONE]

Analysis document: `docs/engineering/phase-3d-analysis.md`

### `parallel_tool_calls` — promoted to passthrough

- [x] Survey how major clients handle `parallel_tool_calls` (Zed, Continue, Aider, Open WebUI)
- [x] Determine whether the pi SDK's providers pass through or strip `parallel_tool_calls`
- [x] Decision: accept + forward via `onPayload` (Continue sends `false`, was getting 422)
- [x] Remove from `rejectedFields`, add to schema, add `onPayload` passthrough
- [x] Update Zed sync capabilities to `parallel_tool_calls: true`
- [x] Add unit tests for acceptance and passthrough

### Re-evaluate rejected fields — audited

- [x] Audit the full `rejectedFields` list against current OpenAI API and common client usage
- [x] Promote `metadata` (Open WebUI sends it) and `prediction` (Continue sends it) to passthrough
- [x] Keep `n`, `logprobs`, `top_logprobs`, `logit_bias` rejected (no SDK support, no client need)
- [x] Keep `functions`, `function_call` rejected (deprecated)
- [x] Document rationale for each rejection in PLAN.md and `rejectedFields` inline comments

### Proxy-side resilience — documented as intentional

- [x] Evaluate concurrency limiter — not needed for local single-client proxy
- [x] Evaluate circuit breaker — not needed, would interfere with client retry logic
- [x] Document stateless/no-retry architecture as intentional design choice in PLAN.md
- [x] Add structured `upstream_overload` warn-level logging for 429 and 503 responses

## Fork maintenance [DONE]

- [x] Add a `chat_request` log line naming the requested and the resolved model of each chat request (idea from laixintao/pi-openai-proxy, implemented independently)
- [x] Replace Biome, standalone Oxlint, tsdown, `bun test`, `tsc`, lefthook, and mise with Vite+ (`vite.config.ts`, `.vite-hooks/`)
- [x] Port Biome-only rules to Oxlint (built-ins plus `lint/repo-rules.ts`)
- [x] Copy the Viaanix oxc-config v4.0.0 rules into `vite.config.ts` and make the code pass them (extension split into `extensions/proxy/`)
- [x] Run the proxy on Node (`@hono/node-server`); the extension spawns it with pi's own runtime
- [x] Remove stale `.specify/` scaffolding and `NEXT.md`

## Rename to pi-switchboard [DONE]

- [x] Leave the fork network (issues and PRs kept) and rename the repo to `vx-daniel/pi-switchboard` (#65)
- [x] Package `@vx-daniel/pi-switchboard`, bin `pi-switchboard`, log root category `pi-switchboard`
- [x] Env vars `PI_PROXY_*` → `PI_SWITCHBOARD_*`; an old one still set is warned about, an old auth token refuses to start
- [x] Header `X-Pi-Upstream-Api-Key` → `X-Switchboard-Upstream-Api-Key`; the old one answers 400
- [x] README "Attribution" and "Coming from pi-openai-proxy"; LICENSE keeps the original copyright
- [x] Versions restart at 0.1.0: `pi-switchboard-v${version}` tags, baseline tag on `main`, breaking → minor while 0.x
- [x] Publish the package under the new name (#59): GitHub Packages, from each release tag

The sections above are done and kept as history. The ones below follow `ROADMAP.md`'s numbering
since the rename; each issue holds the detailed checklist.

## Phase 4 — Distribution

- [x] The pi package on GitHub Packages, `pi install npm:@vx-daniel/pi-switchboard` (#59)
- [ ] The pi package on npmjs, so installing needs no token (later, by choice)
- [x] Docker image (#60): built from source, published to Docker Hub and GHCR on each release
      (amd64, arm64)
- [ ] Standalone binary (#61)

## Phase 5 — Routing across pi's logins

Constitution principle VI applies to each item: configured explicitly, exposure-bound, and the
serving model and login reported under `x_pi` and in the log.

- [x] Aliases (#66): `aliases` in `proxy-config.json`, listed while the target is exposed, `x_pi.alias`, a shadowing alias reported in `/healthz/models`
- [x] Fallback chains (#67): `{ targets, fallbackOn }` aliases, fallback only on the named failure classes before the response starts, `x_pi.attempts`, every hop logged
- [x] Cooldowns after rate limits (#68): a 429 cools the provider, a 503 the model, for the time the response gives (else 60 s, 180 s, doubling); chains that name the class skip it; shown on `/healthz/models`, `/v1/switchboard/models` and `x_pi.attempts`
- [ ] Quota awareness (#69): research and tracking done (the headers each subscription sends; the latest report on `/healthz/creds` and `/v1/switchboard/models`); routing on a reserve still to decide
- [ ] Usage and cost by route (#70): done are the `alias` and `attempt` on the upstream log lines and the running totals per alias × provider × model in memory (`src/server/route-totals.ts`), for the console (#61); open is whether to serve them at `GET /healthz/usage`

## Phase 6 — More of OpenAI's API

- [ ] Responses API, stateless (#140): experimental first, then added to PLAN's "Stable surface"
- [x] `prompt_cache_key` → pi's `sessionId`, 64-character limit, Zed capability on (#39)

## Open decisions

- [ ] Proxy auth and upstream failure contract (#128): item 5 done (an upstream 400 or 422 is
      `400 upstream_invalid_request`, #147); items 1–4 open

## Later, not planned: experimental agentic mode

Kept for when it is picked up: a separate opt-in endpoint, never under an OpenAI route (PLAN
"Agentic mode" has the security requirements).

- [ ] Define the endpoint, its SSE event contract and its session identifier contract
- [ ] `AgentSession` lifecycle wrapper, events bridged to SSE, session persistence and resume
- [ ] cwd allowlist with no client-controlled escape; extension loading off by default; tool allowlist
- [ ] Tests for session creation and resume, streamed tool events, cwd and extension policy

## Documentation follow-through

- [x] Keep `README.md` aligned with the supported endpoint and feature set
- [x] Keep `ROADMAP.md` aligned with `PLAN.md`
- [x] Keep this file focused on concrete action items only
- [x] Document all silent-drop fields and their resolution plan
- [x] Add "Known gaps" tracking to `PLAN.md`
- [x] Request parameters and the chat body validated and documented by hono-openapi's `validator()`, with the 400/422 split kept; `app.onError` answers thrown errors in OpenAI's shape
- [x] Publish the API as an OpenAPI document at `/v1/switchboard/openapi.json`, committed as `openapi.json` and checked against the routes (#129)
- [x] Opt-in Swagger UI at `/docs` (`docsUi`), Swagger UI pinned on the CDN; the document covers every route (#129)
