# Installing pi-switchboard

## Prerequisites

What else you need depends on how you install it:

| Install | Needs |
|---|---|
| [Standalone binary](#standalone-binary) | Nothing: pi is compiled in |
| [Docker image](#docker) | Docker; pi is in the image |
| [npm CLI](#installation) | [Node.js](https://nodejs.org) >= 24, the runtime pi uses; pi's packages come with it |
| [pi package](pi-extension.md#pi-integration) | Node.js >= 24 and [pi](https://github.com/earendil-works/pi) |

Every way needs at least one provider login, stored where pi keeps them: `pi /login`, or `n` in the proxy's own console (`pi-switchboard tui`, [below](console.md#the-console-logs-logins-and-status-at-a-terminal)). With Docker, you log in through pi inside the container ([Docker](#docker)).

## Installation

The package is published to GitHub Packages, whose npm registry needs a GitHub token to install anything, public packages included. The Docker image needs none: see [Docker](#docker).

**Once, before the first install:**

1. Create a GitHub personal access token (classic) with the `read:packages` scope. GitHub Packages accepts only classic tokens.
2. Point the `@vx-daniel` scope at GitHub Packages in `~/.npmrc`. These two lines send only `@vx-daniel/*` packages there; everything else still comes from npmjs:

   ```ini
   @vx-daniel:registry=https://npm.pkg.github.com
   //npm.pkg.github.com/:_authToken=<your token>
   ```

**Then:**

```bash
# As a pi package: /proxy, the settings panel and the model selector inside pi
pi install npm:@vx-daniel/pi-switchboard

# Or the CLI on its own
pnpm add -g @vx-daniel/pi-switchboard
```

Install by the package name, as above. pi also accepts a tarball URL (`npm:https://…/x.tgz`), but pi 1.3.0 then reports the package as installed without loading its extension.

pi's own packages (`@earendil-works/pi-ai`, `pi-coding-agent`) are optional dependencies, so that pi, which provides them to its extensions, does not load a second copy (#165). Every installer adds optional dependencies by default. Installed with `--omit=optional` or `--no-optional`, the `pi-switchboard` CLI cannot start: it says which package is missing and exits with status `1`.

## Docker

The image runs the proxy headless, with its own pi login in a volume. Each release publishes it for `linux/amd64` and `linux/arm64` as [`vxdaniel/pi-switchboard:<version>`](https://hub.docker.com/r/vxdaniel/pi-switchboard) on Docker Hub. The same image is also published as `ghcr.io/vx-daniel/pi-switchboard:<version>` on GHCR, which is not subject to Docker Hub's pull limit of 100 anonymous pulls per 6 hours per IP address. A published tag is never overwritten, and there is no `latest`, so a version always means the same image. The `Dockerfile` builds it from this repository's source, with one lockfile for the proxy and pi.

From a checkout, with [`compose.yaml`](../compose.yaml):

```bash
export PI_SWITCHBOARD_AUTH_TOKEN="$(openssl rand -hex 32)"
docker compose build      # or: export PI_SWITCHBOARD_VERSION=<version> && docker compose pull

# Log in through pi, in the container; enter /login inside pi, then exit pi.
docker compose run --rm --no-deps --entrypoint pi proxy --no-session --no-tools --no-extensions --offline

docker compose up --wait
curl -H "Authorization: Bearer $PI_SWITCHBOARD_AUTH_TOKEN" http://127.0.0.1:4141/v1/models
```

- **The token is required.** The image listens on every interface inside the container, so it refuses to start without `PI_SWITCHBOARD_AUTH_TOKEN` and exits with status `64`. It takes the token from the environment only, not from `proxy-config.json`. The token is a local secret that protects the proxy, not a provider key. Compose publishes the port on `127.0.0.1` only (`PI_SWITCHBOARD_PUBLISH_PORT` changes it, default `4141`). The one exception is `--version` or `--help` alone, which starts no server: `docker run --rm vxdaniel/pi-switchboard:<version> --version` needs no token (from the first release after 0.1.0).
- **Logging in.** In pi, `/login` lists the providers. The container publishes no OAuth callback port, so when the browser redirects to a `localhost` URL that does not load, paste that whole URL, or the code, into pi. `fd` and `ripgrep` warnings are expected: pi is there to log in, not to run tools. Stop the proxy before logging in again.
- **The volume holds the login.** pi's login and its token refreshes live in the `pi-agent` volume at `/home/node/.pi/agent`, and survive `docker compose down` and `up` (`down -v` deletes them). Never seed the volume by copying a host `auth.json`: refreshing a login rotates its refresh token, and the other copy stops working.
- **Settings.** `proxy-config.json` in the volume works as on the host. Compose passes `PI_SWITCHBOARD_LOG_LEVEL`, `PI_SWITCHBOARD_LOG_FORMAT`, `PI_SWITCHBOARD_UPSTREAM_TIMEOUT_MS` and `TZ` to the container only when they are set, so the file's values apply otherwise.
- **Hardening, in `compose.yaml`:** the proxy runs as UID 1000, with a read-only root filesystem, `/tmp` as tmpfs, all capabilities dropped and `no-new-privileges`. The volume is the only place it writes.
- **Health.** The image's healthcheck asks `GET /healthz`, which needs no token, so the container is healthy before you log in. `GET /v1/models` with the token lists what the login can use.
- **An existing login volume** from an earlier deployment works unchanged when it was mounted at the same path for the same UID: declare it in `compose.yaml` as an `external` volume under its name.

## Standalone binary

Each GitHub release after 0.3.0 carries the proxy as one executable for Linux, macOS and Windows (x64 and arm64): `pi-switchboard-linux-x64`, `pi-switchboard-linux-arm64`, `pi-switchboard-darwin-x64`, `pi-switchboard-darwin-arm64` with a `SHA256SUMS` file, and `pi-switchboard-windows-x64.exe`, `pi-switchboard-windows-arm64.exe` with a `SHA256SUMS-windows` file. It needs no Node and no pi install: pi is compiled in. The macOS and Windows binaries are unsigned, so Gatekeeper and SmartScreen warn on the first run. 0.3.0 and earlier have no binaries: their source predates it.

```bash
version=<version>   # a release after 0.3.0
base="https://github.com/vx-daniel/pi-switchboard/releases/download/pi-switchboard-v$version"
curl -LO "$base/pi-switchboard-linux-x64" -LO "$base/SHA256SUMS"
sha256sum --check --ignore-missing SHA256SUMS   # macOS: shasum -a 256 --check --ignore-missing SHA256SUMS
gh attestation verify pi-switchboard-linux-x64 --repo vx-daniel/pi-switchboard   # optional: built by this repo's release workflow
chmod +x pi-switchboard-linux-x64
./pi-switchboard-linux-x64 --port 4141
```

Every binary is run (`--version`) on its own platform (Linux and macOS, and Windows when it is built, on x64 and arm64) before the workflow uploads it, and each asset has a [build provenance attestation](https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations) that `gh attestation verify` checks.

- **macOS.** The binaries are not signed with a Developer ID, so Gatekeeper blocks the first run. After checking the checksum, remove the quarantine flag: `xattr -d com.apple.quarantine pi-switchboard-darwin-arm64`. Apple Silicon also needs a valid code signature. Bun writes an ad-hoc one when it compiles for macOS, and the release workflow runs the arm64 binary on macOS before uploading it, but if the shell only prints `killed` when you start it, the signature is missing or broken: sign it ad hoc yourself with `codesign --sign - ./pi-switchboard-darwin-arm64` (add `--force` to replace a broken one) and run it again.
- **Windows.** Check the download in PowerShell with `Get-FileHash .\pi-switchboard-windows-x64.exe` against the line in `SHA256SUMS-windows`, then run `.\pi-switchboard-windows-x64.exe --port 4141`. The binaries are unsigned, so SmartScreen warns on the first run (**More info**, then **Run anyway**). Use the arm64 build on Windows on Arm.
- **Logins come from pi's `auth.json`.** The binary reads the same `~/.pi/agent` (or `PI_CODING_AGENT_DIR`) as the npm package: log in with pi, or in the binary's own console, `./pi-switchboard-linux-x64 tui` ([The console](console.md#the-console-logs-logins-and-status-at-a-terminal)).
- **Same options.** Flags, `PI_SWITCHBOARD_*` variables and `proxy-config.json` work as in [Configuration](configuration.md#configuration). The binary never reads a `.env` or `bunfig.toml` from the directory it starts in.

## Standalone (background) mode

For a proxy that outlives pi sessions, run the binary directly:

```bash
# Foreground
pi-switchboard

# Background
pi-switchboard &

# With custom port
PI_SWITCHBOARD_PORT=8080 pi-switchboard &
```

The extension detects externally running instances and shows their status via `/proxy status` without trying to manage them.
