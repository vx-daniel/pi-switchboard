# Security defaults

- Binds to `127.0.0.1` (localhost only) by default
- Proxy auth is off by default, outside the Docker image (which requires a token). While it is off, any program on this machine and any web page open in a browser on it can use your provider logins through the proxy (cross-origin posts, DNS rebinding), and so can anyone on the network when it listens beyond loopback. The proxy says so at startup, in the console and in `/proxy show`. Set a token, or for web pages turn on the opt-in host/origin guard ([Running without a token](configuration.md#running-without-a-token))
- Remote image URLs rejected unless the remote-images setting is on. When it is on, each fetch:
  - uses `http` or `https` only;
  - refuses a host when any address it resolves to is loopback, private, link-local (including the cloud metadata address `169.254.169.254`), carrier-grade NAT, unspecified, multicast or reserved, IPv4-mapped IPv6 forms included, and connects only to the address it checked (no DNS rebinding);
  - follows at most 3 redirects, checking each target the same way;
  - gives up after 5 seconds connecting or 10 seconds in all;
  - stops reading past 15 MiB (the base64 data URI limit);
  - accepts only an `image/png`, `image/jpeg`, `image/gif` or `image/webp` response;
  - sends a plain GET: no client header, cookie or credential;
  - and a request may carry at most 8 remote images, of 15 MiB in all.

  Images are fetched only after the provider credential is checked, so a request that would get `502` `upstream_credentials_missing` fetches nothing.

  A refused image fails the request with `400` at that part's `param`, with a fixed message that never quotes the remote server.
- Request body size limited to 50 MB by default, chunked uploads included
- Upstream calls aborted after 120 seconds without any data from the provider
- Secrets are never included in error responses
- Client disconnects abort upstream work immediately
