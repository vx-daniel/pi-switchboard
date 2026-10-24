# pi-switchboard

A local OpenAI-compatible HTTP API built on [pi](https://github.com/earendil-works/pi)'s SDK. Routes requests through pi's multi-provider model registry and credential management, exposing a single `http://localhost:4141/v1/...` endpoint that any OpenAI-compatible client can connect to. It started as [`pi-openai-proxy`](#attribution).

## Why

- **Single gateway** to 20+ LLM providers (Anthropic, OpenAI, Google, Bedrock, Mistral, xAI, Groq, OpenRouter, Vertex, etc.) via one OpenAI-compatible API
- **No duplicate config** — reuses pi's `~/.pi/agent/auth.json` and `models.json` for credentials and model definitions
- **Self-hosted** — runs locally, no third-party proxy services
- **Streaming** — full SSE streaming with token usage and cost tracking
- **Strict validation** — unsupported parameters are rejected clearly, not silently ignored, and every response is checked against OpenAI's published spec

On top of that it routes across your pi logins: aliases, fallback chains, cooldowns, quota awareness and several logins per provider (#66–#70, #227), with a terminal console to watch and manage it. More of OpenAI's API comes next: the Responses API is in, experimental and off by default (#140). See [`ROADMAP.md`](ROADMAP.md). It stays OpenAI-compatible on the client side; it doesn't run logins of its own, keep conversation state, or speak other vendors' client protocols.

## Documentation

Installing, configuration, the HTTP API, routing, the console and the pi extension are in [`docs/`](docs/README.md).

## Quickstart

Install it first ([Installing](docs/install.md)), then:

```bash
# Start the proxy (defaults to http://127.0.0.1:4141)
pi-switchboard

# Which version is installed
pi-switchboard --version
```

### List available models

```bash
curl http://localhost:4141/v1/models | jq '.data[].id'
```

### Chat completion (non-streaming)

```bash
curl http://localhost:4141/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "anthropic/claude-sonnet-4-20250514",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### Chat completion (streaming)

```bash
curl http://localhost:4141/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openai/gpt-4o",
    "messages": [{"role": "user", "content": "Tell me a joke"}],
    "stream": true
  }'
```

### Use with any OpenAI-compatible client

Point any client that supports `OPENAI_API_BASE` (or equivalent) at `http://localhost:4141/v1`:

```bash
# Example: Aider
OPENAI_API_BASE=http://localhost:4141/v1 aider --model anthropic/claude-sonnet-4-20250514

# Example: Continue (in settings.json)
# "apiBase": "http://localhost:4141/v1"

# Example: Open WebUI
# Set "OpenAI API Base URL" to http://localhost:4141/v1
```

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
