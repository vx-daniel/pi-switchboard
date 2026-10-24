# pi-switchboard documentation

pi-switchboard is a local HTTP API over pi's models, logins and providers that speaks OpenAI's API. The [project README](../README.md) says what it does and shows a first request; these pages cover the rest.

## Where to start

- **Trying it on your machine:** [Installing](install.md), then [The console](console.md) to log in and watch requests.
- **Running it for a team or a server:** [Installing](install.md) (Docker and the standalone binary), [Configuration](configuration.md), [Security](security.md).
- **Pointing a client at it:** [The HTTP API](api.md).
- **Routing across models and logins:** [Routing](routing.md) and [Several logins per provider](logins.md).
- **Using it from inside pi:** [Pi Integration](pi-extension.md).

## Pages

| Page | What it covers |
|---|---|
| [Installing](install.md) | Prerequisites per install method; the npm package and the pi package; Docker; the standalone binary; running in the background |
| [Configuration](configuration.md) | What comes from pi, the proxy's settings (flags, environment, `proxy-config.json`), logging, proxy authentication |
| [The HTTP API](api.md) | Endpoints, the API document, usage and health checks, chat completion features, the Responses API, model IDs and exposure, errors |
| [Routing](routing.md) | Aliases, fallback chains, reasoning effort per alias, family aliases, cooldowns, quota |
| [Several logins per provider](logins.md) | A second subscription to the same provider, and how the proxy picks the login |
| [The console](console.md) | `pi-switchboard tui`: requests, accounts and logins, stats, models and aliases |
| [Pi Integration](pi-extension.md) | The `/proxy` commands and the settings panel inside pi |
| [Security](security.md) | The defaults: the bind address, remote images, size limits, timeouts |
| [Architecture](architecture.md) | How a request flows through the proxy and pi's SDK |
| [Coming from pi-openai-proxy](migration.md) | What the rename changed |

## For contributors

- [CONTRIBUTING.md](../CONTRIBUTING.md): the toolchain, the gate and the tests.
- [CONSTITUTION.md](../CONSTITUTION.md): the principles every change is checked against.
- [PLAN.md](../PLAN.md): the architecture, the API compatibility policy and the security boundaries in full.
- [ROADMAP.md](../ROADMAP.md) and [TODO.md](../TODO.md): what is done and what comes next.
- `reference/`, `engineering/` and `discovery/`: comparisons, analyses and research behind past decisions; `archive/`: plans from before the rename.
