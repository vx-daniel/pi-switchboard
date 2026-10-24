#!/bin/sh
# Starts the proxy in the container image (#60), refusing to run without a bearer token.
#
# The image binds 0.0.0.0, so anything that can reach the port can use the pi login in the volume.
# The proxy itself only warns when it binds off-loopback with auth off (docs/configuration.md,
# "Logging"); the image is shared, so it enforces the token here instead of trusting every
# `docker run`. The proxy's own auth semantics are unchanged for everyone else (#60, "Decision
# needed").
set -eu

# Exactly one of these as the only argument prints and exits: the CLI starts no server for them, so
# `docker run --rm <image> --version` needs no token (#168). Anything else goes through the guard.
if [ "$#" -eq 1 ]; then
  case "$1" in
    --version | -v | --help | -h) exec node /app/dist/index.mjs "$1" ;;
  esac
fi

if [ -z "${PI_SWITCHBOARD_AUTH_TOKEN:-}" ]; then
  echo 'pi-switchboard: set PI_SWITCHBOARD_AUTH_TOKEN. This image listens on every interface and' \
    'serves the pi login in its volume, so it does not start without a bearer token.' >&2
  exit 64
fi

exec node /app/dist/index.mjs "$@"
