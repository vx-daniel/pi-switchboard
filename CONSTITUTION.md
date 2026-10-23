<!--
Sync Impact Report
Version change: 3.5.1 → 3.6.0 (MINOR)
Rationale: #227 gave a provider several logins (`anthropic-2`). Under principle IV as
written, a second login had to be an exposed model of its own to be routable, so every model of
the provider was listed twice and collision-prefixed (`anthropic/claude-opus-5-5`,
`anthropic-2/claude-opus-5-5`), which broke clients that filter on plain names (j5).
The amendment makes a login a routing detail of one exposed model, as principle VI's "which
model and login served it" already anticipated: the model is listed once under the base's name,
routing picks the login, and the response and log say which.
MINOR: principles IV and VI materially expanded; no principle added or removed.
Modified sections:
- IV. Model and Header Discipline: a provider's extra login is not a model; its models are the
  base provider's, exposed once; the login is a routing detail
- VI. Routing Transparency: every login of an exposed model's provider may serve it; `x_pi.login`
  names the serving login; a request that names a model never moves to another model but may move
  to another login on the classes `routing.logins.fallbackOn` names, or past a login below its
  `routing.reserve`; that setting's default, `["rate_limit"]`, is the one recorded default
  routing has
Templates requiring updates:
- ✅ AGENTS.md: "Core constraints" names login routing and the recorded default
- ✅ PLAN.md, README.md: the Accounts section and the config table describe it
Follow-up TODOs:
- None.

