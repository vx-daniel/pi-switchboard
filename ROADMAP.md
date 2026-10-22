# Roadmap

This file is the short phase summary. See `PLAN.md` for the detailed implementation contract and `TODO.md` for the actionable checklist.

## Phase 0 — Contract lock [DONE]

Freeze the API and security decisions before implementation starts.

- [x] Finalize model ID strategy and encoded route handling
- [x] Finalize auth override strategy
- [x] Finalize supported request field matrix
- [x] Finalize SSE chunk contract
- [x] Finalize error contract
- [x] Finalize image-fetch security policy
- [x] Mark agentic mode experimental

## Phase 1 — Stable core proxy [DONE]

Deliver the minimum production-capable proxy.

- [x] Scaffold the project and core modules
- [x] Integrate `AuthStorage` and `ModelRegistry`
- [x] Implement `GET /v1/models`
- [x] Implement `GET /v1/models/{model}`
- [x] Implement non-streaming `POST /v1/chat/completions`
- [x] Implement streaming `POST /v1/chat/completions`
- [x] Implement request IDs, structured logs, and disconnect cancellation
- [x] Implement OpenAI-style errors
- [x] Add unit and integration tests for the stable contract
- [x] Align strict tooling with pi-acp (oxlintrc, biome, lefthook, commitlint, Zod v4); since replaced by Vite+, see Fork maintenance

## Phase 2 — Tools and richer compatibility [DONE]

Add the supported compatibility surface deliberately.

