# Several logins per provider

pi stores one credential per provider, so a second subscription to the same service is a second login: `anthropic-2`. Nothing to configure. In the console, press `n`: every provider you are logged in to also offers its next login, `Anthropic 2`. Choose it, and pi's usual login runs for it. Use a different browser profile or a private window, or the sign-in will silently reuse the account you are already in (and nothing can tell two logins to one Anthropic account apart afterwards). After the login, the console asks for a label (`work`, `personal`; Enter skips): it is shown beside the login in the Accounts view and in the login and logout lists, and saved as `labels` in `proxy-config.json`, never in pi's store and never sent anywhere. **Set a label** in an account's menu changes it later; an empty answer removes it.

- **One model, several logins.** `claude-opus-5-5` stays one model on `/v1/models`, owned by `anthropic`, whatever the number of logins; a login is never a model a client can name. The proxy picks the login: the first (`anthropic`), then `anthropic-2`, and so on (or the [order you set](#order-and-disabled-logins)), moving to the next on the failures `routing.logins.fallbackOn` names, a rate limit by default. Only those: with the default, an expired or missing credential on the first login is the answer even when the second is healthy; add `auth` to hand over on it too. The response says which login answered (`x_pi.login`, only when the model has more than one) and lists the logins tried before it in `x_pi.attempts`, each with its `login`; the log names them too. `/v1/switchboard/models` lists each model's `logins` with their cooldowns and quota. An [alias chain](routing.md#fallback-chains) tries each of its models under every login before moving to the next model; a class the alias names but `routing.logins.fallbackOn` does not skips the rest of a model's logins.

  ```json
  { "routing": { "logins": { "fallbackOn": ["rate_limit", "auth"] } } }
  ```

- **Kept apart everywhere else.** Each login has its own credential in pi's `auth.json`, and only that one: an environment key such as `ANTHROPIC_API_KEY` is the first login's, never `anthropic-2`'s; its own [cooldowns](routing.md#cooldowns) (a 429 cools the login; a 503 cools the model under every login), its own [quota](routing.md#quota) and `routing.reserve` entry, its own row in the Accounts view and on `/healthz/creds`, and its own line in the usage totals. A login exists while it has a credential: logging out (`x`) drops it, and the number is offered again. At startup the proxy registers every `{provider}-N` credential pi has stored, so a login survives a restart, and a login made through [pi-rotator](https://pi.dev/packages/pi-rotator) or [pi-multi-account](https://pi.dev/packages/pi-multi-account) (their `anthropic-account-2` form is read too) is served as well. If pi's credential store cannot be listed at startup (unreadable, or slower than 15 seconds), the proxy still starts, with the base providers only, and logs a warning; `/healthz/creds` then shows `loginsRegistered: false`, and the logins stay unregistered until you restart the proxy. pi's own `/login` does not know the login unless one of them registers it.
- **Built-in providers only.** Only pi's built-in providers offer a next login; a `models.json` provider does not, because its key would be copied with it. A provider of your own whose name ends in a number (`local-2`) stays a provider and a model of its own, never a login of `local`; a stored `acme-account-2` credential for a provider pi doesn't build in is left alone with a warning. A `models.json` entry under a login's own ID (`anthropic-2`) applies to it, a `baseUrl` for instance; the base's entry does not.
- **Sent as the base.** Requests go to the provider as the base's would, so provider rules pi keys by name (the `openai` ChatGPT sign-in, `github-copilot`'s headers) hold for every login. Moving between logins loses the provider's prompt cache. Whether several subscriptions may be used this way is between you and the provider.

## Order and disabled logins

By default a provider's logins are tried base first, then `-2`, `-3` by number. To spend a different subscription first, or to keep one out of routing for a while without logging out of it, set the order or disable the login (#233):

```json
{
  "routing": {
    "logins": {
      "order": { "anthropic": ["anthropic-2", "anthropic"] },
      "disabled": ["anthropic-3"]
    }
  }
}
```

- **`routing.logins.order`**: base provider → its logins to try first, in that order. Logins it leaves out follow in the usual order, so `{ "anthropic": ["anthropic-2"] }` is enough to put `anthropic-2` first. A plain model name then goes to `anthropic-2` first: `x_pi.login` says `anthropic-2` and the log names it. An alias's targets follow the same order, and cooldowns, `routing.reserve` and `routing.logins.fallbackOn` work as before, among the logins in this order.
- **`routing.logins.disabled`**: logins routing never calls, not first and not as the fallback after a rate limit. A disabled login stays logged in: pi keeps its credential, and enabling it again needs no login. When every login of a provider is disabled, its models leave `/v1/models` (and `GET /v1/models/{model}` and a request naming one answer 404 `model_not_found`), as if you were logged out.
- **In the console.** In the Accounts view, `Enter` on a login offers **Use first** (writes the order for its provider, that login first and the others in their current order) and **Disable** or **Enable**. Disabling a provider's only enabled login asks first, since its models leave `/v1/models`. The view marks the login called first `▲ first` and dims a disabled one, labelled `disabled`. The change is saved in `proxy-config.json` and used by the next request, with no restart.
- **What it reports.** `/v1/switchboard/models` lists each model's logins in the order routing tries them, then its disabled logins, each with `disabled`. A name that is no login of its provider (a typo, or a login you have since logged out of) is ignored, never an error: `/healthz/models` lists it in `loginDiagnostics` as `unknown-login`, and the log warns once. A provider whose every login is disabled is listed there as `all-logins-disabled`, so its missing models are no mystery. Neither fails the check. An invalid value (a list where a map belongs, a name that is not text) is dropped with a warning, like any other setting.
