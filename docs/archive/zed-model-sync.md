# Client Model Sync — Design Notes

> Status: design notes from 2026-03-25 (`fb469c4`). The package split, the `SyncTarget`
> contracts, the Continue target and `x_pi` were not built. The sync shipped as one Zed target:
> `src/sync/zed.ts`, run by `extensions/proxy/zed-sync.ts` with the models the extension's own
> exposure computes, not over HTTP. The "Target: Zed" and "Extension commands" sections describe
> that code.

Design for a modular sync system that pushes pi-switchboard's exposed models
into editor/tool configuration files. Follows pi-maestro's monorepo patterns:
contracts for plugin boundaries, per-client adapters, thin extension wiring.

## Problem

Editors like Zed and Continue.dev require manual model enumeration in their
config files. They never call `GET /v1/models`. Users must hand-write every
model with context window sizes and capability flags. When the proxy's model
set changes (new provider authenticated, model exposure config adjusted), the
editor config goes stale.

## Architecture

```text
packages/
├── proxy/                  # Standalone proxy server, CLI, config schema
│   └── (exposes model metadata via x_pi on GET /v1/models)
│
├── sync/
│   ├── contracts/          # SyncTarget interface, ModelInfo, SyncResult
│   ├── engine/             # Fetch models from proxy, diff, orchestrate sync
│   ├── target-zed/         # Zed settings.json adapter
│   └── target-continue/    # Continue config.yaml adapter (future)
│
└── pi-extension/           # Pi extension: /proxy commands + sync wiring
```

### Package responsibilities

| Package | Scope | Depends on |
|---|---|---|
| `@proxy/sync-contracts` | `SyncTarget` interface, `ModelInfo` type, `SyncResult`, `SyncOptions` | nothing (pure types + Zod) |
| `@proxy/sync-engine` | Fetch models from proxy, map to `ModelInfo[]`, diff against current state, call `SyncTarget.apply()` | `sync-contracts` |
| `@proxy/target-zed` | Read/write Zed's JSONC settings, implement `SyncTarget` | `sync-contracts`, `jsonc-parser` |
| `@proxy/target-continue` | Read/write Continue's YAML config, implement `SyncTarget` | `sync-contracts` |
| `pi-extension` | Wire sync targets, register `/proxy zed-sync` etc. | `sync-engine`, all targets, proxy config |

### Comparison with pi-maestro

| pi-maestro | pi-switchboard sync |
|---|---|
| `core/contracts` (ProviderAdapter, SecretBackend) | `sync/contracts` (SyncTarget) |
| `core/engine` (AccountManager, selection) | `sync/engine` (fetch, diff, orchestrate) |
| `providers/anthropic`, `providers/gemini` | `sync/target-zed`, `sync/target-continue` |
| `secrets/secret-keychain`, `secret-age` | (n/a — no secret backends needed) |
| `pi-maestro` (extension wiring) | `pi-extension` (extension wiring) |

## Contracts

```typescript
// sync/contracts/src/model-info.ts

/** Provider-agnostic model metadata produced by the sync engine. */
interface ModelInfo {
  /** Public model ID (what the editor sends in API requests). */
  id: string;
  /** Human-readable display name. */
  displayName: string;
  /** Provider key (e.g. "anthropic", "openai"). */
  provider: string;
  /** Context window size in tokens. */
  contextWindow: number;
  /** Max output/completion tokens. */
  maxOutputTokens: number;
  /** Whether the model supports image inputs. */
  supportsImages: boolean;
  /** Whether the model supports tool/function calling. */
  supportsTools: boolean;
  /** Whether the model is a reasoning/thinking model. */
  reasoning: boolean;
}
```

```typescript
// sync/contracts/src/sync-target.ts

interface SyncTarget {
  /** Unique target identifier (e.g. "zed", "continue"). */
  readonly id: string;
  /** Human-readable name for UI/notifications. */
  readonly displayName: string;

  /** Detect whether this target is installed/configured on the system. */
  detect(): Promise<DetectResult>;

  /** Read the current model list from the target's config. */
  read(): Promise<ReadResult>;

  /** Write updated models to the target's config. */
  apply(models: readonly ModelInfo[], options: SyncOptions): Promise<SyncResult>;
}

interface DetectResult {
  readonly found: boolean;
  /** Resolved path to the config file, if found. */
  readonly configPath?: string | undefined;
}

interface SyncOptions {
  /** Provider name in the target's config (e.g. "Pi Proxy"). */
  readonly providerName: string;
  /** API URL to write into the target's config. */
  readonly apiUrl: string;
  /** Dry run — return what would change without writing. */
  readonly dryRun: boolean;
}

interface SyncResult {
  readonly ok: boolean;
  /** Number of models added/updated/removed. */
  readonly added: number;
  readonly updated: number;
  readonly removed: number;
  /** Human-readable summary. */
  readonly summary: string;
  /** Error message if !ok. */
  readonly error?: string | undefined;
}

interface ReadResult {
  readonly ok: boolean;
  readonly models: readonly ModelInfo[];
  readonly error?: string | undefined;
}
```

## Proxy model metadata

Proposed: add `x_pi` to `GET /v1/models` and `GET /v1/models/{model}` responses. Not built:
`/v1/models` keeps the plain OpenAI model object, and what pi knows beyond it goes on
`GET /v1/switchboard/models` (`src/openai/models.ts`). The proposal was:

