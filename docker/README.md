# pi-switchboard

![pi-switchboard: one API, every model](https://raw.githubusercontent.com/vx-daniel/pi-switchboard/main/assets/pi-switchboard-header.png)

**One OpenAI-compatible endpoint for every model your [pi](https://github.com/earendil-works/pi) logins can reach, with routing that falls back, cools down and keeps your quota in view.**

Point any OpenAI client at the container's `/v1`, and pi-switchboard sends each request through pi to Anthropic, OpenAI, Google, Bedrock, Mistral, xAI, OpenRouter and the rest, with the logins you made in it, subscriptions included. Source, docs and releases: [github.com/vx-daniel/pi-switchboard](https://github.com/vx-daniel/pi-switchboard).

## Tags

One tag per release, the version alone (`0.4.0`). There is no `latest`, and a published tag is never overwritten, so a version always means the same image. Each is built for `linux/amd64` and `linux/arm64` from its release tag, with buildx's build provenance attached. The same images are on GHCR as `ghcr.io/vx-daniel/pi-switchboard:<version>`, free of Docker Hub's pull limits. The versions and their notes: [releases](https://github.com/vx-daniel/pi-switchboard/releases).

## Quick start

```bash
version=<version>
curl -LO "https://raw.githubusercontent.com/vx-daniel/pi-switchboard/pi-switchboard-v$version/compose.yaml"
export PI_SWITCHBOARD_VERSION="$version"
export PI_SWITCHBOARD_AUTH_TOKEN="$(openssl rand -hex 32)"   # clients send it as a bearer token
docker compose pull

# Log in through pi, in the container: /login inside pi, then exit.
docker compose run --rm --no-deps --entrypoint pi proxy --no-session --no-tools --no-extensions --offline

docker compose up --wait
curl -H "Authorization: Bearer $PI_SWITCHBOARD_AUTH_TOKEN" http://127.0.0.1:4141/v1/models
```

Or with `docker run`:

```bash
docker volume create pi-agent
docker run --rm -it -v pi-agent:/home/node/.pi/agent --entrypoint pi vxdaniel/pi-switchboard:<version> \
  --no-session --no-tools --no-extensions --offline
docker run -d --name pi-switchboard --init -e PI_SWITCHBOARD_AUTH_TOKEN="$PI_SWITCHBOARD_AUTH_TOKEN" \
  -p 127.0.0.1:4141:4141 -v pi-agent:/home/node/.pi/agent \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true \
  vxdaniel/pi-switchboard:<version>
```

## Good to know

- **A bearer token is required.** The image listens on every interface inside the container, so it won't start without `PI_SWITCHBOARD_AUTH_TOKEN` (exit status `64`).
- **The volume holds everything:** pi's login and its token refreshes, the proxy's `proxy-config.json` and its stats, at `/home/node/.pi/agent`. Never seed it with a copy of a host `auth.json`: a token refresh would break the other copy.
- **It runs as `node` (UID 1000)**, and the Compose file adds a read-only root filesystem, dropped capabilities and `no-new-privileges`.
- **Health:** the image's healthcheck asks `GET /healthz`, which needs no token.
- **API docs:** `GET /v1/switchboard/openapi.json` is the OpenAPI document; set `PI_SWITCHBOARD_DOCS_UI=true` for a Swagger UI page at `/docs`.

## Documentation

- [Running pi-switchboard in Docker](https://github.com/vx-daniel/pi-switchboard/blob/main/docs/docker.md): logging in, configuration, exposing it beyond localhost, upgrading, troubleshooting
- [Configuration](https://github.com/vx-daniel/pi-switchboard/blob/main/docs/configuration.md): every setting, as a flag, an environment variable or a `proxy-config.json` key
- [Routing](https://github.com/vx-daniel/pi-switchboard/blob/main/docs/routing.md): aliases, fallback chains, cooldowns and quota
- [The HTTP API](https://github.com/vx-daniel/pi-switchboard/blob/main/docs/api.md) and the [API reference](https://github.com/vx-daniel/pi-switchboard/blob/main/docs/api-reference.md)

MIT licensed. pi-switchboard started as [pi-openai-proxy](https://github.com/victor-software-house/pi-openai-proxy) by Victor Araújo.
