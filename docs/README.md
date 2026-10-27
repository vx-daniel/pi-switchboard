# pi-switchboard documentation

pi-switchboard is a local HTTP API over pi's models, logins and providers that speaks OpenAI's API. The [project README](../README.md) says what it does and shows a first request; these pages cover the rest.

## Where to start

- **Trying it on your machine:** [Installing](install.md), then [The console](console.md) to log in and watch requests.
- **Running it for a team or a server:** [Running in Docker](docker.md), or the standalone binary in [Installing](install.md); then [Configuration](configuration.md) and [Security](security.md).
- **Pointing a client at it:** [The HTTP API](api.md), and the [API reference](api-reference.md) for the OpenAPI document and the docs page.
- **Routing across models and logins:** [Routing](routing.md) and [Several logins per provider](logins.md).
- **Using it from inside pi:** [Pi Integration](pi-extension.md).

## Pages

| Page | What it covers |
|---|---|
| [Running in Docker](docker.md) | The image and its tags, Compose and `docker run`, logging in, configuration, exposure, upgrading, troubleshooting |
| [Installing](install.md) | Which install to choose, compared; prerequisites; the npm package and the pi package; Docker; the standalone binary; running in the background |
| [Configuration](configuration.md) | Where settings come from and where the files are, every setting in one table, a complete `proxy-config.json`; then what comes from pi, logging and proxy authentication |
| [API reference](api-reference.md) | The OpenAPI document, using it in other tools, and the Swagger UI docs page |
| [The HTTP API](api.md) | Endpoints, the API document, usage and health checks, chat completion features, the Responses API, model IDs and exposure, errors |
| [Routing](routing.md) | Aliases, fallback chains, reasoning effort per alias, family aliases, cooldowns, quota |
| [Several logins per provider](logins.md) | A second subscription to the same provider, and how the proxy picks the login |
| [Prompt caching](caching.md) | How each provider caches, reading cache hits and writes, keeping a prompt cacheable, routing's effect on the cache, `PI_CACHE_RETENTION` and when it pays |
| [The console](console.md) | `pi-switchboard tui`: requests, accounts and logins, stats, models and aliases |
| [Pi Integration](pi-extension.md) | The `/proxy` commands and the settings panel inside pi |
| [Security](security.md) | The defaults: the bind address, remote images, size limits, timeouts |
| [Architecture](architecture.md) | How it fits together, a chat request end to end, and where the numbers come from, as diagrams; pi's SDK layers |
| [Coming from pi-openai-proxy](migration.md) | What the rename changed |

## For contributors

- [CONTRIBUTING.md](../CONTRIBUTING.md): the toolchain, the gate and the tests.
- [CONSTITUTION.md](../CONSTITUTION.md): the principles every change is checked against.
- [PLAN.md](../PLAN.md): the architecture, the API compatibility policy and the security boundaries in full.
- [ROADMAP.md](../ROADMAP.md) and [TODO.md](../TODO.md): what is done and what comes next.
- `diagrams/`: the diagrams these pages show, each as an HTML source per skin (Tokyo Night Light and Storm) and the SVG exported from it.
- `reference/`, `engineering/` and `discovery/`: comparisons, analyses and research behind past decisions; `archive/`: plans from before the rename.
