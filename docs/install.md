# Installing pi-switchboard

## Which install

| | [Standalone binary](#standalone-binary) | [Docker](#docker) | [npm CLI](#installation) | [pi package](pi-extension.md#pi-integration) |
|---|---|---|---|---|
| **Needs** | Nothing else | Docker | Node.js >= 24, a GitHub token for GitHub Packages | Node.js >= 24, pi, a GitHub token |
| **Logging in** | `./pi-switchboard-<os>-<arch> tui`, then `n`; or `pi /login` | pi, inside the container | `pi-switchboard tui`, then `n`; or `pi /login` | `pi /login` |
| **Config and logins** | `~/.pi/agent` | The `pi-agent` volume | `~/.pi/agent` | `~/.pi/agent` |
| **Updating** | Download the new release's file | Pull the new version's tag; there is no `latest` | `pnpm add -g @vx-daniel/pi-switchboard@latest` | `pi update npm:@vx-daniel/pi-switchboard` |
| **Console** (`tui`) | Yes | No: it runs headless; [usage over HTTP](api.md#usage-over-http) and the health checks instead | Yes | With the npm CLI installed as well |
| **`/proxy` commands in pi** | No | No | No | Yes |
| **Good for** | A machine without Node | A server, or a shared proxy | A developer machine with Node | Starting and stopping it from pi |

Every install reads the same settings: flags, `PI_SWITCHBOARD_*` variables and `proxy-config.json` ([Configuration](configuration.md#every-setting)).

## Prerequisites

What else you need depends on how you install it:

| Install | Needs |
|---|---|
| [Standalone binary](#standalone-binary) | Nothing: pi is compiled in |
| [Docker image](#docker) | Docker; pi is in the image |
| [npm CLI](#installation) | [Node.js](https://nodejs.org) >= 24, the runtime pi uses; pi's packages come with it |
| [pi package](pi-extension.md#pi-integration) | Node.js >= 24 and [pi](https://github.com/earendil-works/pi) |

Every way needs at least one provider login, stored where pi keeps them: `pi /login`, or `n` in the proxy's own console (`pi-switchboard tui`, [The console](console.md#the-console-logs-logins-and-status-at-a-terminal)). With Docker, you log in through pi inside the container ([Docker](#docker)).

### Headless and scripted setup

- **An API key needs no login.** pi reads it from the environment: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` and the other `<PROVIDER>_API_KEY` names pi knows. Set it where the proxy runs (`docker run -e ANTHROPIC_API_KEY=…`, a systemd `Environment=`, a shell profile) and the provider's models are served from the start.
- **A subscription (OAuth) is interactive once.** It needs a browser, or a code pasted back, so it can't be scripted: run `pi-switchboard tui` and press `n`, or `pi /login`, once per host. pi keeps the login in `auth.json` and refreshes it from then on. There is no separate `pi-switchboard login` command (#201): it would be the console's `n` without the console.
- **Restart after a login made elsewhere.** A running proxy reads pi's logins when it starts. A login through its own console is served at once; one made by another process (`pi /login`, another console, an edited `auth.json`) is served after the proxy restarts.

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

The image runs the proxy headless, with its own pi login in a volume: [`vxdaniel/pi-switchboard:<version>`](https://hub.docker.com/r/vxdaniel/pi-switchboard) on Docker Hub, or `ghcr.io/vx-daniel/pi-switchboard:<version>` on GHCR, for `linux/amd64` and `linux/arm64`. It needs Docker and nothing else.

```bash
export PI_SWITCHBOARD_VERSION=<version> PI_SWITCHBOARD_AUTH_TOKEN="$(openssl rand -hex 32)"
curl -LO "https://raw.githubusercontent.com/vx-daniel/pi-switchboard/pi-switchboard-v$PI_SWITCHBOARD_VERSION/compose.yaml"
docker compose pull
docker compose run --rm --no-deps --entrypoint pi proxy --no-session --no-tools --no-extensions --offline   # /login, then exit
docker compose up --wait
```

Everything else, from `docker run` without Compose to logging in, configuration, exposing it beyond localhost, upgrading and troubleshooting: [Running pi-switchboard in Docker](docker.md).

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
