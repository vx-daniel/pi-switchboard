# pi-switchboard

This repo is **pi-switchboard**, a **local HTTP API over pi's models, logins and providers that speaks OpenAI's API** (formerly `pi-openai-proxy`; see the README's Attribution). It is growing toward more of OpenAI's API (the Responses API, #140) and toward routing across pi's logins (#66–#70); the constitution's "Scope" says what is in and out.

`AGENTS.md` is always-on Pi context. Keep this file short, precise, and operational. The project's principles live in [`CONSTITUTION.md`](CONSTITUTION.md), which supersedes conflicting guidance here or in any other doc. Put deep architecture detail in [`PLAN.md`](PLAN.md), human onboarding in [`README.md`](README.md), the execution checklist in [`TODO.md`](TODO.md), and phase summary in [`ROADMAP.md`](ROADMAP.md).

User instructions override this file.

## Start here

Before changing code:

1. Read [`CONSTITUTION.md`](CONSTITUTION.md) for the principles every change is checked against.
2. Read [`PLAN.md`](PLAN.md) for architecture, API compatibility policy, and security boundaries.
3. Skim [`README.md`](README.md) for public contract and operator-facing behavior.
4. Check `package.json`, `vite.config.ts` (fmt, lint, test, pack, staged), `lint/repo-rules.ts`, `.vite-hooks/`, and `tsconfig.json` before changing tooling.
5. Use recent git history when behavior or workflow intent is unclear: `git log --oneline -20`.

## Repo shape

- `src/server/` — Hono HTTP app, middleware, routes, request/response handling
- `src/openai/` — OpenAI request schemas, message conversion, tool conversion, SSE/response shaping
- `src/pi/` — pi SDK integration and model registry resolution
- `src/config/` — env/config parsing and validation
- `src/sync/` — external/editor sync integrations
- `extensions/` — Pi extension surface for the package
- `test/unit/`, `test/integration/`, `test/conformance/` — behavior checks
- `docs/` — supporting analysis and client research, not the main source of truth; `docs/reference/` compares the proxy with other implementations; `docs/archive/` holds the March 2026 plans that were not carried out

## Core constraints

Treat these as stable unless the user explicitly changes direction:

- The stable HTTP surface is the list in [`PLAN.md`](PLAN.md) "Stable surface" (today `GET /v1/models`, `GET /v1/models/{model}`, `POST /v1/chat/completions`). A route joins it only by the criteria in constitution principle I, recorded in that table; never add one silently.
- Operational endpoints (`GET /healthz`, `/healthz/models`, `/healthz/creds`, and the opt-in docs page `GET /docs`) sit outside that surface; see [`PLAN.md`](PLAN.md). None may return a credential.
- Non-OpenAI capability data goes on `GET /v1/switchboard/models`, never on the standard model objects; non-standard routes live under `/v1/switchboard/`. See [`PLAN.md`](PLAN.md).
- Only three paths skip proxy auth: `/healthz`, `GET /v1/switchboard/openapi.json` and the opt-in docs page `GET /docs`. The document and docs page name no model, provider or credential. The document describes every route the proxy serves (a test compares it with the route table); `openapi.json` at the repo root is the committed copy, and `vp test -u` rewrites it after a deliberate contract change.
- Canonical internal model IDs use `provider/model-id`.
- `GET /v1/models/{model}` must support URL-encoded IDs because model IDs may contain `/`.
- Reserve `Authorization` for proxy auth compatibility. Do **not** repurpose it for upstream provider override headers.
- Keep stable responses close to OpenAI's schema. If pi-specific metadata is exposed, namespace it under `x_pi`.
- Reject unsupported parameters clearly, top level and inside messages and parts (their schemas are strict). Do **not** silently ignore them. The only permitted drops are the ones `CONSTITUTION.md` principle I lists (`temperature` on Codex and where pi leaves it out for Claude; passthrough fields a provider has no equivalent for; `prompt_cache_breakpoint` where the API has no slot for it or the model refuses it; `name` on messages and `image_url.detail`); any other needs an amendment.
- Routing (aliases, fallback, cooldowns, quota; #66–#70) follows constitution principle VI: configured explicitly, never reaching a model the exposure config hides, and the serving model and login reported under `x_pi` and in the log.
- Agentic mode is a "Later, not planned" idea. Do not build it under an OpenAI route.
- Default network posture should remain local-first and safe by default.

For detailed rationale and edge cases, defer to [`PLAN.md`](PLAN.md) instead of duplicating them here.

## Coding rules that matter in this repo

- Runtime/tooling: **Node runtime + Vite+ toolchain (`vp`: Oxfmt, Oxlint/tsgolint, Vitest, tsdown) + pnpm + TypeScript + Hono + Zod v4 + TypeBox**.
- Tests import from `vite-plus/test`, not `vitest` or `bun:test`.
- Use import alias `@proxy/*` for `src/*`. Do **not** introduce relative imports across the source tree.
- Use `import type` where required.
- Use `node:` protocol for Node built-ins.
- Use `import * as z from "zod"`; do not use named Zod imports.
- Validate untrusted input with Zod at boundaries.
- Request text whose whitespace is data (message content, text parts, tool results, `stop`, `prediction` content) uses `textSchema` from `@proxy/openai/text-schemas`; every other string is `z.string().trim()`. Never trim text the model reads (#145).
- Prefer `safeParse()` over assertion-based parsing.
- No `any`, no `@ts-ignore`, no unsafe `as Type` casts.
- Use repo type guards such as `isRecord()` instead of ad-hoc unsafe narrowing.
- Respect strict TS settings, especially `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and `noPropertyAccessFromIndexSignature`.
- `process.env` is typed via `src/env.d.ts`; prefer dot notation.
- Log with LogTape, never `console`: `proxyLogger(...)` from `@proxy/logging` (extension: `@vx-daniel/pi-switchboard/logging`), using a category and level from the header of `src/logging/index.ts`. Message templates take `{placeholders}`, not template literals. Never log message content, tool arguments, image data, or credentials.
- Doc comments are TSDoc (#101):
  - Every function needs a summary, `@param name - …` per parameter, `@typeParam` per type parameter, and `@returns` unless it returns nothing. Types, interfaces, classes and top-level constants need a summary. A file comment ends with `@packageDocumentation`.
  - No `{type}` in tags; TSDoc tags only (no `@return`, no `@yields`; a generator documents its values in `@returns`).
  - In `*.test.ts`, only helper functions are in scope, and tests keep their `// Catches …` comments.
  - `test/unit/tsdoc.test.ts` and oxlint's jsdoc rules enforce this; the test's header defines the exact scope.

## Verification workflow

When you change code, run the smallest relevant checks first, then expand as needed.

Lint rules are the Viaanix shared set, copied into `vite.config.ts`. Lint passes only with zero warnings. Fix the code, not the rule: inline directives (`oxlint-disable…`, `eslint-disable…`, `…-enable`, fallow's `fallow-ignore…` and its `@expected-unused` tag) are not allowed anywhere, and `test/unit/lint-directives.test.ts` fails the gate on any. If a rule's premise does not fit a line, express the code differently (a named constant, a different API) and say why in an ordinary comment.

fallow (`.fallowrc.jsonc`) checks dead code, duplication and complexity, with CRAP scored against the test gate's coverage; any finding fails the gate. A deliberate exception (an entry point fallow cannot see, a complexity ceiling) goes in `.fallowrc.jsonc` with its reason. Before deleting something fallow calls unused, trace it: `pnpm exec fallow dead-code --trace <file>:<export>`.

Common commands:

```bash
pnpm run check:all  # the gate: format → lint + type check → tests with coverage → fallow → build (scripts/gate.ts)
vp check --fix      # apply formatting and lint fixes
vp test             # offline tests: unit + integration, no real login (test:ci runs them with coverage, for fallow)
pnpm run test:live  # live provider conformance tests: real login, spends quota; on demand only
pnpm run test:live:record  # re-record replay fixtures (PI_SWITCHBOARD_RECORD_AGENT_DIR = a login made for recording)
pnpm run openai-spec:update <sha>  # re-pin OpenAI's OpenAPI spec subset (test/integration/openai-spec.test.ts)
vp pack             # build
```

`scripts/gate.ts` is the single definition of "green": the pre-commit hook, CI (`.github/workflows/ci.yml`) and the release workflow all run `check:all`. Add a check there, not in a hook or a workflow.

Offline tests never read the developer's pi login or provider credentials: `test/setup/offline.ts` points pi at an empty agent dir and removes credential env vars. A test that needs models or an upstream uses `loadFixtureAgentDir` (`test/fixtures/agent-dir.ts`) and `startMockProvider` (`test/fixtures/mock-provider.ts`), with scripted replies or `replay(loadRecording(...))` of recorded real traffic (`test/fixtures/recording.ts`). Never test or record against a copy of a live login: resolving an expired OAuth credential refreshes it and rotates the refresh token under every other copy.

Expected discipline in this repo:

- Before committing, run **`pnpm run check:all`** (the pre-commit hook runs it too).
- If only docs changed, skip code checks unless the change affects documented commands or behavior.
- In your summary, state exactly what you ran and what you did **not** run.

Hook-backed workflow already exists (`.vite-hooks/`, installed by `vp config` on `prepare`) and should be preserved:

- `commit-msg` -> commitlint
- `pre-commit` -> `pnpm run check:all` over the working tree
- `pre-push` -> lockfile sync check

CI (`.github/workflows/`): `ci.yml` (`gate`, pull requests into `dev`/`main` and pushes to `dev`), `secret-scan.yml` (gitleaks over every pushed commit), `claude-pr-review.yml` (manual Claude review; needs the `CLAUDE_CODE_OAUTH_TOKEN` secret), `publish.yml` (release on `main`, then `image.yml` and `package.yml` for the new tag).

Do not weaken these hooks or workflows unless the user asks.

## Git workflow

Repository preference:

- Make **frequent small commits** for logical slices.
- Use **Conventional Commits**.
- Normal collaboration model is **feature branches + PRs into `dev`**. Pushing feature branches is safe once the task is complete and verified.
- **Never push or merge to `main` directly.** Every push to `main` runs the release workflow (semantic-release). Releases happen only when `dev` is merged into `main`, and that merge is the user's decision.

Practical guidance:

- Keep commits reviewable and scoped.
- Prefer one logical concern per commit.
- If the work changes behavior materially, update docs in the same slice.
- Do not rewrite history unless the user asks.

## Docs synchronization

Keep durable docs aligned with implementation:

- A pull request that touches stable routes, auth semantics, model resolution, validation rules, or security defaults names the [`CONSTITUTION.md`](CONSTITUTION.md) principles it affects.
- Update [`PLAN.md`](PLAN.md) when architecture, constraints, compatibility policy, or security boundaries change.
- Update [`TODO.md`](TODO.md) when execution status or next tasks change.
- Update [`ROADMAP.md`](ROADMAP.md) when the current phase summary changes.
- Update [`README.md`](README.md) when user-facing behavior, installation, configuration, or public API examples change.
- Prefer linking to those docs from here instead of copying large sections into `AGENTS.md`.

## When to stop and ask

Stop and confirm with the user before:

- adding a route to, or removing one from, PLAN's "Stable surface"
- changing auth semantics or header contracts
- altering model ID resolution behavior or exposure policy
- loosening validation/security behavior
- weakening hooks, lint/type-safety rules, or release workflow
- making a broad refactor across server/openai/pi translation layers without clear acceptance criteria
- amending [`CONSTITUTION.md`](CONSTITUTION.md) (an amendment bumps its version and updates this file in the same change)

## Scope of this file

A single repo-root `AGENTS.md` is enough for the current tree. Add nested `AGENTS.md` files only if a subtree develops a genuinely different workflow or safety boundary.

`CLAUDE.md` is a symlink to this file, so Claude Code (and the Claude PR review) load the same rules. Edit `AGENTS.md`; never replace the symlink with a copy.
