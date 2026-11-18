# The admin UI

The admin UI (#367) is a web page for the people who run a pi-switchboard: they sign in with GitHub, and the editors and viewers lists say who may. It is off by default. The `pi-switchboard` server starts it, wherever it runs: the binary, Docker, the npm CLI, or the proxy the pi package starts (which reads the same `proxy-config.json`). The console (`pi-switchboard tui`) ignores it.

So far it is the sign-in alone: the redirect to GitHub, the session it gives, and `GET /admin/api/session`, which says who is signed in with which role. The pages that read the proxy's state, and then the ones that change its settings, come in later releases ([#367](https://github.com/vx-daniel/pi-switchboard/issues/367)).

## What it never does

- **It has its own listener** (`127.0.0.1:4142` by default), apart from the API's. A GitHub session admits to no `/v1` route, and the proxy token admits to no `/admin/` route.
- **It never shows or changes a provider's credentials or the proxy token.** Provider logins stay in a terminal (`pi auth login`, or the console), and the proxy token in the console or the config file.
- **It refuses to start when it would be unsafe or unusable,** and the proxy with it: the log says why ([When it refuses to start](#when-it-refuses-to-start)).

## Setting it up

Sign-in goes through a GitHub App of your own, so every deployment chooses its own people and its own GitHub, including GitHub Enterprise Server. Nothing is shared with this project or anyone else's instance.

### 1. Create a GitHub App

On GitHub, **Settings → Developer settings → GitHub Apps → New GitHub App** (for an organization: the organization's settings, same path). Then:

| Field | Value |
|---|---|
| GitHub App name | Any name; people see it when they first sign in |
| Homepage URL | Any; the admin UI's address will do |
| Callback URL | `<admin UI address>/admin/auth/callback`, such as `http://127.0.0.1:4142/admin/auth/callback`, or `https://switchboard-admin.example.com/admin/auth/callback` behind a reverse proxy |
| Expire user authorization tokens | Either; the admin UI uses the token once, at sign-in, and keeps none |
| Request user authorization (OAuth) during installation | Off |
| Webhook | Off (untick **Active**) |
| Permissions | None, when the lists name only logins. When they name teams: **Organization permissions → Members: Read-only** |
| Where can this GitHub App be installed? | **Only on this account**. For teams, create it under the organization that owns them (or transfer it there: **Advanced → Transfer ownership**), since a private App installs only on its owner |

Create it, note its **Client ID**, and generate a **client secret**.

Logins need nothing more: GitHub says who signed in to any App, installed or not. Teams need the App **installed on each organization those teams belong to** (**Install App** in the App's settings), with Members: Read-only. So a private App under your personal account works for logins but not for an organization's teams; for those, the organization must own the App (or the App must be public).

GitHub answers `404` for a team the App can't see, exactly as for a team the person isn't in, so a missing installation looks like "not in the team": the sign-in is refused, and the log's `Refused sign-in of …` line then names the installation as the likely cause. A team check that fails any other way is logged as `Could not check … counted as not a member`. Either way the person still gets any role their login gives them.

The callback URL must match the admin UI's address exactly: its scheme, host and port. That address is `adminUi.publicUrl`, or `http://<host>:<port>` of the listener when it is unset.

### 2. Choose who may sign in

`adminUi.editors` and `adminUi.viewers` take GitHub logins (`alice`) and teams (`my-org/ops`, the organization and the team's slug), matched without regard to case. Someone on both lists is an editor. Anyone on neither is refused at sign-in.

The role is decided at sign-in and lasts for the session (8 hours): someone removed from a list keeps their session until it ends or they sign out. To end every session at once, change the session key and restart. The lists are checked in order: editors by login, editor teams, viewers by login, viewer teams; GitHub is asked about a team only when no login before it decided, and only an active membership counts (a pending invitation doesn't).

### 3. Give it its secrets

Three secrets, each from an environment variable or from a file its `_FILE` variable names (such as a Docker secret; a trailing newline is dropped). Never from `proxy-config.json`.

| Variable | What it is |
|---|---|
| `PI_SWITCHBOARD_GITHUB_CLIENT_ID` | The App's Client ID |
| `PI_SWITCHBOARD_GITHUB_CLIENT_SECRET` | The App's client secret |
| `PI_SWITCHBOARD_ADMIN_SESSION_KEY` | A random key of at least 32 bytes that signs the sign-in and session cookies, such as `openssl rand -base64 48` |

Setting both a variable and its `_FILE` variant is refused, as is an empty or unreadable file.

### 4. Turn it on

In `proxy-config.json`:

```json
{
  "adminUi": {
    "enabled": true,
    "editors": ["alice", "my-org/ops"],
    "viewers": ["bob"]
  }
}
```

Then start `pi-switchboard` and open `http://127.0.0.1:4142/admin/auth/sign-in`. After GitHub, the browser lands on `/admin/api/session`, which shows your login and role.

## Every setting

| Setting | Environment variable | `proxy-config.json` | Default | Takes |
|---|---|---|---|---|
| On or off | `PI_SWITCHBOARD_ADMIN_UI` | `adminUi.enabled` | `false` | `true`, `false` |
| Bind address | `PI_SWITCHBOARD_ADMIN_HOST` | `adminUi.host` | `127.0.0.1` | An address |
| Port | `PI_SWITCHBOARD_ADMIN_PORT` | `adminUi.port` | `4142` | 1–65535 |
| Its address in a browser | `PI_SWITCHBOARD_ADMIN_URL` | `adminUi.publicUrl` | `""`: `http://<host>:<port>` | An `http` or `https` origin, no path |
| GitHub | — | `adminUi.githubUrl` | `https://github.com` | An origin; GitHub Enterprise Server's, whose API is then at `<origin>/api/v3` |
| Editors | `PI_SWITCHBOARD_ADMIN_EDITORS` (comma-separated) | `adminUi.editors` | `[]` | Logins and `org/team` |
| Viewers | `PI_SWITCHBOARD_ADMIN_VIEWERS` (comma-separated) | `adminUi.viewers` | `[]` | Logins and `org/team` |

An environment variable wins over the file. An entry that is no GitHub login or `org/team` is dropped with a warning.

## Beyond this machine

On loopback the admin UI works over plain `http`. Anywhere else it must be served over `https`, normally by a reverse proxy in front of it: set `adminUi.publicUrl` to the `https` address people open, and the App's callback URL to match. The admin UI checks every request's `Host` (and `Origin`, when there is one) against that address, so the reverse proxy must pass the original `Host` on.

In Docker, keep the admin port on the host's loopback and put the reverse proxy there:

```yaml
services:
  pi-switchboard:
    environment:
      PI_SWITCHBOARD_ADMIN_UI: "true"
      PI_SWITCHBOARD_ADMIN_HOST: 0.0.0.0
      PI_SWITCHBOARD_ADMIN_URL: https://switchboard-admin.example.com
      PI_SWITCHBOARD_ADMIN_EDITORS: my-org/ops
      PI_SWITCHBOARD_GITHUB_CLIENT_ID_FILE: /run/secrets/github_client_id
      PI_SWITCHBOARD_GITHUB_CLIENT_SECRET_FILE: /run/secrets/github_client_secret
      PI_SWITCHBOARD_ADMIN_SESSION_KEY_FILE: /run/secrets/admin_session_key
    ports:
      - 127.0.0.1:4142:4142
    secrets: [github_client_id, github_client_secret, admin_session_key]
```

(Inside the container the listener binds `0.0.0.0`, which the `https` address allows; Docker publishes it on the host's loopback only.)

## When it refuses to start

With `adminUi.enabled` on, `pi-switchboard` logs each reason at `fatal` and exits with status 1 when:

- sign-in is not configured: a secret above is missing;
- a secret is set twice, empty, or its file can't be read;
- the session key is shorter than 32 bytes;
- nobody may sign in: both lists are empty;
- its address is not `https` and not on loopback;
- it binds beyond loopback without an `https` address.

A reason names the setting to fix, never a secret's value.

## How sign-in works

The flow is GitHub's [web application flow for GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app), with PKCE ([RFC 7636](https://www.rfc-editor.org/rfc/rfc7636), `S256`):

1. `GET /admin/auth/sign-in` sends the browser to GitHub with a random `state` and a PKCE challenge, and sets a short cookie (10 minutes, path `/admin/auth`) holding the `state` and the verifier, signed with the session key.
2. GitHub sends the browser back to `/admin/auth/callback`. The admin UI checks that the `state` matches its cookie, exchanges the code (with the verifier and the client secret), reads the login and, for each team a list names until one decides, asks whether the login is an active member (`GET /orgs/{org}/teams/{team}/memberships/{login}`), and drops the token.
3. When a list names that login or one of its teams, it sets the session cookie (8 hours, path `/admin`, `HttpOnly`, `SameSite=Lax`, `Secure` over `https`), signed with the session key and holding only the login, the role and the expiry.

`POST /admin/auth/sign-out` clears the session cookie. Sign-in and the callback (not sign-out) allow 20 requests a minute from one address; every response forbids framing, caching and sending a `Referer`; and a request that changes something must carry the admin UI's own `Origin`.

Behind a reverse proxy every request comes from the reverse proxy's address, so everyone shares those 20 a minute. The admin UI doesn't trust `X-Forwarded-For`, which a client can write. Limit per client at the reverse proxy if several people sign in at once.
