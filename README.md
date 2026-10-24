# pi-switchboard

**One OpenAI-compatible endpoint for every model your [pi](https://github.com/earendil-works/pi) logins can reach, with routing that falls back, cools down and keeps your quota in view.**

Point any OpenAI client at `http://localhost:4141/v1` (Aider, Continue, Open WebUI, the OpenAI SDKs, agent frameworks), and pi-switchboard sends each request through pi to Anthropic, OpenAI, Google, Bedrock, Mistral, xAI, OpenRouter and the rest, with the logins you already have, subscriptions included.

## Why pi-switchboard

- **20+ providers behind one API.** Every model pi knows, under one OpenAI-compatible base URL, streaming included.
- **Your logins, not new API keys.** It uses pi's logins: API keys, and subscriptions such as Claude Pro/Max, ChatGPT and GitHub Copilot. Log in once, with pi or in the proxy's own console.
- **Routing you control.** Aliases give models the names your team uses, set the reasoning effort they run at, follow a family's newest model, and fall back along a chain on the failures you choose ([Routing](docs/routing.md)).
- **Several logins per provider.** A second subscription to the same service is a second login; the proxy moves to it when the first hits its limit ([Logins](docs/logins.md)).
- **Quota and cooldowns.** It reads each subscription's usage windows, keeps a reserve you set, and cools a provider that answered 429 for as long as it said.
- **Honest about what it does.** Responses are checked against OpenAI's published spec, a field it doesn't support is refused with a clear error rather than dropped, and every response says which model and login answered (`x_pi`).
- **See what's happening.** `pi-switchboard tui` shows every request, your logins and their quota, usage and cost over 30 days, and your aliases, and edits them ([The console](docs/console.md)).
- **Local and safe by default.** It listens on `127.0.0.1`. Listening wider without a token logs a warning, and the Docker image won't start without one ([Security](docs/security.md)).

## Get it

| | |
|---|---|
| **Standalone binary** | One file for Linux, macOS or Windows from the [releases](https://github.com/vx-daniel/pi-switchboard/releases): no Node, no pi install |
| **Docker** | `ghcr.io/vx-daniel/pi-switchboard:<version>` or `vxdaniel/pi-switchboard:<version>`, for amd64 and arm64 |
| **npm** | `pnpm add -g @vx-daniel/pi-switchboard`, from GitHub Packages |
| **pi package** | `pi install npm:@vx-daniel/pi-switchboard`, for the `/proxy` commands inside pi |

Requirements, the GitHub Packages token, logging in under Docker and checking a download: [Installing](docs/install.md).

## Try it

```bash
pi-switchboard tui    # the proxy with its console: press n to log in to a provider
```

Then, from another terminal:

```bash
curl http://localhost:4141/v1/models | jq '.data[].id'

curl http://localhost:4141/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-sonnet-5-5", "messages": [{"role": "user", "content": "Hello!"}]}'
```

Use a model ID from the list. Without the console, `pi-switchboard` runs the proxy on its own.

A fallback chain is a few lines of `proxy-config.json` in pi's agent directory:

```json
{ "aliases": { "coding": {
  "targets": ["anthropic/claude-opus-5-5", "openai-codex/gpt-6-sol"],
  "fallbackOn": ["rate_limit", "unavailable"]
} } }
```

A request for `"model": "coding"` goes to Claude Opus, and to Codex when Opus is rate-limited or overloaded.

## Documentation

Everything else is in [`docs/`](docs/README.md): installing, configuration, the HTTP API, routing, logins, the console, the pi extension and security.

Working on pi-switchboard: [CONTRIBUTING.md](CONTRIBUTING.md), [CHANGELOG.md](CHANGELOG.md), [ROADMAP.md](ROADMAP.md), and the principles in [CONSTITUTION.md](CONSTITUTION.md).

## Attribution

pi-switchboard started as [`pi-openai-proxy`](https://github.com/victor-software-house/pi-openai-proxy) by **Victor Araújo** (Victor Software House), published on npm as `@victor-software-house/pi-openai-proxy` (last release 4.9.5). This project forked it at `2fec663` (v4.9.6, 2026-06-08). The 110 commits up to that point are his and stay in this repository's history.

Model exposure, public IDs and strict request validation come from the original. Since the fork, the project has:
- moved to pi 1.x and its `ModelRuntime`;
- added health checks, opt-in remote images and checks against OpenAI's published spec;
- added the OpenAPI document and docs page;
- moved to the Vite+ toolchain;
- added the multi-login routing it is now named for: aliases, fallback chains, cooldowns, quota and several logins per provider (#66–#70, #227);
- added the terminal console, usage stats, standalone binaries and the experimental Responses API.

Versions restart at 0.1.0 under the new name. The original's `v4.x` tags remain in the history.

## License

MIT. The original copyright, Victor Araújo's, is kept in [`LICENSE`](LICENSE), alongside this project's.
