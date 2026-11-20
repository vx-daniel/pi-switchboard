# The admin UI

The admin UI (#367) is a web page for the people who run a pi-switchboard: they sign in with GitHub, and the editors and viewers lists say who may. It is off by default. The `pi-switchboard` server starts it, wherever it runs: the binary, Docker, the npm CLI, or the proxy the pi package starts (which reads the same `proxy-config.json`). The console (`pi-switchboard tui`) ignores it.

Signed in, it shows the proxy's requests as they happen, its logins with their quota and routing order, the models and aliases, the stats over a day, a week or 30 days, and the doctor's findings ([The pages](#the-pages)). An editor also changes what the console changes: the settings, the aliases, and the logins' order, labels and disabling, and ends cooldowns; a viewer only reads ([Changing settings](#changing-settings), [Changing aliases and logins](#changing-aliases-and-logins)).

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

The role is checked again on every request, against the lists the proxy runs with: change a list and restart, and someone taken off it has no session from their next request, while someone moved to the viewers is a viewer. A role a team gave lasts as long as that team is listed; a change in the team's members on GitHub shows at the member's next sign-in, since the proxy asks GitHub about teams only then. A session lasts 8 hours at most. To end every session at once, change the session key and restart. The lists are checked in order: editors by login, editor teams, viewers by login, viewer teams; GitHub is asked about a team only when no login before it decided, and only an active membership counts (a pending invitation doesn't).

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

Then start `pi-switchboard` and open `http://127.0.0.1:4142/admin/`: it offers the GitHub sign-in, and brings you back to the pages.

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
3. When a list names that login or one of its teams, it sets the session cookie (8 hours, path `/admin`, `HttpOnly`, `SameSite=Lax`, `Secure` over `https`), signed with the session key and holding only a random session ID, the login, the role, the team that gave it (if one did) and the expiry.

`POST /admin/auth/sign-out` clears the session cookie and revokes the session: a copy of the cookie stops working too, and stays refused after a restart, and an open live requests view closes within half a second. The revoked session IDs are kept, until they would have expired, in `pi-switchboard-admin-revoked.json` in pi's agent directory (a session ID opens nothing without the signed cookie). When that file can't be written, the session is still refused at once, but sign-out answers `500` and the page says so, since a restart would let it in again until it expires. When the file can't be read or is not one at startup, the proxy logs an error and refuses every session signed in before it started (everyone signs in again), rather than forgetting what was revoked. Sign-in and the callback (not sign-out) allow 20 requests a minute from one address; every response forbids framing, caching and sending a `Referer`; and a request that changes something must carry the admin UI's own `Origin`.

Behind a reverse proxy every request comes from the reverse proxy's address, so everyone shares those 20 a minute. The admin UI doesn't trust `X-Forwarded-For`, which a client can write. Limit per client at the reverse proxy if several people sign in at once.

## The pages

`/admin/` is laid out as the console (`pi-switchboard tui`), in its Tokyo Night Storm colors:

- **The status strip**, on top: the version, where the proxy listens and whether proxy auth is on, the models exposed of those available, cooldowns, uptime, and on the right the last half hour of chat requests with the current rate and what today cost. Under it, the alerts the console gives a row of their own: proxy auth off beyond this machine, an exposure config that can't be applied, a `models.json` that didn't load.
- **The tabs**, numbered; Doctor's carries the count of its errors and warnings, in the color of the worst.
- **The page**, beside **the sidebar**: QUOTA (each login's windows), IN FLIGHT (the chat requests running), RECENT (the last minute and the latest finished) and SESSION (the traffic since the proxy started).
- **The footer**, with the keys, which work as the console's: `1` to `7` pick a tab (the console's six in its order, then Logins), `s` hides or shows the sidebar, and `t`, `w` and `a` pick the window (today, the week, 30 days) that Stats and Doctor share.

The address's `#/accounts` names the tab, so a tab can be bookmarked. The tabs:

| Tab | Shows |
|---|---|
| Requests | Each request, newest first, as it happens: its path, status and time, and for a chat the alias, the model, the attempt and how it ended; the proxy's own events (where it listens, logins added) among them |
| Accounts | Each login, grouped by provider in routing order: its label, whether it is a subscription or an API key, its place in the order, its quota windows and when they reset, a reserve it is below, and its cooldowns; an editor puts a login first, disables or enables it, labels it, and ends cooldowns ([Changing aliases and logins](#changing-aliases-and-logins)) |
| Stats | A day, a week or 30 days: totals, requests and failures over time, each model's numbers, each [project](projects.md)'s spend against its budget for the window, and what failed; an editor sets each project's budget ([Changing budgets](#changing-budgets)) |
| Models | The models a client can name, with their context and reasoning efforts; each alias and what it points at, the built-in `-latest` ones, and why any is left out; an editor adds, edits, renames and deletes the configured aliases |
| Settings | `proxy-config.json`'s settings, grouped as the console's Settings view groups them: each one's saved value, the value running when it differs, a flag or environment variable that holds it, and what it does; an editor changes them here ([Changing settings](#changing-settings)) |
| Doctor | `pi-switchboard doctor`'s findings over the same windows, most serious first |
| Logins | The commands that add a login, in a terminal; this page can't |

The npm package, the Docker image and the standalone binary all carry the pages; the binary has them built in. They load nothing from another site: every script and style comes from the admin listener itself. The console's count of open client connections is the one part of its strip the admin UI leaves out: it needs the API listener's server, which the admin listener doesn't hold.

## Changing settings

On the Settings tab, an editor changes what the console's Settings view changes, and the change is saved to `proxy-config.json` (the path is on the page). A viewer sees the same values without the controls, and the API refuses a viewer's write (`403` `editor_only`).

- **When it applies.** Proxy auth, Models and Routing apply to the next request. Server and Features apply when pi-switchboard restarts: the page says how many saved settings aren't running yet. The admin UI can't restart the proxy; restart the process, or the container.
- **A flag or an environment variable wins.** A setting held by one (`--port`, `PI_SWITCHBOARD_PORT`, …) is marked so: the value saved is used once the flag or variable is gone.
- **What it checks.** Each value is checked as the file is when the proxy loads it: a port out of range, an unknown log level or a reserve above 1 is refused with the reason, and nothing is saved.
- **Listening beyond this machine** with proxy auth off asks first, as the console does: the page asks you to confirm, and only then saves the address.
- **Proxy auth is not changed here.** The page shows whether a token is set, never the token; set or clear it in the console (`p`) or the config file.
- **A config file that can't be read** (bad JSON, a value out of range) is never written over: the page says what is wrong; fix or remove the file first.

Every change is logged at `info` under the category `pi-switchboard.admin.audit`: who made it (the GitHub login), the setting, and its value before and after, as the Settings view shows them (proxy auth as `on` or `off`).

## Changing aliases and logins

An editor changes on the Models and Accounts tabs what the console's Models and Accounts views change. Each change is saved to `proxy-config.json` and used by the next request, with no restart; each is logged under `pi-switchboard.admin.audit` with who made it, and for an alias or a label its value before and after.

- **Aliases** (Models). **+ New alias**, or **Edit** on a configured alias: its name, its targets in order, and the failures that move a request to the next target. A target is an exposed model, or a family that follows its newest exposed model (or one pinned); its effort is one the model runs at, or the request's own. Renaming keeps the alias's place in the file. **Delete** asks first. The built-in `-latest` aliases can't be changed; a configured alias of the same name replaces one.
- **What the proxy checks.** The editor offers only what the console's does, and the API checks the same: a model that isn't exposed, an effort the model doesn't run at, a pin outside its family, or a name that is a model's ID is refused, and nothing is saved.
- **Logins** (Accounts). **Use first** puts a login first among its provider's logins; **Disable** keeps routing from calling it (its credential stays in pi's store), and **Enable** undoes it. Disabling a provider's only enabled login withdraws its models, so it asks first. **Label…** sets the note shown beside a login; an empty label removes it.
- **Cooldowns.** **End cooldowns** on a login ends its cooldowns; **End all cooldowns** ends every one, as the console's `c` and `DELETE /v1/switchboard/cooldowns` do.

Logging in and out stay in a terminal (the Logins tab), and nothing here shows or changes a credential.

## Changing budgets

An editor sets each [project](projects.md)'s budget on the Stats tab, under **Budgets**: an amount in US dollars for any of `today`, `week` and `all`, with an empty field for none. **Save** replaces the project's budget whole, so a field emptied there removes that window's; **Remove** removes the project's budget; the last row adds a project, named as clients send it in `X-Switchboard-Project`. Each change is saved to `budgets` in `proxy-config.json`, shown at once, and logged under `pi-switchboard.admin.audit` with who made it and the budget before and after. Budgets are reported, never enforced.

## The API

Every route under `/admin/api/` needs a session, editor or viewer, and answers `401` `not_signed_in` without one, whatever the path. Every route that writes (`PUT`, `POST`, `DELETE`) is an editor's: a viewer's write is a `403` `editor_only`, and a write without the admin page's `Origin` (from another site) is a `403` too. Each refused write (no session, a viewer's, a foreign `Origin`), and any request for another `Host`, is logged under `pi-switchboard.admin.audit` with the method, the path and why, and the viewer's login when there is one. None calls a provider or resolves a credential, and none returns one: the logins are what `/healthz/creds` shows, the models what `GET /v1/switchboard/models` shows, proxy auth is `on` or `off`, and the requests carry no message content. A write refused for its content answers `{ "error": { "code", "message" } }`; one over a config file that can't be read is a `409` `file_unusable`, and one the file didn't take a `500` `not_written`.

| Route | Answers |
|---|---|
| `GET /admin/api/session` | `{ "login", "role" }` |
| `GET /admin/api/requests` | The requests the proxy keeps in memory, as the console's Requests view lists them: `requests` (HTTP requests, in flight and answered), `active` and `finished` (the chat requests behind them: model, alias, attempt, outcome) and `events` (where it listens, logins added, …) |
| `GET /admin/api/requests/stream` | The same, as server-sent events: an `event: requests` at once, then again at most twice a second while the requests change, with a comment every 15 seconds |
| `GET /admin/api/accounts` | Each login: how pi has it (`type`, `source`, `availableModelCount`), its `label`, its latest `quota`, whether it is `belowReserve`, its `cooldowns`, and its `place` in its provider's routing order |
| `GET /admin/api/models` | The exposed `models` and `aliases` (as `GET /v1/switchboard/models`), the `configured` aliases, the built-in `latest` ones, why any is left out, and the alias editor's `options` (the exposed `models` with the `efforts` each runs at, the `families` with their `members` and `newest`, and the `failures` a fallback may name); `503` `exposure_invalid` when the exposure config can't be applied |
| `GET /admin/api/stats?window=today\|week\|all` | The stats over the window, as `GET /v1/switchboard/usage`; `503` while stats are off |
| `GET /admin/api/doctor?window=today\|week\|all` | The doctor's report on the running proxy, as `pi-switchboard doctor --json`; no login is verified |
| `GET /admin/api/status` | The status strip's and sidebar's data: `version`, `address`, `proxyAuth`, `beyondLoopback`, `uptimeMs`, the `exposed` and `available` models, `modelsJsonError`, `cooldowns`, `perMinute` (chat requests a minute over the last half hour, oldest first) with `saturated`, `todayCostUsd` (`null` while stats are off), and `session`'s route totals since the start |
| `GET /admin/api/settings` | The config file's `path`, a `fileProblem` that stops writes (or `null`), and each setting: `key`, `label`, `section`, `help`, the `saved` and `running` values as shown, the `override` that holds it, when it `applies` (`live` or `restart`), the `value` an editor changes (`null` for proxy auth), and its `input` (`text`, `int` with `min`/`max`, `switch`, `choice`, `many`, `prefixes` or `shares` with their `options`, or `console`); and `pendingRestart`, the count saved but not running |
| `PUT /admin/api/settings/{key}` | Editors only: `{ "value", "confirm"? }` saves one setting and answers as `GET /admin/api/settings`. Refused with `400` `invalid_value` (the reason), `400` `confirm_required` (beyond loopback with proxy auth off; send `"confirm": true`), `400` `console_only` (`authToken`), `403` `editor_only`, `404` `unknown_setting`, `409` `file_unusable`, or `500` `not_written` |
| `PUT /admin/api/aliases/{name}` | `{ "targets": [{ "model", "reasoningEffort"? } \| { "family", "pin"?, "reasoningEffort"? }], "fallbackOn": […], "previousName"? }` saves an alias (renaming `previousName`) and answers as `GET /admin/api/models`. Refused with `400` `invalid_body`, `invalid_name` or `invalid_target` (the reason), or `409` `name_taken` |
| `DELETE /admin/api/aliases/{name}` | Deletes a configured alias and answers as `GET /admin/api/models`; `404` `unknown_alias` |
| `POST /admin/api/logins/{login}/first` | Puts the login first among its provider's logins and answers as `GET /admin/api/accounts`; `404` `unknown_login` |
| `PUT /admin/api/logins/{login}/disabled` | `{ "disabled", "confirm"? }` disables or enables the login and answers as `GET /admin/api/accounts`; `400` `confirm_required` for the provider's only enabled login (send `"confirm": true`), `404` `unknown_login` |
| `PUT /admin/api/logins/{login}/label` | `{ "label" }` sets the login's label, or removes it when empty, and answers as `GET /admin/api/accounts`; `404` `unknown_login` |
| `DELETE /admin/api/cooldowns?provider=&model=` | Ends the cooldowns of a login, of a model, or every one, and answers `{ "ended": […] }`; `404` `unknown_login` or `unknown_model` for a name nothing is known by |
| `GET /admin/api/budgets` | `{ "budgets" }`: each project's budget per window, as `proxy-config.json` holds it |
| `PUT /admin/api/budgets/{project}` | `{ "today"?, "week"?, "all"? }`, each in US dollars above 0, replaces the project's budget (URL-encode the project: it may hold `/`) and answers as `GET /admin/api/budgets`; no window removes it. Refused with `400` `invalid_body` or `invalid_project` |
| `DELETE /admin/api/budgets/{project}` | Removes the project's budget and answers as `GET /admin/api/budgets`; `400` `invalid_project` |

A `window` other than `today`, `week` or `all` is a `400`.
