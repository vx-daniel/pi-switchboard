# Running pi-switchboard in Docker

The image runs the proxy headless, with its own pi login in a volume. You need Docker and nothing else: pi is in the image, and so is the proxy's Node runtime.

## The image

| | |
|---|---|
| **Docker Hub** | [`vxdaniel/pi-switchboard:<version>`](https://hub.docker.com/r/vxdaniel/pi-switchboard) |
| **GHCR** | `ghcr.io/vx-daniel/pi-switchboard:<version>`, the same image, free of Docker Hub's pull limit (100 anonymous pulls per 6 hours per IP address) |
| **Tags** | One per release, the version alone: `0.4.0`. There is no `latest`, and a published tag is never overwritten, so a version always means the same image. The versions are the [releases](https://github.com/vx-daniel/pi-switchboard/releases) |
| **Platforms** | `linux/amd64` and `linux/arm64`, about 96 MB compressed each |
| **Base** | `node:24` (Debian bookworm, slim), pinned by digest in the [`Dockerfile`](../Dockerfile), so a rebuild can't change the runtime silently |
| **Runs as** | `node`, UID 1000; everything outside the login volume is owned by root and read-only to it |
| **Listens on** | `0.0.0.0:4141` inside the container (`PI_SWITCHBOARD_HOST`, `PI_SWITCHBOARD_PORT`) |
| **Keeps its state in** | `/home/node/.pi/agent` (`PI_CODING_AGENT_DIR`): pi's login, `proxy-config.json` and the stats file |
| **Labels** | The OCI `org.opencontainers.image.*` labels: source, version, the commit it was built from, license |

Each image is built from its release tag by the release workflow ([`image.yml`](../.github/workflows/image.yml)), and its index carries buildx's build provenance attestations. `docker buildx imagetools inspect vxdaniel/pi-switchboard:<version>` shows the platforms and the digest.

## Quick start with Compose

[`compose.yaml`](../compose.yaml) runs the image with the hardening below and a named volume for the login. You don't need a checkout of the repository; the release's own copy will do:

```bash
version=<version>   # a release, such as 0.4.0
curl -LO "https://raw.githubusercontent.com/vx-daniel/pi-switchboard/pi-switchboard-v$version/compose.yaml"
export PI_SWITCHBOARD_VERSION="$version"
export PI_SWITCHBOARD_AUTH_TOKEN="$(openssl rand -hex 32)"   # keep it: clients send it
docker compose pull

# Log in through pi, in the container: enter /login inside pi, then exit pi.
docker compose run --rm --no-deps --entrypoint pi proxy --no-session --no-tools --no-extensions --offline

docker compose up --wait
curl -H "Authorization: Bearer $PI_SWITCHBOARD_AUTH_TOKEN" http://127.0.0.1:4141/v1/models
```

Pull before the first `up`. Compose builds the image when it can't find it, and without a checkout there is no `Dockerfile` to build from. In a checkout, `docker compose build` builds it from source instead, tagged `local` while `PI_SWITCHBOARD_VERSION` is unset.

## Without Compose

The same, with `docker run` and the flags `compose.yaml` sets:

```bash
image=vxdaniel/pi-switchboard:<version>
docker volume create pi-agent

# Log in.
docker run --rm -it -v pi-agent:/home/node/.pi/agent --entrypoint pi "$image" \
  --no-session --no-tools --no-extensions --offline

# Run the proxy.
docker run -d --name pi-switchboard --init \
  -e PI_SWITCHBOARD_AUTH_TOKEN="$PI_SWITCHBOARD_AUTH_TOKEN" \
  -p 127.0.0.1:4141:4141 \
  -v pi-agent:/home/node/.pi/agent \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true \
  "$image"
```

`docker run --rm "$image" --version` prints the version and needs no token, and so does `--help`.

## Logging in

pi runs the login, in the container, and stores it in the volume. In pi, `/login` lists the providers.

- **A browser login** (an Anthropic or ChatGPT subscription) opens a URL to sign in. The container publishes no port for the login's callback, so when the browser ends on a `localhost` page that doesn't load, copy that whole URL, or the code it shows, and paste it into pi.
- **An API key** login asks for the key.
- `fd` and `ripgrep` warnings are expected: pi is there to log in, not to run tools.
- **Stop the proxy before logging in again** (`docker compose stop`), and start it after.
- **Never seed the volume with a copy of a host `auth.json`.** Refreshing a login rotates its refresh token, and the other copy then stops working.
- **Several logins per provider** ([`anthropic-2`](logins.md)) aren't covered in the image yet. A second login is made in the proxy's console (`pi-switchboard tui`), not by pi's own `/login`; the image runs the proxy headless, and copying a login made on a host into the volume is ruled out (the point above).

## The token is required

The image listens on every interface inside the container, so it refuses to start without `PI_SWITCHBOARD_AUTH_TOKEN` and exits with status `64`, saying why. It takes the token from the environment only, not from `proxy-config.json`. The token is a secret of your own that protects the proxy; it is not a provider key. Every route but `/healthz`, the OpenAPI document and the docs page needs it ([Proxy authentication](configuration.md#proxy-authentication)).

## Configuration

Everything the [configuration reference](configuration.md#every-setting) lists works in the container. There are two ways to set it:

- **`proxy-config.json` in the volume**, as on a host. Write it from the host while the proxy runs, as the `node` user the proxy reads it as:

  ```bash
  docker compose exec -T proxy sh -c 'cat > /home/node/.pi/agent/proxy-config.json' < proxy-config.json
  ```

  Exposure, aliases and routing apply from the next request. Every other setting (the docs page, the Responses API, remote images, stats, the body size limit, the upstream timeout, the log level, the host/origin guard) applies at the next start: `docker compose restart`.
- **Environment variables.** `compose.yaml` passes four through, and only when they are set, so the file's values apply otherwise: `PI_SWITCHBOARD_LOG_LEVEL`, `PI_SWITCHBOARD_LOG_FORMAT`, `PI_SWITCHBOARD_UPSTREAM_TIMEOUT_MS` and `TZ`. For any other, add it in a `compose.override.yaml` beside `compose.yaml`, which Compose reads as well:

  ```yaml
  services:
    proxy:
      environment:
        PI_SWITCHBOARD_DOCS_UI: 'true'
        PI_SWITCHBOARD_RESPONSES_API: 'true'
  ```

  With `docker run`, pass it with `-e`. A switch takes `true` or `false`; anything else counts as `false`.

`PI_SWITCHBOARD_HOST` and `PI_SWITCHBOARD_PORT` are set by the image; leave them, and choose the published port instead (below).

## Ports and exposure

Compose publishes the port on `127.0.0.1` only, so the proxy is reachable from this machine alone. `PI_SWITCHBOARD_PUBLISH_PORT` changes the host port (default `4141`).

To reach it from other machines, publish it on another address, and put it behind a reverse proxy with TLS: clients send the bearer token on every request, and it must not cross a network in the clear. Two things a reverse proxy in front of it needs:

- **No response buffering** on `/v1/chat/completions` and `/v1/responses`, or a streamed answer arrives all at once at the end (nginx: `proxy_buffering off`).
- **A long enough read timeout.** A stream sends nothing, headers included, until the provider accepts the request ([API compatibility](api.md#api-compatibility)); the proxy waits up to its upstream idle timeout (120 s by default) for that.

## Logs, health and usage

- **Logs** go to the container's output, as JSON lines (the default with no terminal): `docker compose logs -f`. `PI_SWITCHBOARD_LOG_FORMAT=pretty` makes them readable directly; `TZ` sets the time zone of the pretty timestamps. What is logged: [Logging](configuration.md#logging).
- **Health.** The image's healthcheck asks `GET /healthz` every 30 seconds, which needs no token, so the container is healthy as soon as the proxy listens, before any login. `GET /healthz/creds?verify=true` with the token checks the login itself ([Health checks](api.md#health-checks)).
- **Usage.** The proxy keeps its stats file in the volume; `GET /v1/switchboard/usage` reads it, as the console's Stats view does on a host ([Usage over HTTP](api.md#usage-over-http)).
- **Checking the setup.** `docker compose exec proxy node dist/index.mjs doctor` runs [`pi-switchboard doctor`](configuration.md#checking-the-setup-pi-switchboard-doctor) in the running container, with the proxy's environment: the config, the login and the prompt cache, with what to change.

## Hardening

`compose.yaml` runs the container with:

- a read-only root filesystem, and `/tmp` as a tmpfs;
- every Linux capability dropped, and `no-new-privileges`;
- `init`, so signals reach the proxy and child processes are reaped;
- the `node` user (UID 1000); the volume is the only place it writes.

## Upgrading

Releases never replace a tag, so an upgrade is a new version:

```bash
export PI_SWITCHBOARD_VERSION=<new version>
docker compose pull
docker compose up -d --wait
```

The login, `proxy-config.json` and the stats stay in the volume. `docker compose down` keeps the volume; `down -v` deletes it, and the login with it.

An existing login volume from an earlier deployment works unchanged when it was mounted at the same path for the same UID: declare it in `compose.yaml` as an `external` volume under its name.

## When it doesn't start

| Symptom | Cause |
|---|---|
| Exits at once with status `64` | No `PI_SWITCHBOARD_AUTH_TOKEN` in the container's environment |
| Exits with status `1`, logging "Refusing to start" | Proxy auth that is set but can't be applied: an empty token, or a `proxy-config.json` that can't be read or parsed while no token is set ([Proxy authentication](configuration.md#proxy-authentication)) |
| Healthy, but `/v1/models` is empty and `/healthz/models` answers `503` | No login in the volume yet, or none that exposes a model: log in, then check `GET /healthz/creds` |
| `docker compose up` tries to build and fails | The image isn't pulled and there is no `Dockerfile`: set `PI_SWITCHBOARD_VERSION` and `docker compose pull` |
| A browser login ends on a page that doesn't load | Expected: paste that page's URL into pi ([Logging in](#logging-in)) |