- [x] Support OpenAI function tools subset (JSON Schema -> TypeBox)
- [x] Support assistant `tool_calls` and `tool` role messages
- [x] Support `stream_options.include_usage`
- [x] Support base64 image inputs
- [x] Support `reasoning_effort` (mapped to pi ThinkingLevel)
- [x] Add passthrough parameters: `top_p`, `frequency_penalty`, `presence_penalty`, `seed`, `response_format`
- [x] Add JSON Schema conversion and tool acceptance/rejection tests
- [x] Remote image URL support, behind the remote-images setting (off by default) with SSRF protections ([#109](https://github.com/vx-daniel/pi-switchboard/issues/109))

## Phase 3 — Hardening and packaging [DONE]

Prepare the stable proxy for release.

- [x] Add request size limits (50 MB default, configurable)
- [x] Add upstream timeout defaults (120s, configurable)
- [x] Add graceful shutdown (SIGTERM/SIGINT with 10s drain)
- [x] Add per-request upstream API key override (`X-Switchboard-Upstream-Api-Key`)
- [x] Add image MIME type and payload size validation
- [x] Add CI gates (GitHub Actions: typecheck, lint, test, build, package)
- [x] Package for npm release (`@victor-software-house/pi-openai-proxy` upstream; `@vx-daniel/pi-switchboard` here, since the rename below)
- [ ] Run compatibility smoke tests with target clients (Open WebUI, Continue, Aider)

## Phase 3A — Model exposure and identifier controls [DONE]

Standardize model exposure and make public IDs configurable.

- [x] Remove `x_pi` from the standard models endpoints
- [x] Add configurable public ID modes: `collision-prefixed`, `universal`, `always-prefixed`
- [x] Add configurable exposure modes: `all`, `scoped`, `custom`
- [x] Add provider prefix overrides and explicit validation
- [x] Use a shared exposure/resolution layer for models listing, detail lookup, and chat requests
- [x] Refresh compatibility support for `reasoning_effort` and `response_format.json_schema`
- [x] Refactor the `/proxy` extension around a controller-backed config flow
- [x] Add `/proxy verify` and selector UIs for scoped providers and custom models
- [x] Prefer `max_completion_tokens` over deprecated `max_tokens` in docs and validation messaging

## Phase 3B — SDK conformance and robustness testing [DONE]

Validate response shapes against the official OpenAI Node SDK to catch field-level bugs that break real clients.

- [x] Remove dead code (`resolve-model.ts`)
- [x] Add `openai` as explicit devDependency
- [x] Wire-level SSE conformance tests (chunk shape, `finish_reason` lifecycle, tool deltas, usage chunk, `[DONE]`)
- [x] Non-streaming response conformance tests (`ChatCompletion` shape, `content` nullability, `tool_calls`)
- [x] SDK round-trip conformance tests using `openai` client with `_strict_response_validation: true`
- [x] Security tests (image URL blocking, oversized payloads)
- [x] Code audit identified gaps in tool_choice forwarding, strict mode, and PLAN.md drift — tracked in Phase 3C

## Phase 3C — Known gaps and silent drops [DONE]

Address issues found by code audit that violate the project's policy of rejecting unsupported parameters clearly.

- [x] Fix `tool_choice` silent drop: forward via `onPayload` passthrough
- [x] Fix `strict` on function tools: forward via `onPayload` payload patching
- [x] Update PLAN.md known gaps section (tool_choice resolved, strict resolved, parallel_tool_calls analyzed)
- [x] `anyOf` documentation was already correct (TODO item was stale)

## Pi 1.x migration [DONE]

- [x] Move to Pi 1.x (`ModelRuntime`); fixes the Claude Code client-version gate for Opus 5.5 and Fable 5.1
- [x] `usage.prompt_tokens` counts cached tokens, with `prompt_tokens_details`
- [ ] Run the conformance suite against live models on Pi 1.x

## Phase 3D — Compatibility analysis and resilience [DONE]

Research-backed decisions on deferred compatibility and resilience items. Analysis: `docs/engineering/phase-3d-analysis.md`.

- [x] Promote `parallel_tool_calls` to `onPayload` passthrough (Continue was getting 422)
- [x] Promote `metadata` (Open WebUI sends it) and `prediction` (Continue sends it) to passthrough
- [x] Audit all `rejectedFields`: keep `n`, `logprobs`, `top_logprobs`, `logit_bias`, `functions`, `function_call`
- [x] Document resilience architecture as intentional (no concurrency limiter, no circuit breaker, no retry)
- [x] Add structured `upstream_overload` warn-level logging for 429 and 503 responses
- [x] Add API-aware payload translation for Anthropic (tool_choice, stop, parallel_tool_calls, user, top_p)
- [x] Add generation-config patching for Google (topP, stopSequences, seed, frequencyPenalty, presencePenalty, tool_choice); written flat on `config` since #110, where `@google/genai` reads them
- [x] Add restricted passthrough for Codex Responses API (tool_choice + parallel_tool_calls only)
- [x] Verified with real providers: Claude, Gemini, gpt-5.4-mini
- [ ] Run compatibility smoke tests with target clients (Open WebUI, Continue, Aider)

## Fork maintenance [DONE]

- [x] Add a `chat_request` log line naming the requested and the resolved model of each chat request
- [x] Consolidate tooling on Vite+ (Oxfmt, Oxlint + tsgolint, Vitest, tsdown, `vp` hooks) and run on Node instead of Bun
- [x] Adopt the Viaanix lint rules (copied into `vite.config.ts`) with zero warnings
- [x] Rename the package to `@vx-daniel/pi-openai-proxy` (GitHub Packages scope must match the repo owner)

## Rename to pi-switchboard [DONE]

- [x] Leave the fork network; rename the repo to `vx-daniel/pi-switchboard` (#65)
- [x] Rename the package, bin, log categories, env vars (`PI_SWITCHBOARD_*`) and the upstream key header (`X-Switchboard-Upstream-Api-Key`), with no aliases; old names warned about or rejected
- [x] Credit the original project (README "Attribution", LICENSE)
- [x] Restart versions at 0.1.0 (`pi-switchboard-v` tags); npm publishing waits for #59

The phases above are done and kept as history. The phases below are the plan since the rename
(constitution 3.0.0, "Scope"): stay OpenAI-compatible, grow toward more of OpenAI's API and toward
routing across pi's logins. `TODO.md` uses the same numbering.

## Phase 4 — Distribution

Get 0.1.0 into people's hands under the new name.

- [x] Publish the pi package so `pi install npm:@vx-daniel/pi-switchboard` works: GitHub Packages,
      which needs a token to install (#59)
- [ ] The same on npmjs, with no token (later, by choice)
- [x] Docker image built from this repo and published on release (#60): Docker Hub and GHCR, from
      0.1.0
- [ ] Standalone binary with an opt-in TUI for logs, status and accounts (#61)

## Phase 5 — Routing across pi's logins

What the name promises, under constitution principle VI (explicit, visible, exposure-bound).

- [x] Aliases: virtual model names (#66)
- [x] Fallback chains for aliases (#67)
- [x] Cooldowns after rate limits (#68); pi already makes no hidden SDK retries
- [ ] Quota awareness from provider rate-limit headers (#69): tracked and shown; routing on it to decide
- [ ] Usage and cost by route (#70): log tags and in-memory totals done; an HTTP view is undecided

## Phase 6 — More of OpenAI's API

Routes OpenAI defines that pi can back, each experimental first and then promoted to PLAN's
"Stable surface" once it meets principle I.

- [ ] Responses API, stateless (`POST /v1/responses`, #140)
- [x] `prompt_cache_key` → pi's `sessionId` (#39)

## Open decisions

- [ ] Proxy auth and upstream failure contract, 5 points (#128); point 5 done (#147)

## Later, not planned

- Experimental agentic mode: a separate opt-in endpoint (`/v1/switchboard/agent/…`), never under an
  OpenAI route. PLAN "Agentic mode" keeps the security requirements; `PI_SWITCHBOARD_AGENTIC` is
  read but does nothing yet.
- Splitting into packages (the March 2026 plan, `docs/archive/monorepo-plan.md`): dropped for now.
  One package serves the CLI, the library entry points and the pi extension.
