# Architecture

```text
┌─────────────────────────────┐         ┌──────────────────────────────────┐
│       HTTP Client           │         │        pi-switchboard            │
│  (curl, Aider, Continue,    │         │                                  │
│   LiteLLM, Open WebUI, etc.)│         │  ┌────────────────────────────┐  │
└─────────────┬───────────────┘         │  │     Hono HTTP Server       │  │
              │                         │  │  ├─ Request parser         │  │
              │  POST /v1/chat/         │  │  ├─ Message converter      │  │
              │  completions            │  │  ├─ Model resolver         │  │
              ├────────────────────────►│  │  ├─ Tool converter         │  │
              │                         │  │  └─ SSE encoder            │  │
              │  GET /v1/models         │  └────────────────────────────┘  │
              ├────────────────────────►│                                  │
              │                         │  ┌────────────────────────────┐  │
              │                         │  │        Pi SDK              │  │
              │  SSE / JSON             │  │  ├─ ModelRuntime           │  │
              │◄────────────────────────┤  │  ├─ SettingsManager        │  │
              │                         │  │  └─ streamSimple()         │  │
                                        │  └────────────────────────────┘  │
                                        └──────────────────────────────────┘
```

## Pi SDK layers used

- **`@earendil-works/pi-ai`** — the types `Model`, `Usage`, `AssistantMessageEvent`, `JsonObject`
- **`@earendil-works/pi-coding-agent`** — `ModelRuntime` (credentials, catalog and request auth; completions run through its `streamSimple()`, non-streaming ones read the stream's final message) and `SettingsManager`

Requires Pi 1.x (`^1.4.0`). Pi 1.0 is the first release whose Anthropic client identifies as Claude Code 2.1.280, which Anthropic requires for Opus 5.5 and Fable 5.1; Pi 0.x identified as 2.1.75 and those models were refused.
