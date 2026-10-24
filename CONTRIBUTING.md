# Contributing

## Dev Workflow

The toolchain is [Vite+](https://viteplus.dev) (`vp`); all config lives in `vite.config.ts`.

```bash
vp install            # Install dependencies (pnpm); also installs the Git hooks
vp run dev            # Rebuild on change and restart the proxy on port 4142 (PI_SWITCHBOARD_DEV_PORT to change)
pnpm run check:all    # The gate: format, lint + type check, tests with coverage, fallow, build
vp check --fix        # Format and apply lint fixes
vp test               # Offline tests (unit + integration): no real login, no network beyond 127.0.0.1
pnpm run test:live    # Live conformance tests against real providers: uses your pi login and quota
pnpm run test:live:record [<api>/<scenario> ...]  # Re-record the Anthropic and Codex replay fixtures, or the ones named (needs a login made for recording)
pnpm run openai-spec:update <commit>  # Re-pin OpenAI's OpenAPI spec subset to a full commit SHA
vp pack               # Build for npm (ESM + .d.ts)
pnpm run build:binary # Standalone binary for this machine (dist-bin/pi-switchboard); needs Bun
pnpm run test:binary  # Build it, then run it against the fixtures (test/binary); needs Bun, not in the gate
```

`check:all` (`scripts/gate.ts`) is the one definition of "green": the pre-commit hook, CI, and the release workflow all run it.

Offline tests run with pi pointed at an empty agent directory and credential env vars removed (`test/setup/offline.ts`). Tests that need models or an upstream build them with `test/fixtures/agent-dir.ts` and the local mock provider in `test/fixtures/mock-provider.ts`, which serves scripted replies or replays real provider traffic recorded by `test:live:record` (`test/fixtures/recording.ts`, `test/fixtures/recordings/`). Recording forwards pi's real requests to the provider through a local recorder and saves the responses without credentials; it refuses to save one that contains a credential. Set `PI_SWITCHBOARD_RECORD_AGENT_DIR` to a pi agent directory with a login made for recording: never a copy of a login another pi or proxy uses, because refreshing an expired token rotates it under every copy. Recordings go to `test/fixtures/recordings/` unless `PI_SWITCHBOARD_RECORD_OUT_DIR` names another directory (a relative path is taken from the working directory).

`test/integration/openai-spec.test.ts` checks the stable surface against OpenAI's published OpenAPI spec, pinned to one commit of [`openai/openai-openapi`](https://github.com/openai/openai-openapi) in `test/fixtures/openai-spec/openapi-subset.json`. Every response body, stream chunk and error body has to validate against OpenAI's schema for it. Every request field and enum value the proxy accepts has to exist in OpenAI's request, and every one OpenAI has that the proxy doesn't accept is listed in the test with the reason. To move the pin, run `openai-spec:update` with the new commit. If OpenAI added a field or value, the test fails until you accept it or list it.

### Tooling

- **Vite+** — one toolchain: Oxfmt (format), Oxlint with tsgolint (type-aware lint and type check), Vitest (tests, with v8 coverage in the gate), tsdown (`vp pack`), and Git hooks (`.vite-hooks/`)
- **fallow** — dead code, duplication and complexity from the module graph (`.fallowrc.jsonc`); the gate fails on any finding
- **pnpm** — package manager, driven by `vp`
- **Node.js** — runtime (`@hono/node-server`)
- **commitlint** — conventional commits (`commit-msg` hook)
- **GitHub Actions** — `ci.yml` (the gate on pull requests into `dev`/`main` and pushes to `dev`, plus the `binary` job, which builds and tests the standalone binary with Bun), `secret-scan.yml` (gitleaks on every pushed commit), `claude-pr-review.yml` (manual Claude review), `publish.yml` (release on `main`, then the image, package and binaries)
- **Bun** — build-only: compiles the standalone binary (`scripts/build-binary.ts`, `src/standalone/main.ts`); nothing else runs on it
- **semantic-release** — automated versioning, GitHub releases and the changelog; the release workflow then publishes the image, the pi package on GitHub Packages and the binaries (npmjs is [#59](https://github.com/vx-daniel/pi-switchboard/issues/59))
