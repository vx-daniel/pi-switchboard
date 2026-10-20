# Archive

Plans and research from March 2026, before the fork was renamed pi-switchboard. None of them were
carried out as written; each file's status note says what came of it. They are kept for their
reasoning, not as plans. The current plan is `ROADMAP.md`, and the architecture is `PLAN.md`.

| File | What it was | What happened |
|---|---|---|
| `monorepo-plan.md` | Splitting the project into `@pi-proxy/*` packages in a separate monorepo | Not done; dropped for now (ROADMAP "Later, not planned") |
| `zed-model-sync.md` | A pluggable sync engine pushing exposed models into editor configs | Only the Zed sync shipped, in `src/sync/zed.ts`; the rest was not built |
| `zed-pi-ide-integration.md` | Research into IDE context integration between Zed and pi | Not built |

Still current, in `docs/`: `engineering/phase-3d-analysis.md` (the analysis behind Phase 3D's
decisions) and `discovery/openai-compatible-clients.md` (client research).
