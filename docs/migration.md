# Coming from pi-openai-proxy

Version 0.1.0 renamed everything that carried the old name, with no aliases:

| Before | Now |
|---|---|
| package `@vx-daniel/pi-openai-proxy`, command `pi-openai-proxy` | `@vx-daniel/pi-switchboard`, `pi-switchboard` |
| env vars `PI_PROXY_*` (e.g. `PI_PROXY_AUTH_TOKEN`, `PI_PROXY_PORT`) | `PI_SWITCHBOARD_*` (`PI_SWITCHBOARD_AUTH_TOKEN`, `PI_SWITCHBOARD_PORT`, same suffixes) |
| header `X-Pi-Upstream-Api-Key` | `X-Switchboard-Upstream-Api-Key` |
| log categories `pi-openai-proxy.*` | `pi-switchboard.*` |

- **A `PI_PROXY_*` variable that is still set is not read.** The proxy warns about it at startup and names the replacement.
- **An old `PI_PROXY_AUTH_TOKEN` stops the proxy from starting** unless `PI_SWITCHBOARD_AUTH_TOKEN` or `--auth-token` is set. This applies even when it is empty, and even with a token in the config file. Ignoring it would quietly drop the token you meant.
- **A chat completion request with the old header gets a 400** that names the new one. It's checked after proxy auth and only on `/v1/chat/completions`, the one route that reads the key.
- **Unchanged:** `proxy-config.json` in pi's agent directory, the `/proxy` command and `x_pi`.
