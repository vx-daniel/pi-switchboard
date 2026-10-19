<!--
Sync Impact Report
Version change: 1.1.2 → 1.2.0 (MINOR)
Rationale: two kinds of request field were dropped rather than rejected, against principle I as
written: Codex `temperature` (#49, #80) and passthrough fields a provider has no equivalent for
(#81). The maintainer decided to keep both behaviours as deliberate exceptions. Principle I now
lists them with their reasons and where they are documented, and makes any other silent drop a
violation that needs an amendment. No code changes.
Modified sections:
- I. Stable OpenAI Contract: an exception list (Codex `temperature`; passthrough fields without a
  provider equivalent)
- API Compatibility and Security Boundaries: "silent downgrades are not acceptable" now points to
  principle I's exceptions
Templates requiring updates:
- ✅ AGENTS.md: "Reject unsupported parameters clearly" names the constitution's exceptions
- ✅ PLAN.md: the Codex table and "Known gaps and silent drops" cite the exceptions instead of
  calling the drops a policy violation
- ✅ README.md: the passthrough section cites the exceptions
Follow-up TODOs:
- None. Resolved since 1.1.2: a non-string `authToken` now fails closed (#82, PR #98); #80 and #81
  by this amendment.

1.1.2 (2026-10-18): fallow joined the gate (#83); the directive ban names `fallow-ignore…` and
`@expected-unused`, and the gate lists its steps.

1.1.1 (2026-10-18): moved from the unversioned `.local/constitution.md` to the repository root; governance
says where it lives and that AGENTS.md links to it.

1.1.0 (2026-10-18): rewrote the constitution for the current repository (Node + Vite+, no Bun,
lefthook or spec-kit memory); defined operational and /v1/pi/ routes, the operator-config repair
rule, logging limits, the lint-directive ban, verbatim exposure, and commit types driving releases.
-->

# pi-openai-proxy Constitution

## Core Principles

### I. Stable OpenAI Contract
The stable HTTP surface is exactly `GET /v1/models`, `GET /v1/models/{model}`, and `POST /v1/chat/completions`. Responses on it MUST stay close to OpenAI's schema; pi-specific data on a stable response MUST be namespaced under `x_pi` and documented. Unsupported routes or parameters MUST fail with clear OpenAI-style errors rather than being silently ignored.

Exceptions: a request field MAY be dropped instead of rejected only where it is listed here, with its reason, and documented where operators read the contract. Any other silent drop is a violation, and a new one needs an amendment.
- Codex `temperature` (`openai-codex-responses`): the Codex backend refuses any request that carries it, and widely used clients send one on every request, so a `422` would make every Codex model unusable from them (#49, #80). Each drop is logged (the first per model at `info`, later ones at `debug`) and documented in `PLAN.md`'s Codex table and in `README.md`.
- Passthrough fields a provider has no equivalent for (#81): `stop`, `user`, `top_p`, `frequency_penalty`, `presence_penalty`, `seed`, `response_format`, `tool_choice`, `parallel_tool_calls`, `metadata` and `prediction` reach each API verbatim or translated where it has an equivalent, and are dropped where it has none. Clients commonly send one parameter set to every model, and rejecting per API would break them. The per-API tables in `PLAN.md` ("API-aware payload translation") list exactly what each API receives, and `README.md` says fields without an equivalent are skipped; a change to what an API receives updates those tables.

Two kinds of route sit outside the stable surface, and only these:
- Operational endpoints: `GET /healthz`, `/healthz/models`, `/healthz/creds`. Only `/healthz` may skip proxy authentication, and none may return a credential.
- Non-standard pi routes, which MUST live under `/v1/pi/` (today `GET /v1/pi/models`). Non-OpenAI capability data goes there, never onto the standard model objects.

Adding a route to either group, or to the stable surface, requires an explicit decision recorded in `PLAN.md`.

Rationale: the proxy exists to be a predictable compatibility layer. Hidden behavior or surprise API drift breaks downstream clients and makes the proxy harder to trust.

### II. Validate at Boundaries
All untrusted input MUST be validated at the edge before use, with Zod schemas parsed by `safeParse()`. Where a schema exists, the static type MUST be inferred from it rather than restated by hand.

- Client input (request bodies, headers, model identifiers, tool schemas) that is unsupported or invalid MUST be rejected with an actionable OpenAI-style client error.
- Operator configuration MUST be validated field by field, and it MUST never keep a background proxy from starting by accident:
  - an invalid CLI flag refuses to start and lists the valid values;
  - an invalid environment variable is ignored with a warning;
  - an invalid field in the config file is repaired (a number clamped to its schema's bounds, a list or map keeping its valid entries, anything else its default), and every repaired field is named in a warning, by path only.

Type safety is part of the contract: no `any`, no `@ts-ignore`, no unsafe `as` casts, and no inline directives (`oxlint-disable…`, `eslint-disable…`, fallow's `fallow-ignore…` and its `@expected-unused` tag), which `test/unit/lint-directives.test.ts` enforces. Narrow with repository type guards or schemas. When a lint rule's premise does not fit a line, express the code differently and say why in an ordinary comment; a deliberate fallow exception goes in `.fallowrc.jsonc` with its reason.

Rationale: the proxy translates between multiple schemas and provider APIs, so boundary validation is the primary defense against accidental incompatibility and latent runtime bugs. Operator configuration is trusted but typo-prone; repairing it loudly keeps the service up without hiding the mistake.

### III. Local-First Safety
The default runtime posture MUST remain local and conservative. The server MUST bind to localhost by default, and upstream work MUST be canceled when the client disconnects. Any feature that increases exposure or expands attack surface, including remote image fetching or experimental agentic behavior, MUST remain off by default and require explicit opt-in.

Secrets MUST never be echoed in errors or logs. Logs MUST NOT contain message content, tool arguments, image data, or credentials; credential-named properties are redacted as a backstop, not as the primary control. Warnings about configuration name fields, never values.

Tests MUST never read the developer's pi login or provider credentials. Offline tests run against fixture agent dirs and the local mock provider. Nothing is tested or recorded against a copy of a live login, because refreshing an expired OAuth credential rotates the refresh token under every other copy.

Rationale: the project is designed for personal or workstation-local use. Safety defaults reduce the chance that a convenience feature becomes a security problem.

### IV. Model and Header Discipline
Canonical model identifiers MUST remain `provider/model-id` internally. Public model IDs, exposure rules, and provider prefix labels MUST be explicit, configurable, and validated. Exposure MUST follow the configuration exactly as written: model IDs and prefix labels are never normalized, so a mistyped entry matches no model rather than exposing one. Hidden models MUST NOT become reachable through fallback resolution.

The proxy MUST reserve `Authorization` for proxy authentication compatibility, and upstream credential overrides MUST use proxy-specific headers.

Rationale: model identity and auth headers are the two places where ambiguity can leak across trust boundaries. Keeping those rules explicit prevents accidental exposure and preserves client interoperability.

### V. Release Hygiene and Traceability
Behavior changes MUST be reflected in the same change in the durable project docs that their guidance touches: `README.md` (operator-facing behavior), `PLAN.md` (architecture, compatibility policy, security boundaries), `TODO.md`, `ROADMAP.md`, and `AGENTS.md` (the always-loaded agent rules; `CLAUDE.md` is a symlink to it).

Commits SHOULD stay small and reviewable and MUST follow Conventional Commits. The commit type MUST match the change, because semantic-release derives versions from it: a behavior change is `fix` or `feat` (or carries `BREAKING CHANGE`), never `refactor` or `chore`. Releases follow semantic versioning, happen only when `dev` is merged into `main`, and that merge is the maintainer's decision.

Rationale: the proxy's public contract is documentation-heavy. If behavior changes without synchronized docs and verification, downstream users and agents will diverge from the real system.

## API Compatibility and Security Boundaries

- Stable support is limited to the documented chat-completions and models routes; operational and `/v1/pi/` routes are governed by principle I.
- Unsupported fields and endpoints MUST fail explicitly; silent downgrades are not acceptable, except the drops principle I lists.
- Model exposure policy MUST be derived from configured credentials and the active exposure mode, not from ad hoc request-time guessing.
- Experimental capabilities MUST be separated from the stable contract and require explicit opt-in before they can affect user traffic.
- Security-sensitive defaults, including localhost binding and disabled remote image fetching, MUST remain conservative unless the constitution is amended.

## Development Workflow and Quality Gates

- Stack: Node (≥ 24) runtime; the Vite+ toolchain (`vp`: Oxfmt, Oxlint with tsgolint, Vitest, tsdown); fallow for dead code, duplication and complexity; pnpm for packages and scripts; TypeScript, Hono, Zod v4, and TypeBox. TypeBox is used only where pi's API requires it, imported through `@earendil-works/pi-ai`'s re-export so the proxy never ships a second copy.
- Imports: the `@proxy/*` alias for `src/*` (no relative imports across the source tree), `node:` protocol for Node built-ins, `import * as z from "zod"`, and `vite-plus/test` in tests.
- `pnpm run check:all` (`scripts/gate.ts`: format, lint with the type check, offline tests with coverage, fallow, build) is the single definition of green. The pre-commit hook, CI, and the release workflow all run it; a new check is added there, not in a hook or a workflow.
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

**Version**: 1.2.0 | **Ratified**: 2026-03-31 | **Last Amended**: 2026-10-19
