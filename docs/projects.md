# Projects and budgets

A client can name the project a request is for, and the proxy counts its usage apart: requests, failures, tokens and cost per project, in the stats file beside the models and aliases. A project can have a budget in US dollars per stats window. Budgets are reported, never enforced: nothing refuses a request past one.

## Naming a project

Send the `X-Switchboard-Project` header on `POST /v1/chat/completions` or `POST /v1/responses`:

```bash
curl http://localhost:4141/v1/chat/completions \
  -H "Authorization: Bearer $PI_SWITCHBOARD_AUTH_TOKEN" \
  -H "X-Switchboard-Project: vx-daniel/pi-switchboard" \
  -H "Content-Type: application/json" \
  -d '{"model": "opus-latest", "messages": [{"role": "user", "content": "Hello"}]}'
```

- **A label is 1 to 64 characters:** a letter or digit, then letters, digits and `._:/@-`, so `owner/repository` works. Any other value is refused with `400`, naming the header; nothing is cut or cleaned.
- **Only with proxy auth on.** The label is the client's word, so the proxy reads it only while a token is set ([Proxy authentication](configuration.md#proxy-authentication)). Without one, any program that can reach the proxy could charge its traffic to any project: the header is ignored, the request is served and counted under no project, and the log says why once.
- **Without the header** a request counts under no project, as before.
- **The stats cap distinct projects at 50 a minute;** past that, a minute's other projects are counted as `(other)`, so a client can't grow the stats file without limit.

What is kept is the label and the counts: never message content, the request's `user`, or a credential.

## Budgets

`budgets` in `proxy-config.json` sets a project's budget in US dollars for any of the stats windows: `today` (since local midnight), `week` (the last 7 days) and `all` (the 30 days the stats keep).

```json
{
  "budgets": {
    "vx-daniel/pi-switchboard": { "week": 50, "all": 150 },
    "j5": { "today": 10 }
  }
}
```

A budget is read on every request that shows it, so a change shows at once, with no restart. An editor can also set it on the admin UI's Stats tab ([Changing budgets](admin-ui.md#changing-budgets)). An entry with an invalid project label, an amount that isn't a positive number, or a window other than those three is dropped, and the proxy logs the field's name.

Cost is what the [stats](configuration.md#what-the-proxy-adds) price each request at: pi's list prices, `0` where pi has no price. A subscription's real cost is not this.

## Where they show

- **`GET /v1/switchboard/usage`** lists `projects`, most spent first: `project`, `requests`, `failed`, the four token counts, `cost_usd` and `budget_usd` (the budget for the window asked for, or `null`). A project with a budget for the window but no traffic in it is listed at zero ([Usage over HTTP](api.md#usage-over-http)).
- **The console's Stats view** has a PROJECTS panel with each project's requests, failures, cost, budget and the share spent: yellow from 80%, red past the budget ([The console](console.md)).
- **The admin UI's Stats tab** has a Projects table with the same, the share as a bar ([The admin UI](admin-ui.md#the-pages)).
- **`pi-switchboard doctor`** (and the console's and the admin UI's Doctor) has a `budget` check: a warning for a project past its budget in the window, advice from 80% of it. Neither changes the doctor's exit status ([Checking the setup](configuration.md#checking-the-setup-pi-switchboard-doctor)).
