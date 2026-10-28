# Architecture

One process serves the API. A request passes through the HTTP layer to routing, which picks the model and the login, and pi's SDK calls the provider with pi's own credentials. pi's agent directory holds what the process reads and keeps: pi's logins and models, the proxy's `proxy-config.json`, and the stats file. The console, when the proxy runs as `pi-switchboard tui`, is the same process: it reads the live state and writes the config.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="diagrams/architecture-dark.svg">
  <img alt="pi-switchboard's architecture: clients, the HTTP layer, routing, pi's SDK and the providers, with pi's agent directory, the console and the pi extension" src="diagrams/architecture.svg">
</picture>

## A chat request, end to end

Before any provider is called, a chat request is checked and its route planned: the host/origin guard when it is on, the body size limit, proxy auth and strict validation, then a model or alias the exposure config exposes, the candidates it may run on (an alias's targets, each under every login), and a login pi can resolve for them. A request that fails any of these is answered at once and counted as rejected. The rest call the candidates in order through pi. A failure before the answer started moves to the next candidate only when the alias's `fallbackOn`, or `routing.logins.fallbackOn` between logins, names its class ([Routing](routing.md)). A Responses API request (`POST /v1/responses`, when on) is translated into a chat request first and runs the same way; only its answer is shaped differently.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="diagrams/chat-request-dark.svg">
  <img alt="A chat request: checks, the route plan, calls through pi, and the fallback loop until an answer or an error" src="diagrams/chat-request.svg">
</picture>

## Where the numbers come from

Every request is recorded in memory as it happens: the HTTP requests, the chat requests with their models and timings, and the totals per route. The console reads these live, and the stats recorder writes them to `pi-switchboard-stats.sqlite` every 5 seconds, kept 30 days, for the Stats view and `GET /v1/switchboard/usage`. Provider answers feed the other store: each subscription's quota windows from its response headers, and the cooldowns a 429, 503 or 529 starts. The console's Accounts view and the health checks and `GET /v1/switchboard/models` read those.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="diagrams/numbers-dark.svg">
  <img alt="Requests feed in-memory registries read live by the console and stored every 5 seconds in the stats file; provider answers feed quota and cooldowns" src="diagrams/numbers.svg">
</picture>

The diagrams' sources are in [`diagrams/`](diagrams/): an HTML page per diagram and skin, and the SVG exported from it that these pages show.

## Where the code is

| Part | Source |
|---|---|
| Entry points | `src/index.ts` and `src/cli.ts` (the `pi-switchboard` command), `src/tui/command.ts` (`tui`), `src/doctor/command.ts` (`doctor`), `src/standalone/` (the standalone binary) |
| HTTP layer | `src/server/`: the Hono app and its middleware (`app.ts`, `middleware.ts`, `proxy-auth.ts`, `host-origin-guard.ts`), the routes (`routes.ts`, `responses-route.ts`, `health.ts`, `usage.ts`, `cooldowns.ts`), the OpenAPI document (`openapi.ts`) and the error mapping (`errors.ts`) |
| Routing | `src/server/route-plan.ts`, `route-hops.ts`, `route-cooldowns.ts`, `route-reserve.ts` and `chat-dispatch.ts` (the candidates and the walk over them); `src/openai/model-exposure.ts`, `model-aliases.ts`, `model-families.ts` and `model-logins.ts` (what is exposed, aliases, family aliases, login order) |
| OpenAI shapes | `src/openai/`: request schemas and validation, message and tool conversion, responses and SSE; `src/openai/responses-api/` for the Responses API |
| pi's SDK | `src/pi/`: the model runtime and credentials (`registry.ts`), calls (`complete.ts`), the `{provider}-N` logins (`accounts.ts`), cooldowns, quota and availability |
| Numbers | `src/stats/` (the stats file), and the in-memory registries in `src/server/` (`http-requests.ts`, `active-requests.ts`, `route-totals.ts`) |
| The console | `src/tui/` |
| The doctor | `src/doctor/`: reads the same reports as `/healthz/models` and `/healthz/creds`, and the stats file |
| Config | `src/config/`: `proxy-config.json`'s schema, flags and env vars |
| pi extension | `extensions/proxy/` (`/proxy` in pi); `src/sync/zed.ts` writes Zed's model list |

## Pi SDK layers used

- **`@earendil-works/pi-ai`** — types (`Model`, `Usage`, `AssistantMessageEvent`, `JsonObject`, …) and helpers: `getSupportedThinkingLevels` and `clampThinkingLevel` for `reasoning_effort`, `isContextOverflow` for `context_length_exceeded`, TypeBox's `Type` for tool schemas
- **`@earendil-works/pi-coding-agent`** — `ModelRuntime` (credentials, catalog and request auth; completions run through its `streamSimple()`, non-streaming ones read the stream's final message), `SettingsManager` (pi's `enabledModels`), and the console's theme and clipboard
- **`@earendil-works/pi-tui`** — the console's terminal rendering

Requires Pi 1.x (`^1.4.0`). Pi 1.0 is the first release whose Anthropic client identifies as Claude Code 2.1.280, which Anthropic requires for Opus 5.5 and Fable 5.1; Pi 0.x identified as 2.1.75 and those models were refused.