```json
{
  "id": "anthropic/claude-sonnet-4-20250514",
  "object": "model",
  "created": 1742867000,
  "owned_by": "anthropic",
  "x_pi": {
    "display_name": "Claude Sonnet 4",
    "context_window": 200000,
    "max_output_tokens": 64000,
    "reasoning": true,
    "input_modalities": ["text", "image"]
  }
}
```

This was to be the only change in the proxy package. The sync engine would read it and map it to
`ModelInfo[]`.

### Field mapping: pi Model -> x_pi

| `x_pi` field | Source |
|---|---|
| `display_name` | `Model.name` |
| `context_window` | `Model.contextWindow` |
| `max_output_tokens` | `Model.maxTokens` |
| `reasoning` | `Model.reasoning` |
| `input_modalities` | `Model.input` (e.g. `["text", "image"]`) |

## Target: Zed

### Config format

```jsonc
// ~/.config/zed/settings.json (JSONC with comments; see "Settings file discovery")
{
  "language_models": {
    "openai_compatible": {
      "Pi Proxy": {
        "api_url": "http://127.0.0.1:4141/v1",  // http://<host>:<port>/v1 from proxy-config.json
        "available_models": [
          {
            "name": "anthropic/claude-sonnet-4-20250514",
            "display_name": "Claude Sonnet 4",
            "max_tokens": 200000,
            "max_output_tokens": 64000,
            "capabilities": {
              "tools": true,
              "images": true,
              "parallel_tool_calls": true,
              "prompt_cache_key": false,
              "chat_completions": true
            }
          }
        ]
      }
    }
  }
}
```

The provider name is `zed.providerName` in the proxy config (default `"Pi Proxy"`).

### Field mapping: exposed model -> Zed AvailableModel

`toZedModel()` maps each model the exposure config exposes (`ExposedModel`, holding the pi
`Model`):

| Zed field | Source |
|---|---|
| `name` | public model ID (`ExposedModel.publicId`) |
| `display_name` | `Model.name` |
| `max_tokens` | `Model.contextWindow` |
| `max_output_tokens` | `Model.maxTokens` |
| `capabilities.tools` | `true` |
| `capabilities.images` | `Model.input` includes `"image"` |
| `capabilities.parallel_tool_calls` | `true` |
| `capabilities.prompt_cache_key` | `false` |
| `capabilities.chat_completions` | `true` |

### JSONC handling

The sync uses `jsonc-parser` (Microsoft's parser, with `modify()` for surgical edits that keep
comments and formatting elsewhere in the file). It replaces the whole
`language_models.openai_compatible.<providerName>` value with `api_url` and `available_models`;
any other key in that provider block is dropped. The rest of the file is untouched.

It parses the file as Zed does, with trailing commas allowed. An empty file, or one holding only
comments, is treated as `{}`. Any other parse error leaves the file untouched and fails with
`Zed settings.json has syntax errors (<error> at line <n>, column <n>); fix them in Zed, then sync
again`.

### Settings file discovery

`findZedSettings()` checks these paths in order and uses the first that exists:

```
1. $CUSTOM_DATA_DIR/settings.json
2. $XDG_CONFIG_HOME/zed/settings.json
3. $HOME/.config/zed/settings.json
```

An unset or empty variable adds no path. It never creates the file. With none found, the sync
fails with `Zed settings.json not found. Checked <each path above, once>`. There is no
`~/Library/Application Support/Zed` path and no Zed Preview path.

2 and 3 follow Zed: on Linux it reads `$XDG_CONFIG_HOME` when set, else `~/.config`, and on macOS
`~/.config`. `$CUSTOM_DATA_DIR` is the proxy's own override, not a Zed setting: Zed's
`--user-data-dir` puts settings in `<dir>/config/settings.json`, and no env var sets it.

## Target: Continue.dev (future)

Continue uses `~/.continue/config.yaml` (YAML with inline comments):

```yaml
models:
  - name: Claude Sonnet 4
    provider: openai
    model: anthropic/claude-sonnet-4-20250514
    apiBase: http://127.0.0.1:4141/v1
    contextLength: 200000
    capabilities:
      - tool_use
      - image_input
```

Same `ModelInfo` input, different serialization target.

## Extension commands

Proposed:

```
/proxy sync           Sync to all detected targets
/proxy sync zed       Sync to Zed only
/proxy sync --dry-run Preview without writing
/proxy sync --list    Show detected targets and their config paths
```

Built instead:

```
/proxy zed-sync           Write the exposed models to Zed's settings.json
/proxy zed-sync --dry-run Report what would change without writing
```

Both reload the proxy config first. With no models exposed they fail with `No models exposed.
Nothing to sync.` The result is a notification that counts model names: added, removed and
unchanged, or `no changes`, then the settings path. A dry run prefixes the counts with `[dry-run]`:

```
Zed sync: [dry-run] 2 added, 1 removed, 5 unchanged (/home/me/.config/zed/settings.json)
```

Counts compare names only: a model whose fields change, or a changed `api_url`, still counts as
unchanged.

With `zed.autoSync` on (default off), the extension also syncs, without a dry run, at session
start and after each change in the `/proxy config` settings panel. A successful auto-sync notifies
`Zed auto-sync: …`; a failed one is only logged.

## Implementation phases

1. **Add `x_pi` metadata to model endpoints** — proxy package only
2. **Scaffold sync monorepo packages** — contracts, engine, target-zed
3. **Implement Zed target** — JSONC read/write with `jsonc-parser`
4. **Wire into extension** — `/proxy sync` commands
5. **Add Continue target** — when demand exists