3.5.1 (2026-10-22): principle I's list of today's non-standard routes names
`GET /v1/switchboard/usage` (#224, #225).

3.5.0 (2026-10-21): #61's console and standalone binary. The Scope says what the proxy may do with
logins: pi runs every flow and stores every credential, and the proxy may present pi's own login
screens in a local terminal only (principle III: never over HTTP or another network surface). Bun
builds the standalone binary only; its tests are the one check outside the gate.

3.4.0 (2026-10-21): principle I's `prompt_cache_breakpoint` exception covers models on
`api.openai.com` that refuse it; the first refusal per model is retried once without it (#163).

3.3.0 (2026-10-20): fields inside messages are strict; `name` on messages and `image_url.detail`
are listed drops, a null `refusal` or `audio` is accepted (#146).

3.2.0 (2026-10-20): `temperature` where pi leaves it out for Claude, listed and logged (#147).

3.1.0 (2026-10-20): `prompt_cache_breakpoint` on content parts, forwarded to OpenAI's own APIs and
dropped, logged, everywhere else (#149).

3.0.0 (2026-10-20): a Scope section; principle I ("OpenAI Compatibility") states what a stable
route must meet, and the route list moves to `PLAN.md`; a new principle VI, Routing Transparency.

2.3.0 (2026-10-20): the env vars become `PI_SWITCHBOARD_*` and the upstream key header
`X-Switchboard-Upstream-Api-Key` (#65); the old `PI_PROXY_AUTH_TOKEN` refuses to start.

2.2.0 (2026-10-19): the docs page moves to `GET /docs` and joins the operational endpoints; the
OpenAPI document describes every route.

2.1.0 (2026-10-19): the OpenAPI document (`GET /v1/switchboard/openapi.json`) and an opt-in
Swagger UI page join the non-standard routes, and both may skip proxy authentication (#129).

2.0.0 (2026-10-19): non-standard routes live under `/v1/switchboard/`, which replaces `/v1/pi/`;
`GET /v1/pi/models` moved to `GET /v1/switchboard/models` with no alias.

1.3.0 (2026-10-19): proxy auth that is set but cannot be applied refuses to start, from any source
(#82, #99); principle II names it as the one exception to its operator-config rules.

1.2.0 (2026-10-19): principle I lists its two exceptions, Codex `temperature` (#49, #80) and
passthrough fields a provider has no equivalent for (#81); any other silent drop needs an amendment.

1.1.2 (2026-10-18): fallow joined the gate (#83); the directive ban names `fallow-ignore…` and
`@expected-unused`, and the gate lists its steps.

1.1.1 (2026-10-18): moved from the unversioned `.local/constitution.md` to the repository root; governance
says where it lives and that AGENTS.md links to it.

1.1.0 (2026-10-18): rewrote the constitution for the current repository (Node + Vite+, no Bun,
lefthook or spec-kit memory); defined operational and /v1/pi/ routes, the operator-config repair
rule, logging limits, the lint-directive ban, verbatim exposure, and commit types driving releases.
-->

# pi-switchboard Constitution

## Scope

pi-switchboard is a local HTTP API over pi's models, logins and providers that speaks OpenAI's API to its clients. It grows in two directions: more of OpenAI's API where pi can back it (chat completions today, the Responses API next), and routing requests across pi's logins (aliases, fallback, cooldowns, quota awareness). It does not implement logins or store credentials of its own: pi runs every login flow and stores every credential. The proxy may present pi's own login flow, pi's screens driving pi's login, in a local terminal (the opt-in console, #61), never over HTTP or any other network surface. It does not keep conversation state, and does not speak other vendors' client protocols. It started as a fork of `pi-openai-proxy` and is maintained independently.

## Core Principles

### I. OpenAI Compatibility
The stable HTTP surface is the set of routes `PLAN.md` lists under "Stable surface". A route joins it only by a decision recorded there, and only when:
- it is a route OpenAI's published API defines, with OpenAI's method, path and semantics;
- its requests and responses are checked against OpenAI's pinned spec (`test/integration/openai-spec.test.ts`), and every OpenAI field it does not accept is listed there with its reason;
- it is described in the OpenAPI document (`openapi.json`);
- README and PLAN document what it accepts and answers.

A route can start as experimental, opt-in and outside the stable surface, and be promoted once it meets these. Responses on the stable surface MUST stay close to OpenAI's schema; pi-specific data on a stable response MUST be namespaced under `x_pi` and documented. Unsupported routes or parameters MUST fail with clear OpenAI-style errors rather than being silently ignored.

Exceptions: a request field MAY be dropped instead of rejected only where it is listed here, with its reason, and documented where operators read the contract. Any other silent drop is a violation, and a new one needs an amendment.
- `temperature` where it cannot reach the provider, both logged (the first per model at `info`, later ones at `debug`):
  - Codex (`openai-codex-responses`): the Codex backend refuses any request that carries it, and widely used clients send one on every request, so a `422` would make every Codex model unusable from them (#49, #80). The proxy drops it. Documented in `PLAN.md`'s Codex table and in `README.md`.
  - Claude (`anthropic-messages`): pi's adapter leaves it out on models whose pi catalog entry clears `supportsTemperature` or sets `supportsMidConvoEffort` (Claude 4.7 and later, which refuse a temperature below 1), and whenever thinking is on (#147). The proxy still passes it to pi and logs that it does not reach Claude. Documented in `PLAN.md`'s Anthropic table and in `README.md`.
- Passthrough fields a provider has no equivalent for (#81): `stop`, `user`, `top_p`, `frequency_penalty`, `presence_penalty`, `seed`, `response_format`, `tool_choice`, `parallel_tool_calls`, `metadata` and `prediction` reach each API verbatim or translated where it has an equivalent, and are dropped where it has none. Clients commonly send one parameter set to every model, and rejecting per API would break them. The per-API tables in `PLAN.md` ("API-aware payload translation") list exactly what each API receives, and `README.md` says fields without an equivalent are skipped; a change to what an API receives updates those tables.
- `prompt_cache_breakpoint` on content parts (#149): forwarded to OpenAI's own chat completions and Responses (`api.openai.com`), which use it, and dropped for every other API. pi rebuilds each provider's request: Codex's system prompt is a plain `instructions` string with no part to carry it, and an OpenAI-compatible server may refuse a field it does not know. It only affects caching, never the answer, and docker-agent sends it on every `gpt-*` request, so a `422` would break it. A model there that refuses it with a 400 naming the field (the ChatGPT-subscription models, #163) gets the request once more without it, and is remembered for the life of the process; the first refusal per model is logged at `info`. Each other drop is logged at `debug`, and `PLAN.md` ("Prompt cache breakpoints") and `README.md` document where it goes.
- `name` on a message and `detail` on an `image_url` (#146): OpenAI fields pi has no equivalent for, a participant name and an image detail level. Clients send them routinely, so a `422` would break them. They are accepted and dropped, each drop logged at `debug` by count, and `README.md` and `PLAN.md` ("Unknown field policy") say so. Every other field inside a message is accepted only as declared, and any other key is refused with a named `422`.

Two kinds of route sit outside the stable surface, and only these:
- Operational endpoints: `GET /healthz`, `/healthz/models`, `/healthz/creds`, and the opt-in docs page `GET /docs` (Swagger UI for the OpenAPI document). Only `/healthz` and `/docs` may skip proxy authentication; none may return a credential, and `/docs` MUST name no model or provider.
- Non-standard routes, which MUST live under `/v1/switchboard/` (today `GET /v1/switchboard/models`, usage from the stats file at `GET /v1/switchboard/usage`, and the API's OpenAPI document at `GET /v1/switchboard/openapi.json`). Non-OpenAI capability data goes there, never onto the standard model objects. Of these, only the document may skip proxy authentication, and it MUST name no model, provider or credential.

Adding a route to either group, or to the stable surface, requires an explicit decision recorded in `PLAN.md`.

Rationale: the proxy exists to be a predictable compatibility layer. Hidden behavior or surprise API drift breaks downstream clients and makes the proxy harder to trust.

### II. Validate at Boundaries
All untrusted input MUST be validated at the edge before use, with Zod schemas parsed by `safeParse()`. Where a schema exists, the static type MUST be inferred from it rather than restated by hand.

- Client input (request bodies, headers, model identifiers, tool schemas) that is unsupported or invalid MUST be rejected with an actionable OpenAI-style client error.
- Operator configuration MUST be validated field by field, and it MUST never keep a background proxy from starting by accident:
  - an invalid CLI flag refuses to start and lists the valid values;
  - an invalid environment variable is ignored with a warning;
  - an invalid field in the config file is repaired (a number clamped to its schema's bounds, a list or map keeping its valid entries, anything else its default), and every repaired field is named in a warning, by path only.

  Exception: proxy auth that is set but cannot be applied refuses to start, whatever its source: an empty `--auth-token` or `PI_SWITCHBOARD_AUTH_TOKEN`, an `authToken` in the config file that is not a string, or the pre-rename `PI_PROXY_AUTH_TOKEN` still set with neither the flag nor `PI_SWITCHBOARD_AUTH_TOKEN` (#65). Ignoring or repairing it would turn a token the operator asked for into an open proxy (principle III), and starting to refuse every request hides the mistake behind a running process. The proxy logs why at `fatal`, and the pi extension refuses to spawn such a proxy and says why, since the proxy's own output is discarded. Every other pre-rename `PI_PROXY_*` variable is ignored with a warning naming its replacement.

Type safety is part of the contract: no `any`, no `@ts-ignore`, no unsafe `as` casts, and no inline directives (`oxlint-disable…`, `eslint-disable…`, fallow's `fallow-ignore…` and its `@expected-unused` tag), which `test/unit/lint-directives.test.ts` enforces. Narrow with repository type guards or schemas. When a lint rule's premise does not fit a line, express the code differently and say why in an ordinary comment; a deliberate fallow exception goes in `.fallowrc.jsonc` with its reason.

Rationale: the proxy translates between multiple schemas and provider APIs, so boundary validation is the primary defense against accidental incompatibility and latent runtime bugs. Operator configuration is trusted but typo-prone; repairing it loudly keeps the service up without hiding the mistake.

### III. Local-First Safety
The default runtime posture MUST remain local and conservative. The server MUST bind to localhost by default, and upstream work MUST be canceled when the client disconnects. Any feature that increases exposure or expands attack surface, including remote image fetching or experimental agentic behavior, MUST remain off by default and require explicit opt-in. A login, or any action that adds, replaces or removes a credential, MUST NOT be reachable over HTTP or any other network surface; it is offered only in a local terminal the operator runs.

Secrets MUST never be echoed in errors or logs. Logs MUST NOT contain message content, tool arguments, image data, or credentials; credential-named properties are redacted as a backstop, not as the primary control. Warnings about configuration name fields, never values.

Tests MUST never read the developer's pi login or provider credentials. Offline tests run against fixture agent dirs and the local mock provider. Nothing is tested or recorded against a copy of a live login, because refreshing an expired OAuth credential rotates the refresh token under every other copy.

Rationale: the project is designed for personal or workstation-local use. Safety defaults reduce the chance that a convenience feature becomes a security problem.

### IV. Model and Header Discipline
Canonical model identifiers MUST remain `provider/model-id` internally. Public model IDs, exposure rules, and provider prefix labels MUST be explicit, configurable, and validated. Exposure MUST follow the configuration exactly as written: model IDs and prefix labels are never normalized, so a mistyped entry matches no model rather than exposing one. Hidden models MUST NOT become reachable through fallback resolution. A provider's extra login (`{provider}-N`, #227) is not a model: its models are the base provider's, exposed once under the base's name, and the login is a routing detail reported under principle VI.

The proxy MUST reserve `Authorization` for proxy authentication compatibility, and upstream credential overrides MUST use proxy-specific headers.

Rationale: model identity and auth headers are the two places where ambiguity can leak across trust boundaries. Keeping those rules explicit prevents accidental exposure and preserves client interoperability.

### V. Release Hygiene and Traceability
Behavior changes MUST be reflected in the same change in the durable project docs that their guidance touches: `README.md` (operator-facing behavior), `PLAN.md` (architecture, compatibility policy, security boundaries), `TODO.md`, `ROADMAP.md`, and `AGENTS.md` (the always-loaded agent rules; `CLAUDE.md` is a symlink to it).

Commits SHOULD stay small and reviewable and MUST follow Conventional Commits. The commit type MUST match the change, because semantic-release derives versions from it: a behavior change is `fix` or `feat` (or carries `BREAKING CHANGE`), never `refactor` or `chore`. Releases follow semantic versioning, happen only when `dev` is merged into `main`, and that merge is the maintainer's decision.

Rationale: the proxy's public contract is documentation-heavy. If behavior changes without synchronized docs and verification, downstream users and agents will diverge from the real system.

### VI. Routing Transparency
Routing (aliases, fallback chains, cooldowns, quota awareness, a provider's logins; #66–#70, #227) MUST be configured explicitly and MUST be visible to the client and the operator:
- A request is only ever routed to models the exposure config exposes; an alias or fallback never reaches a hidden model (principle IV). Every login of an exposed model's provider may serve it.
- A response says which model and login served it, under `x_pi` (`model`, and `x_pi.login` when the model has more than one login), and the log records every hop (the requested model, each model and login tried, and why it moved on), by name, never credential.
- A request with no routing configured behaves exactly as without routing: the model it names, or an error. The one recorded default is `routing.logins.fallbackOn: ["rate_limit"]`: a second login to a provider serves a rate-limited model's request without further configuration, which is why a second login exists.
- Fallback only follows failures the configuration names (for example a rate limit or an outage), never a client error such as an invalid request. A request that names a model never moves to another model; it moves to another login of the same provider only on the classes `routing.logins.fallbackOn` names, or past a login below the share its `routing.reserve` entry keeps free.

Rationale: routing changes which model and account a client is billed on. Doing that silently would break the predictability principle I protects and the trust the operator places in the exposure config.

## API Compatibility and Security Boundaries

- Stable support is limited to the routes `PLAN.md` lists under "Stable surface" (principle I); operational and `/v1/switchboard/` routes are governed by principle I too.
- Unsupported fields and endpoints MUST fail explicitly; silent downgrades are not acceptable, except the drops principle I lists.
- Model exposure policy MUST be derived from configured credentials and the active exposure mode, not from ad hoc request-time guessing.
- Experimental capabilities MUST be separated from the stable contract and require explicit opt-in before they can affect user traffic.
- Security-sensitive defaults, including localhost binding and disabled remote image fetching, MUST remain conservative unless the constitution is amended.

## Development Workflow and Quality Gates

- Stack: Node (≥ 24) runtime; the Vite+ toolchain (`vp`: Oxfmt, Oxlint with tsgolint, Vitest, tsdown); fallow for dead code, duplication and complexity; pnpm for packages and scripts; TypeScript, Hono, Zod v4, and TypeBox. TypeBox is used only where pi's API requires it, imported through `@earendil-works/pi-ai`'s re-export so the proxy never ships a second copy. Bun builds the standalone binary only (`bun build --compile`); the npm package and the Docker image run on Node.
- Imports: the `@proxy/*` alias for `src/*` (no relative imports across the source tree), `node:` protocol for Node built-ins, `import * as z from "zod"`, and `vite-plus/test` in tests.
- `pnpm run check:all` (`scripts/gate.ts`: format, lint with the type check, offline tests with coverage, fallow, build) is the single definition of green. The pre-commit hook, CI, and the release workflow all run it; a new check is added there, not in a hook or a workflow. The one exception is the standalone binary's tests, which need Bun: they run in their own CI job and in the release workflow, so the gate and the pre-commit hook never require Bun.
- Hooks in `.vite-hooks/` MUST be preserved: `commit-msg` (commitlint), `pre-commit` (the gate), `pre-push` (lockfile sync). Lint passes only with zero warnings. Do not weaken lint, type, or test gates unless the maintainer explicitly asks.
- Before completion, run the smallest verification that exercises the change, then the gate. Live provider tests (`pnpm run test:live`) spend quota and run on demand only.
- Update durable docs and notes in the same change when a change affects user-visible behavior, architecture, or operator workflow.

## Governance

This constitution supersedes conflicting guidance in other project docs and workflow templates. It lives at the repository root as `CONSTITUTION.md`, is versioned with the code, and is linked from `AGENTS.md`. An amendment lands in a pull request like any other change, and updates `AGENTS.md` in the same change wherever the two would otherwise disagree.

Amendments require:

1. a written rationale for the change,
2. a semantic version bump,
3. a synchronized update to dependent docs and memory files,
4. a compliance review against the updated principles before the change is considered complete.

Versioning policy:

- **MAJOR**: incompatible governance changes or removed principles
- **MINOR**: added principles or materially expanded guidance
- **PATCH**: clarifications, wording fixes, or non-semantic refinements

Compliance review expectations:

- Every pull request or review that touches proxy behavior MUST check the change against this constitution.
- Any change to stable routes, auth semantics, model resolution, validation rules, or security defaults MUST explicitly call out the affected principle(s).
- If implementation and docs disagree, the implementation MUST be corrected or the docs amended before release.

**Version**: 3.6.0 | **Ratified**: 2026-03-31 | **Last Amended**: 2026-10-23
